// AUTOMATIC "WAS IT SENT?" FROM THE SENT MAILBOX (#741, Boss TG 4131/4135).
//
// Boss: "the system should watch the Sent folder of the address I entered as the sender; if the attachment is in there,
// it was sent -- a changed subject must not matter". So a document counts as sent when a message in the Sent mailbox of
// the sender account carries an attachment with the name of one of the document's generated files.
//
// The mail client lives in the e-mail routes; they register a port here (like workbench-maildraft.ts does), so this
// module stays free of the mail client. Best effort and silent: a mail server that does not answer leaves the document
// "not sent", exactly as before -- the owner can still mark it by hand.
//
// #750: the sending goes on the final whose file the mail CARRIED (a document can have several finals; the newest one is
// not necessarily the one that was attached). A mail that only matches a name of the stored mail draft cannot say which
// final it was, so it gets the plain by-hand mark and no version.

import { basename } from 'node:path'
import { getDb } from './db.js'
import { listFinals, finalState } from './workbench-docfinal.js'
import { markSentManually, recordSent, registerHandProofWriter, sentStatus, sentVersionIds } from './workbench-docsent.js'
import { writeEmailProof } from './workbench-email-proof.js'
import { logger } from './logger.js'
import './workbench-sent-context.js'
import { getWorkItem } from './workbench.js'

export interface SentMailInfo { id: string; date: string; to: string; messageId: string; attachments: string[]; from?: string; subject?: string; /** The Sent mailbox the message lies in (for reading its text). */ mailbox?: string; /** The text of the mail, read only for the one mail that was found. */ body?: string }
export interface SentMailPort {
  /** The ids of the mail accounts that can be looked into. */
  accounts(): string[]
  /** The newest messages of the account's Sent mailbox that carry attachments (names read), newest first. */
  recent(account: string, limit: number, sinceMs: number): Promise<SentMailInfo[]>
  /** The text (body) of one message of the account's Sent mailbox; '' when it cannot be read. */
  body?(account: string, mailbox: string, id: string): Promise<string>
}
let port: SentMailPort | null = null
export function registerSentMailPort(p: SentMailPort): void { port = p }

const MAX_MESSAGES = 8
/** A look that found nothing is not repeated for a minute: the move list is opened again and again. */
const MISS_TTL_MS = 60_000
const misses = new Map<string, number>()

/** A file name compared the way a person would: case, spaces and a " (2)" copy mark anywhere ("X (2) - végleges.pdf") do not matter. */
export function normName(n: string): string {
  return basename(String(n || '')).toLowerCase().normalize('NFC').replace(/\s*\(\d+\)/g, '').replace(/\s+/g, ' ').trim()
}

/** A final of the document and the names of the files it made (the final PDF and its parts). */
export interface FinalNames { version_id: string; created_at: number; names: Set<string> }

/** The names of the files each final made, and every attachment of the stored mail draft (which belongs to no one final). */
export function sentCandidateNames(itemId: string): { finals: FinalNames[]; draftNames: Set<string>; since: number; account: string } {
  const finals: FinalNames[] = []
  const draftNames = new Set<string>()
  let since = 0
  for (const f of listFinals(itemId)) {
    const names = new Set<string>()
    for (const n of [f.pdf_name, basename(f.pdf_path || ''), ...(f.files || []).flatMap((x) => [x.name, basename(x.path || '')])]) if (n) names.add(normName(n))
    finals.push({ version_id: f.version_id, created_at: f.created_at, names })
    since = since ? Math.min(since, f.created_at) : f.created_at
  }
  let account = ''
  try {
    const row = getDb().prepare('SELECT from_account AS a, attachments_json AS j, updated_at AS u FROM wb_doc_maildraft WHERE work_item_id = ?').get(itemId) as { a: string; j: string; u: number } | undefined
    if (row) {
      account = row.a || ''
      try { for (const a of JSON.parse(row.j || '[]') as { name?: string }[]) if (a?.name) draftNames.add(normName(a.name)) } catch { /* bad JSON: no draft names */ }
    }
  } catch { /* the draft table does not exist yet: no draft */ }
  return { finals, draftNames, since, account }
}

/** The mail date and a final's creation come from the same machine: a few minutes of slack, not a day. */
const CLOCK_SLACK_S = 600

/**
 * The finals whose files a mail carried. A file name that only ONE final made names that final for certain. A name that
 * several finals made (a reused file, an annex shared by all of them) cannot be told apart by the name: it adds nothing
 * when a certain final already carries it, else the newest final that already existed when the mail went out (a final
 * made later cannot be in it), else the oldest.
 */
export function finalsCarriedBy(finals: FinalNames[], attachments: string[], mailDate: string): string[] {
  const t = Date.parse(mailDate)
  const out = new Set<string>()
  const groups = [...new Set(attachments.map(normName))]
    .map((a) => finals.filter((f) => f.names.has(a)).sort((x, y) => x.created_at - y.created_at))
    .filter((g) => g.length)
  for (const g of groups) if (g.length === 1) out.add(g[0].version_id)
  for (const g of groups) {
    if (g.length === 1 || g.some((f) => out.has(f.version_id))) continue
    const before = Number.isFinite(t) ? [...g].reverse().find((f) => f.created_at <= t / 1000 + CLOCK_SLACK_S) : undefined
    out.add((before ?? g[0]).version_id)
  }
  return [...out]
}

/**
 * For each given document that is not marked sent yet: look into the Sent mailbox (the draft's sender account, else every
 * account) and record the sending of every final whose file a mail carried. Returns the ids that were found sent.
 */
export async function detectSentByMail(itemIds: string[]): Promise<string[]> {
  if (!port) return []
  const found: string[] = []
  for (const id of itemIds) {
    if (!id || sentStatus(id).sent) continue
    const { finals, draftNames, since, account } = sentCandidateNames(id)
    const names = new Set<string>([...draftNames, ...finals.flatMap((f) => [...f.names])])
    if (!names.size) continue
    if ((misses.get(id) || 0) > Date.now()) continue
    const accounts = account ? [account] : port.accounts()
    const hits: { info: SentMailInfo; account: string }[] = []
    for (const acc of accounts) {
      let msgs: SentMailInfo[] = []
      try { msgs = await port.recent(acc, MAX_MESSAGES, since ? (since - 86_400) * 1000 : 0) } catch { continue }
      for (const m of msgs) {
        // A mail older than the first finalisation cannot be this document's sending (one day of slack for clock skew).
        const t = Date.parse(m.date)
        if (since && Number.isFinite(t) && t / 1000 < since - 86_400) continue
        if (m.attachments.some((a) => names.has(normName(a)))) hits.push({ info: m, account: acc })
      }
    }
    if (!hits.length) { misses.set(id, Date.now() + MISS_TTL_MS); continue }
    const item = getWorkItem(id)
    // The sendings found, the newest mail first; a final that was sent in several mails is recorded once.
    const done = sentVersionIds(id)
    let ok = false
    for (const hit of hits) {
      // The text of the mail goes into the proof too (read only for a mail that is really recorded).
      if (port.body && hit.info.mailbox && !hit.info.body) { try { hit.info.body = await port.body(hit.account, hit.info.mailbox, hit.info.id) } catch { /* no text */ } }
      const day = /^\d{4}-\d{2}-\d{2}/.exec(hit.info.date)?.[0] || new Date().toISOString().slice(0, 10)
      const to = hit.info.to || hit.account
      for (const versionId of finalsCarriedBy(finals, hit.info.attachments, hit.info.date)) {
        if (!item || done.has(versionId)) continue
        if (recordSent(item, { date: day, recipient: to, method: 'email', reference: hit.info.messageId, note: 'found in the Sent mailbox', mail: { from: hit.info.from, subject: hit.info.subject, body: hit.info.body, attachments: hit.info.attachments } }, 'sent-mailbox', versionId).ok) { done.add(versionId); ok = true }
      }
    }
    // No final to hang the sending on (the mail carried a draft attachment only, or an old document): the same honest
    // mark the owner would click -- it claims no version.
    if (!ok) { markSentManually(id, 'sent-mailbox'); ok = true }
    if (ok) found.push(id)
  }
  return found
}

// ---- THE OWNER'S "SENT BY E-MAIL" CLICK LOOKS INTO THE MAILBOXES (Boss, 2026-11-20) ----------------------------------------
// "When the user presses the button, the system must start an investigation by itself and look into the e-mails, not write
// that it did not look! If there is a subject, a mail body, a sender, write them into the txt too." So the hand mark does not
// stop at "the owner said so": the Sent mailboxes are searched for the mail (by the attachment names of the finals and of the
// stored draft, else by the recipient address), and the proof gets the sender, recipient, subject, attachments, Message-ID and
// the TEXT of the mail. Only when the mail is really not there (looked three times, the mail may take a moment to land in
// Sent) the proof says so, naming the accounts that were searched.

/** How far back a Sent mailbox is searched when no final tells the first date (days). */
const HAND_LOOKBACK_DAYS = 30
/** Messages looked at per account for a hand mark. */
const HAND_MESSAGES = 25

/** The mail addresses in a free text (the recipient the owner typed may be a name only). */
export function addressesIn(text: string): string[] {
  return [...new Set((String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((a) => a.toLowerCase()))]
}

/**
 * The mail of the Sent messages that is the one the owner means: it carries a file with one of the document's names; failing
 * that, it went to an address the owner typed. The newest such mail, within two days of the day the owner gave.
 */
export function pickSentMail(msgs: SentMailInfo[], names: Set<string>, hint: { recipient?: string; date?: string }): SentMailInfo | null {
  const want = addressesIn(hint.recipient || '')
  const day = hint.date ? Date.parse(hint.date + 'T12:00:00Z') : NaN
  const near = (m: SentMailInfo): boolean => {
    if (!Number.isFinite(day)) return true
    const t = Date.parse(m.date)
    return !Number.isFinite(t) || Math.abs(t - day) <= 2 * 86_400_000
  }
  const byFile = (m: SentMailInfo): boolean => !!names.size && m.attachments.some((a) => names.has(normName(a)))
  const byTo = (m: SentMailInfo): boolean => want.length > 0 && addressesIn(m.to).some((a) => want.includes(a))
  const newest = (a: SentMailInfo, b: SentMailInfo): number => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
  const files = msgs.filter(byFile).sort(newest)
  if (files.length) return files[0] as SentMailInfo
  const tos = msgs.filter((m) => byTo(m) && near(m)).sort(newest)
  return tos.length ? (tos[0] as SentMailInfo) : null
}

/** One search of the Sent mailboxes for an item's mail: the draft's account first, then every other account. */
export async function findSentMail(itemId: string, hint: { recipient?: string; date?: string }): Promise<{ info: SentMailInfo | null; account: string; searched: string[] }> {
  const searched: string[] = []
  if (!port) return { info: null, account: '', searched }
  const { finals, draftNames, since, account } = sentCandidateNames(itemId)
  const names = new Set<string>([...draftNames, ...finals.flatMap((f) => [...f.names])])
  const all = port.accounts()
  const order = account ? [account, ...all.filter((a) => a !== account)] : all
  const floor = Date.now() - HAND_LOOKBACK_DAYS * 86_400_000
  const sinceMs = since ? Math.min((since - 86_400) * 1000, floor) : floor
  for (const acc of order) {
    let msgs: SentMailInfo[] = []
    try { msgs = await port.recent(acc, HAND_MESSAGES, sinceMs) } catch { continue }
    searched.push(acc)
    const hit = pickSentMail(msgs, names, hint)
    if (hit) {
      let body = ''
      if (port.body && hit.mailbox) { try { body = await port.body(acc, hit.mailbox, hit.id) } catch { /* the text stays empty */ } }
      return { info: { ...hit, body }, account: acc, searched }
    }
  }
  return { info: null, account: '', searched }
}

const HAND_RETRY_MS = [0, 20_000, 60_000]
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The proof for the owner's "sent by e-mail" click: look into the mailboxes (three times), write what was found. */
async function writeHandMarkProof(itemId: string, date: string, recipient: string): Promise<void> {
  const item = getWorkItem(itemId)
  if (!item) return
  let searched: string[] = []
  for (const wait of port ? HAND_RETRY_MS : [0]) {
    if (wait) await sleep(wait)
    const r = await findSentMail(itemId, { recipient, date })
    searched = r.searched
    if (r.info) {
      const m = r.info
      const day = /^\d{4}-\d{2}-\d{2}/.exec(m.date)?.[0] || date
      const time = /(\d{2}:\d{2})/.exec(m.date.replace(/^\d{4}-\d{2}-\d{2}/, ''))?.[1]
      writeEmailProof(item, { date: day, time, to: m.to || recipient, from: m.from, subject: m.subject, attachments: m.attachments, messageId: m.messageId || undefined, body: m.body })
      return
    }
  }
  writeEmailProof(item, { date, to: recipient, byHand: true, searched })
}
registerHandProofWriter((itemId, date, recipient) => {
  // No mail client or no mail account in this process: nothing can be searched, so the plain by-hand proof is written at once.
  if (!port || !port.accounts().length) { const item = getWorkItem(itemId); if (item) writeEmailProof(item, { date, to: recipient, byHand: true }); return }
  void writeHandMarkProof(itemId, date, recipient).catch((e) => logger.warn({ err: e instanceof Error ? e.message : String(e), item: itemId }, 'e-mail proof for the hand mark failed'))
})
