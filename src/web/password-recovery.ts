// Forgotten password -> one-time code on the owner's verified channel (#412).
//
// The login screen used to offer only the access token (phone QR, the token
// file, the server log) or a terminal command. For a non-technical owner on a
// phone that is a locked door. This module adds the ordinary way back: ask for
// a code, receive it where only the owner reads, type it, set a new password.
//
// What "verified channel" means here -- and why nothing else qualifies:
//   - telegram: the install's OWNER chat (the same one security alerts go to).
//     The dashboard sends it itself over the Bot API; no agent session needed.
//   - email: a mailbox the signed-in user CONNECTED in Iroda -> Settings (its
//     IMAP/SMTP password proves it is theirs) and then CHOSE as the recovery
//     mailbox. The code is sent from that mailbox to its own address. An
//     address typed into a form is never used: that would let whoever typed it
//     receive the code.
// A new channel is one more entry in CHANNELS below.
//
// Security properties (each one is tested in password-recovery.test.ts):
//   - the request answer never says whether the username exists (same body,
//     and the send is not awaited, so the timing does not tell either);
//   - rate limits per client and per username (1/min, 5/hour) plus a global
//     cap, so the endpoint cannot be used to flood the owner's chat;
//   - the code is 6 digits, lives 10 minutes, is stored only as a salted
//     hash, is single-use, and dies after 5 wrong tries; a new request
//     replaces the old code;
//   - a correct code does NOT sign in by itself: it yields a short-lived reset
//     ticket that is only good for setting a new password. The session is
//     created together with the new password, and every other session of the
//     user is revoked -- there is no path in which the old password survives
//     a successful recovery;
//   - a wrong code is 400, never 401: the dashboard's fetch wrapper treats any
//     /api 401 as "signed out" (#410).

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { getDb, getDashboardUser, logConfigChange, type DashboardUser } from '../db.js'
import { ownerChannelReady, sendOwnerChannelChecked } from '../notify.js'
import { logger } from '../logger.js'

export const CODE_TTL_MS = 10 * 60 * 1000
export const CODE_MAX_ATTEMPTS = 5
export const TICKET_TTL_MS = 10 * 60 * 1000
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
export const RATE_PER_MINUTE = 1
export const RATE_PER_HOUR = 5
export const RATE_GLOBAL_PER_HOUR = 30
/** Wrong codes per client per hour, across usernames (guessing sweep). */
export const VERIFY_FAILS_PER_HOUR = 20

export type RecoveryChannelId = 'telegram' | 'email'
export type Lang = 'hu' | 'en'

// ---------------------------------------------------------------------------
// Mail sending is injected: the himalaya plumbing lives in routes/email.ts and
// importing that route module here would drag the whole mail stack into auth.
// server.ts / the email route registers the real implementation at load time.

export interface MailPort {
  accounts(): { id: string; address: string }[]
  send(accountId: string, subject: string, text: string): Promise<{ ok: true } | { ok: false; detail: string }>
}

let mailPort: MailPort | null = null
export function registerRecoveryMailPort(port: MailPort | null): void { mailPort = port }

type TelegramSend = (text: string) => Promise<'sent' | 'no_channel'>
// Wrapped, not bound: the notify binding is read at call time, so a test that
// mocks notify.js without these two exports still loads this module.
const defaultSend: TelegramSend = (text) => sendOwnerChannelChecked(text)
const defaultReady = (): boolean => ownerChannelReady()
let telegramSend: TelegramSend = defaultSend
let telegramReady: () => boolean = defaultReady
export function _setRecoveryDeps(d: { telegramSend?: TelegramSend; telegramReady?: () => boolean; mail?: MailPort | null } = {}): void {
  telegramSend = d.telegramSend ?? defaultSend
  telegramReady = d.telegramReady ?? defaultReady
  if ('mail' in d) mailPort = d.mail ?? null
}

/**
 * A browser login may only be created once the owner's Telegram channel
 * demonstrably delivers (owner, 2026-09-26, TG 6617): the forgotten-password
 * code goes there, and a password with no way back locks the owner out. So
 * "connected" is proven by a real test message, not by the config being set.
 */
export async function probeOwnerChannel(username: string, lang: Lang): Promise<{ ok: true } | { ok: false; reason: 'no_channel' | 'send_failed'; detail?: string }> {
  const text = lang === 'en'
    ? `Marveen: a browser sign-in is being set up for "${username}". If you ever forget its password, the one-time code will arrive here, in this chat.`
    : `Marveen: böngészős belépés készül ehhez a felhasználóhoz: "${username}". Ha egyszer elfelejted a jelszavát, az egyszer használható kód ide, ebbe a beszélgetésbe érkezik.`
  try {
    const r = await telegramSend(text)
    return r === 'sent' ? { ok: true } : { ok: false, reason: 'no_channel' }
  } catch (err) {
    return { ok: false, reason: 'send_failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Storage. Own tables (created on first use) so the core schema stays as is.

let tablesReady: unknown = null
function ensureTables(): void {
  const db = getDb()
  if (tablesReady === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_recovery_codes (
      user_id INTEGER PRIMARY KEY,
      salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      channel TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_recovery_settings (
      user_id INTEGER PRIMARY KEY,
      email_account TEXT,
      updated_at INTEGER NOT NULL
    )
  `)
  tablesReady = db
}

function hashCode(salt: string, code: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex')
}

/** The mail account the user chose as their recovery mailbox, if it still exists. */
export function recoveryMailbox(userId: number): { id: string; address: string } | null {
  ensureTables()
  const row = getDb().prepare('SELECT email_account FROM password_recovery_settings WHERE user_id = ?').get(userId) as { email_account: string | null } | undefined
  if (!row?.email_account || !mailPort) return null
  return mailPort.accounts().find((a) => a.id === row.email_account) ?? null
}

export function recoverySettings(userId: number): {
  telegram_ready: boolean
  email_accounts: { id: string; address: string }[]
  email_account: string | null
  email_account_missing: boolean
} {
  ensureTables()
  const row = getDb().prepare('SELECT email_account FROM password_recovery_settings WHERE user_id = ?').get(userId) as { email_account: string | null } | undefined
  const accounts = mailPort ? mailPort.accounts() : []
  const chosen = row?.email_account ?? null
  return {
    telegram_ready: telegramReady(),
    email_accounts: accounts,
    email_account: chosen && accounts.some((a) => a.id === chosen) ? chosen : null,
    // Chosen once, then removed in Iroda -> Settings: say so instead of
    // silently looking unset.
    email_account_missing: !!chosen && !accounts.some((a) => a.id === chosen),
  }
}

export function setRecoveryMailbox(userId: number, accountId: string | null): 'ok' | 'unknown_account' {
  ensureTables()
  if (accountId && !(mailPort?.accounts() ?? []).some((a) => a.id === accountId)) return 'unknown_account'
  getDb().prepare(`
    INSERT INTO password_recovery_settings (user_id, email_account, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET email_account = excluded.email_account, updated_at = excluded.updated_at
  `).run(userId, accountId, Math.floor(Date.now() / 1000))
  return 'ok'
}

// ---------------------------------------------------------------------------
// Channels. Availability is INSTALL-level on purpose: the list is shown before
// sign-in, so it must not depend on (and thereby reveal) which usernames exist.

interface Channel {
  id: RecoveryChannelId
  available(): boolean
  send(user: DashboardUser, text: string, subject: string): Promise<boolean>
}

const CHANNELS: Channel[] = [
  {
    id: 'telegram',
    available: () => telegramReady(),
    send: async (_user, text) => (await telegramSend(text)) === 'sent',
  },
  {
    id: 'email',
    available: () => {
      if (!mailPort) return false
      ensureTables()
      const ids = new Set(mailPort.accounts().map((a) => a.id))
      if (!ids.size) return false
      const rows = getDb().prepare('SELECT email_account FROM password_recovery_settings WHERE email_account IS NOT NULL').all() as { email_account: string }[]
      return rows.some((r) => ids.has(r.email_account))
    },
    send: async (user, text, subject) => {
      const box = recoveryMailbox(user.id)
      if (!box || !mailPort) return false
      const r = await mailPort.send(box.id, subject, text)
      if (!r.ok) logger.warn({ detail: r.detail }, 'password recovery: e-mail send failed')
      return r.ok
    },
  },
]

export function recoveryChannels(): { id: RecoveryChannelId; available: boolean }[] {
  return CHANNELS.map((c) => {
    let available = false
    try { available = c.available() } catch { available = false }
    return { id: c.id, available }
  })
}

// ---------------------------------------------------------------------------
// Rate limiting (in memory: a restart clears it, which only ever loosens it
// for one hour; codes themselves live in the DB and keep their own limits).

const hits = new Map<string, number[]>()
let globalHits: number[] = []
const verifyFails = new Map<string, number[]>()

function recent(list: number[] | undefined, now: number, window: number): number[] {
  return (list ?? []).filter((t) => t > now - window)
}

export function _resetRecoveryState(): void {
  hits.clear()
  globalHits = []
  verifyFails.clear()
  tickets.clear()
}

/** Seconds to wait, or 0 when this request may go ahead (and is then counted). */
function takeRequestSlot(keys: string[], now: number): number {
  let wait = 0
  for (const k of keys) {
    const h = recent(hits.get(k), now, HOUR)
    const lastMin = h.filter((t) => t > now - MINUTE)
    if (lastMin.length >= RATE_PER_MINUTE) wait = Math.max(wait, Math.ceil((lastMin[0]! + MINUTE - now) / 1000))
    if (h.length >= RATE_PER_HOUR) wait = Math.max(wait, Math.ceil((h[0]! + HOUR - now) / 1000))
  }
  globalHits = recent(globalHits, now, HOUR)
  if (globalHits.length >= RATE_GLOBAL_PER_HOUR) wait = Math.max(wait, Math.ceil((globalHits[0]! + HOUR - now) / 1000))
  if (wait > 0) return wait
  for (const k of keys) hits.set(k, [...recent(hits.get(k), now, HOUR), now])
  globalHits.push(now)
  return 0
}

// ---------------------------------------------------------------------------
// Messages that leave the install. Plain text; the owner reads them on a phone.

const MSG = {
  hu: {
    subject: 'Marveen: belépési kód',
    body: (code: string, user: string, min: number) =>
      `Marveen jelszó-visszaállítás\n\nA kódod: ${code}\n\nFelhasználó: ${user}. A kód ${min} percig érvényes, és egyszer használható.\n\nHa nem te kérted, ne add meg senkinek, és szólj: valaki a belépési oldalon a te nevedre kért kódot. A jelszavad addig nem változik, amíg a kódot be nem írják.`,
    done: (user: string, ch: string) =>
      `🔑 Marveen: "${user}" jelszavát most állították át egy ${ch} kapott kóddal. Minden más bejelentkezés kilépett. Ha nem te voltál, azonnal szólj.`,
    via: { telegram: 'Telegramon', email: 'e-mailben' } as Record<RecoveryChannelId, string>,
  },
  en: {
    subject: 'Marveen: sign-in code',
    body: (code: string, user: string, min: number) =>
      `Marveen password reset\n\nYour code: ${code}\n\nUser: ${user}. The code is valid for ${min} minutes and works once.\n\nIf you did not ask for it, do not share it and tell someone: a code was requested for your name on the sign-in page. Your password does not change unless the code is typed in.`,
    done: (user: string, ch: string) =>
      `🔑 Marveen: the password of "${user}" was just reset with a code sent ${ch}. Every other sign-in was signed out. If this was not you, act now.`,
    via: { telegram: 'on Telegram', email: 'by e-mail' } as Record<RecoveryChannelId, string>,
  },
}

// ---------------------------------------------------------------------------
// The three steps.

export type RequestResult =
  | { status: 'accepted'; sending: Promise<void> }
  | { status: 'rate_limited'; retryAfterS: number }
  | { status: 'channel_unavailable' }
  | { status: 'bad_input' }

export function requestCode(input: { username: string; channel: string; client: string; lang: Lang }, now = Date.now()): RequestResult {
  const username = input.username.trim()
  const channel = CHANNELS.find((c) => c.id === input.channel)
  if (!username || username.length > 64 || !channel) return { status: 'bad_input' }
  let available = false
  try { available = channel.available() } catch { available = false }
  if (!available) return { status: 'channel_unavailable' }
  // Rate limit BEFORE looking the user up: the counters are keyed by the typed
  // name, so they behave identically for existing and unknown users.
  const wait = takeRequestSlot([`c:${input.client}`, `u:${username.toLowerCase()}`], now)
  if (wait > 0) return { status: 'rate_limited', retryAfterS: wait }

  const user = getDashboardUser(username)
  if (!user || user.disabled) return { status: 'accepted', sending: Promise.resolve() }

  ensureTables()
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const salt = randomBytes(16).toString('hex')
  getDb().prepare(`
    INSERT INTO password_recovery_codes (user_id, salt, code_hash, channel, created_at, expires_at, attempts)
    VALUES (?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(user_id) DO UPDATE SET salt = excluded.salt, code_hash = excluded.code_hash, channel = excluded.channel,
      created_at = excluded.created_at, expires_at = excluded.expires_at, attempts = 0
  `).run(user.id, salt, hashCode(salt, code), channel.id, now, now + CODE_TTL_MS)
  const m = MSG[input.lang]
  const sending = channel.send(user, m.body(code, user.username, CODE_TTL_MS / MINUTE), m.subject)
    .then((ok) => {
      if (!ok) logger.warn({ channel: channel.id }, 'password recovery: code was not delivered')
    })
    .catch((err) => { logger.warn({ err, channel: channel.id }, 'password recovery: code send threw') })
  logConfigChange('security.password_recovery_requested', null, `${user.username} via ${channel.id}`, 'public')
  return { status: 'accepted', sending }
}

const tickets = new Map<string, { userId: number; username: string; channel: RecoveryChannelId; expiresAt: number }>()

export type VerifyResult =
  | { status: 'ok'; ticket: string; expiresInSec: number }
  | { status: 'invalid' }
  | { status: 'rate_limited'; retryAfterS: number }

export function verifyCode(input: { username: string; code: string; client: string }, now = Date.now()): VerifyResult {
  const fails = recent(verifyFails.get(input.client), now, HOUR)
  if (fails.length >= VERIFY_FAILS_PER_HOUR) return { status: 'rate_limited', retryAfterS: Math.ceil((fails[0]! + HOUR - now) / 1000) }
  const fail = (): VerifyResult => { verifyFails.set(input.client, [...fails, now]); return { status: 'invalid' } }

  const code = input.code.replace(/\s+/g, '')
  const user = input.username.trim() ? getDashboardUser(input.username.trim()) : undefined
  if (!user || user.disabled || !/^\d{6}$/.test(code)) return fail()
  ensureTables()
  const db = getDb()
  const row = db.prepare('SELECT * FROM password_recovery_codes WHERE user_id = ?').get(user.id) as
    { salt: string; code_hash: string; channel: RecoveryChannelId; expires_at: number; attempts: number } | undefined
  if (!row) return fail()
  if (row.expires_at <= now || row.attempts >= CODE_MAX_ATTEMPTS) {
    db.prepare('DELETE FROM password_recovery_codes WHERE user_id = ?').run(user.id)
    return fail()
  }
  const a = Buffer.from(hashCode(row.salt, code), 'hex')
  const b = Buffer.from(row.code_hash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const attempts = row.attempts + 1
    if (attempts >= CODE_MAX_ATTEMPTS) db.prepare('DELETE FROM password_recovery_codes WHERE user_id = ?').run(user.id)
    else db.prepare('UPDATE password_recovery_codes SET attempts = ? WHERE user_id = ?').run(attempts, user.id)
    return fail()
  }
  // Single use: the code is gone the moment it has been accepted.
  db.prepare('DELETE FROM password_recovery_codes WHERE user_id = ?').run(user.id)
  for (const [k, v] of tickets) if (v.expiresAt <= now || v.userId === user.id) tickets.delete(k)
  const ticket = randomBytes(24).toString('hex')
  tickets.set(ticket, { userId: user.id, username: user.username, channel: row.channel, expiresAt: now + TICKET_TTL_MS })
  return { status: 'ok', ticket, expiresInSec: Math.round(TICKET_TTL_MS / 1000) }
}

/** Takes the ticket (single use). The caller sets the password and the session. */
export function consumeTicket(ticket: string, now = Date.now()): { userId: number; username: string; channel: RecoveryChannelId } | null {
  const rec = tickets.get(ticket)
  if (!rec) return null
  tickets.delete(ticket)
  if (rec.expiresAt <= now) return null
  return { userId: rec.userId, username: rec.username, channel: rec.channel }
}

/** Put a ticket back after a fixable refusal (password too short). */
export function returnTicket(ticket: string, rec: { userId: number; username: string; channel: RecoveryChannelId }, expiresAt: number): void {
  tickets.set(ticket, { ...rec, expiresAt })
}

export function ticketExpiry(ticket: string): number | null {
  return tickets.get(ticket)?.expiresAt ?? null
}

export function recoveryDoneNotice(username: string, channel: RecoveryChannelId, lang: Lang): string {
  const m = MSG[lang]
  return m.done(username, m.via[channel])
}
