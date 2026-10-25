// #797: ONE road for every mail the app sends or saves as a draft. Before, the Iroda mailbox (himalaya compose, in
// routes/email.ts), the Workbench export's "Send" (scripts/gmail-send.py, only from the Google default account), the
// document's mail draft (the Drafts folder, workbench-maildraft.ts) and the password-recovery code each had their own
// sender, so the owner saw different accounts at every send and a fix reached only one of them. Every sender goes through
// here now; a source test (mail-send-one-road.test.ts) keeps new direct senders out.
//
// Two engines, chosen by the account:
// - a MAILBOX account (an Iroda IMAP/SMTP account, sent with himalaya). The mail routes register the engine
//   (registerMailboxEngine), because the himalaya client and its folder lookups live there; this module stays a leaf.
// - the GOOGLE account connected on the Accounts page (Gmail API, scripts/gmail-send.py), for an install with no
//   mailbox account. When the same address is also a mailbox account, only the mailbox one is offered (its copy lands in
//   the Sent folder the Iroda shows).
//
// Not here, on purpose: the agents' own command-line senders (scripts/graph-mail.ts for M365, scripts/support-mail/send.py,
// scripts/gmail-send.py called by whatsapp-send.py) -- they run outside the app, as an agent's tool.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from './config.js'
import { logger } from './logger.js'

export interface OutgoingMail {
  to: string
  cc?: string
  subject: string
  body: string
  /** Absolute paths of the files to attach. */
  attachments?: string[]
}

export type MailAccountKind = 'mailbox' | 'google'
export interface SendingAccount { id: string; address: string; kind: MailAccountKind }

export type MailSendResult =
  | { ok: true; account: string; kind: MailAccountKind; address: string; mailbox?: string; messageId?: string }
  | { ok: false; code: 'unknown_account' | 'send_failed'; detail: string }

/** The id of the Google account on the account list (a mailbox account id is its name in the himalaya config). */
export const GOOGLE_ACCOUNT_ID = 'google'

// ---- the mailbox engine (registered by the mail routes) --------------------------------------------------

export interface MailboxEngine {
  accounts(): { id: string; address: string }[]
  /** Runs one himalaya command ONCE: a send is never retried (a retry could send it twice). */
  run(args: string[]): Promise<{ ok: boolean; detail: string }>
  /** The account's own Sent folder. */
  sentFolder(account: string): Promise<string>
  /** A message was added to `folder`: drop the cached list. */
  changed(account: string, folder: string): void
  /** Into the Drafts folder, with the folder lookup's and the transient error's retry (email-draft-save.ts). */
  saveDraft(account: string, mail: OutgoingMail): Promise<{ ok: boolean; mailbox?: string; detail?: string }>
}

let mailbox: MailboxEngine | null = null
export function registerMailboxEngine(e: MailboxEngine | null): void { mailbox = e }

/** The arguments of one `himalaya message compose`: sent and/or saved into a folder. The ONLY place they are built. */
export function composeArgs(account: string, from: string, mail: OutgoingMail, opts: { send: boolean; saveTo: string }): string[] {
  const args = ['-a', account, 'message', 'compose', '--from', from]
  if (mail.to.trim()) args.push('-t', mail.to.trim())
  if (mail.cc?.trim()) args.push('--cc', mail.cc.trim())
  if (mail.subject.trim()) args.push('-s', mail.subject.trim())
  args.push('--body', mail.body.trim() ? mail.body : '\n')
  if (opts.send) args.push('--send')
  args.push('--save', opts.saveTo)
  for (const f of mail.attachments || []) args.push('--attach', f)
  return args
}

// ---- the Google engine (scripts/gmail-send.py) ---------------------------------------------------------

export type GoogleRunner = (mode: 'send' | 'draft', mail: OutgoingMail, accountKey: string) => Promise<{ ok: true; id: string } | { ok: false; detail: string }>

/**
 * The connected Google account the Gmail sender would use: the same store scripts/gmail-send.py reads
 * (store/google-tokens.json, the `_default` or MARVEEN_GOOGLE_ACCOUNT one, with a refresh token; on an old install
 * store/google-token.json), and the app's own OAuth client. Null on a fresh install.
 */
export function googleAccount(): { key: string; address: string } | null {
  const store = process.env['MARVEEN_STORE'] || STORE_DIR
  if (!existsSync(join(store, 'google-oauth-client.json'))) return null
  const tokens = join(store, 'google-tokens.json')
  if (existsSync(tokens)) {
    try {
      const t = JSON.parse(readFileSync(tokens, 'utf-8')) as Record<string, unknown>
      const key = process.env['MARVEEN_GOOGLE_ACCOUNT'] || t['_default']
      const rec = typeof key === 'string' ? t[key] as Record<string, unknown> | undefined : undefined
      if (!rec || !rec['refresh_token']) return null
      return { key: key as string, address: typeof rec['email'] === 'string' ? rec['email'] : (key as string) }
    } catch {
      return null
    }
  }
  return existsSync(join(store, 'google-token.json')) ? { key: '', address: '' } : null
}

const realGoogleRunner: GoogleRunner = (mode, mail, accountKey) => {
  const script = join(PROJECT_ROOT, 'scripts', 'gmail-send.py')
  return new Promise((resolve) => {
    execFile('python3', [script, mode, mail.to, mail.subject, ...(mail.attachments || [])], {
      timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, MAIL_BODY: mail.body, MAIL_CC: mail.cc || '', ...(accountKey ? { MARVEEN_GOOGLE_ACCOUNT: accountKey } : {}) },
    }, (err, stdout, stderr) => {
      const id = /(?:SENT|DRAFT) OK id=(\S+)/.exec(String(stdout))?.[1]
      if (!err && id && id !== '?') return resolve({ ok: true, id })
      const why = String(stderr || '').trim().split('\n').filter(Boolean).pop() || (err ? err.message : 'no message id in the sender output')
      resolve({ ok: false, detail: why.slice(0, 500) })
    })
  })
}
let googleRunner: GoogleRunner = realGoogleRunner
let googleProbe: () => { key: string; address: string } | null = googleAccount
/** Tests only: replace the Gmail sender and the account probe (no real mail). `null` restores them. */
export function _setGoogleEngine(runner: GoogleRunner | null, probe?: (() => { key: string; address: string } | null) | null): void {
  googleRunner = runner || realGoogleRunner
  googleProbe = probe || googleAccount
}

// ---- the account list and the two calls ------------------------------------------------------------------

/** Every account a mail can go out from, the same list at every send: the mailbox accounts, then the Google one. */
export function sendingAccounts(): SendingAccount[] {
  const out: SendingAccount[] = []
  for (const a of mailbox ? mailbox.accounts() : []) out.push({ id: a.id, address: a.address, kind: 'mailbox' })
  const g = googleProbe()
  if (g && !out.some((a) => g.address && a.address.toLowerCase() === g.address.toLowerCase())) out.push({ id: GOOGLE_ACCOUNT_ID, address: g.address, kind: 'google' })
  return out
}

function findAccount(id: string): SendingAccount | null {
  return sendingAccounts().find((a) => a.id === id) || null
}

function logSent(what: 'sent' | 'draft saved', acc: SendingAccount, mail: OutgoingMail, where: string): void {
  logger.info({ account: acc.id, kind: acc.kind, to: mail.to, cc: mail.cc || undefined, subject: mail.subject, attachments: (mail.attachments || []).length, where }, `mail-send: ${what}`)
}

/** Sends one mail from `accountId`; a mailbox account also keeps a copy in its Sent folder. */
export async function sendMail(accountId: string, mail: OutgoingMail): Promise<MailSendResult> {
  const acc = findAccount(accountId)
  if (!acc) return { ok: false, code: 'unknown_account', detail: `no sending account "${accountId}"` }
  if (acc.kind === 'google') {
    const r = await googleRunner('send', mail, googleProbe()?.key || '')
    if (!r.ok) { logger.warn({ account: acc.id, detail: r.detail }, 'mail-send: send failed'); return { ok: false, code: 'send_failed', detail: r.detail } }
    logSent('sent', acc, mail, 'gmail')
    return { ok: true, account: acc.id, kind: acc.kind, address: acc.address, messageId: r.id }
  }
  const engine = mailbox as MailboxEngine
  let sent = ''
  try { sent = await engine.sentFolder(acc.id) } catch { sent = '' }
  if (!sent) return { ok: false, code: 'send_failed', detail: 'the Sent folder of the account could not be found' }
  const r = await engine.run(composeArgs(acc.id, acc.address, mail, { send: true, saveTo: sent }))
  if (!r.ok) { logger.warn({ account: acc.id, detail: r.detail }, 'mail-send: send failed'); return { ok: false, code: 'send_failed', detail: r.detail } }
  engine.changed(acc.id, sent)
  logSent('sent', acc, mail, sent)
  return { ok: true, account: acc.id, kind: acc.kind, address: acc.address, mailbox: sent }
}

/** Saves one mail as a draft of `accountId` (nothing goes out): the account's Drafts folder, or a Gmail draft. */
export async function saveDraft(accountId: string, mail: OutgoingMail): Promise<MailSendResult> {
  const acc = findAccount(accountId)
  if (!acc) return { ok: false, code: 'unknown_account', detail: `no sending account "${accountId}"` }
  if (acc.kind === 'google') {
    const r = await googleRunner('draft', mail, googleProbe()?.key || '')
    if (!r.ok) return { ok: false, code: 'send_failed', detail: r.detail }
    logSent('draft saved', acc, mail, 'gmail drafts')
    return { ok: true, account: acc.id, kind: acc.kind, address: acc.address, mailbox: 'Gmail', messageId: r.id }
  }
  const r = await (mailbox as MailboxEngine).saveDraft(acc.id, mail)
  if (!r.ok) return { ok: false, code: 'send_failed', detail: r.detail || 'the draft could not be saved' }
  logSent('draft saved', acc, mail, r.mailbox || '')
  return { ok: true, account: acc.id, kind: acc.kind, address: acc.address, mailbox: r.mailbox || '' }
}

/** A reply to / a forward of a message in a mailbox account: the same engine (the source message gives the headers). */
export async function replyOrForward(accountId: string, how: 'reply' | 'forward', src: { mailbox: string; id: string }, mail: { to?: string; body: string }): Promise<MailSendResult> {
  const acc = findAccount(accountId)
  if (!acc || acc.kind !== 'mailbox') return { ok: false, code: 'unknown_account', detail: `no mailbox account "${accountId}"` }
  const args = ['-a', acc.id, 'message', how, src.id, '-m', src.mailbox, '--from', acc.address]
  if (how === 'forward' && mail.to) args.push('-t', mail.to.trim())
  args.push('--body', mail.body, '--send')
  const r = await (mailbox as MailboxEngine).run(args)
  if (!r.ok) { logger.warn({ account: acc.id, detail: r.detail }, `mail-send: ${how} failed`); return { ok: false, code: 'send_failed', detail: r.detail } }
  logSent('sent', acc, { to: mail.to || '(reply)', subject: `(${how})`, body: mail.body }, src.mailbox)
  return { ok: true, account: acc.id, kind: acc.kind, address: acc.address }
}
