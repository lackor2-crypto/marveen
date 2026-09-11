// The browser's own credential, and the record of what it was given.
//
// Card 21311fdb (#96). The extension needs to ask the dashboard for passwords,
// so it needs a credential -- and the obvious two are both wrong:
//   - the shared dashboard token would hand a browser extension the whole
//     fleet (agents, kanban, the vault in full);
//   - a device key (auth-device-keys.ts) is narrower but still a general
//     dashboard principal.
// A browser extension is the most exposed thing in the house. It gets its own
// token instead, and routes/autofill.ts is the ONLY place that accepts it --
// see isAutofillWireEndpoint() in auth-gate.ts, which scopes it the same way
// federation tokens are scoped to the two wire endpoints.
//
// Only sha256(token) is stored, exactly as auth-device-keys.ts and
// auth-sessions.ts do it: a copy of claudeclaw.db must not be a working key.
//
// Pairing goes through a short code the user reads off the dashboard and types
// into the extension. The code lives in SQLite, not in memory, because a
// dashboard restart mid-pairing would otherwise invalidate it silently and the
// user would have no way to tell that from "I mistyped it".

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { getDb } from '../db.js'

const TOKEN_PREFIX = 'mvaf_'
/** Long enough that a wrong guess is hopeless, short enough to be read aloud
 *  off a screen and typed into a popup. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
export const PAIRING_TTL_SEC = 10 * 60
const LAST_USED_DEBOUNCE_SEC = 60
/** How many delivery rows the dashboard keeps. The log is there to be read by
 *  a person ("what went out, where, when"), not to be an archive. */
const EVENT_KEEP = 200

export interface AutofillClient {
  id: number
  name: string
  createdAt: number
  lastUsedAt: number | null
}

export interface MintedAutofillClient extends AutofillClient {
  /** The raw token. Handed out once, at pairing, and never recoverable. */
  token: string
}

export interface AutofillPairing {
  /** The code as the user reads it: XXXX-XXXX. */
  code: string
  expiresAt: number
}

export type AutofillOutcome = 'served' | 'no_match' | 'refused_domain' | 'no_password'

export interface AutofillEvent {
  id: number
  clientName: string
  host: string
  entryLabel: string | null
  outcome: AutofillOutcome
  createdAt: number
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

let tablesReady = false

/** Idempotent schema. src/db.ts creates the same tables on startup; this is
 *  what makes the module usable in a test that opens its own database. */
export function ensureAutofillTables(): void {
  if (tablesReady) return
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS autofill_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS autofill_pairings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS autofill_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      client_name TEXT NOT NULL,
      host TEXT NOT NULL,
      entry_id TEXT,
      entry_label TEXT,
      outcome TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  tablesReady = true
}

/** Uppercase, dashes and spaces dropped: the code is read off a screen and
 *  retyped, so "abcd efgh" and "ABCD-EFGH" must be the same code. */
export function normalizePairingCode(input: string): string {
  return (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

/** A fresh pairing code. Previous unused codes are dropped: two live codes on
 *  screen at once is how a person pairs the wrong browser. */
export function createPairingCode(): AutofillPairing {
  ensureAutofillTables()
  const db = getDb()
  db.prepare('DELETE FROM autofill_pairings WHERE used_at IS NULL').run()
  let raw = ''
  const bytes = randomBytes(CODE_LENGTH)
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  const now = nowSec()
  const expiresAt = now + PAIRING_TTL_SEC
  db.prepare('INSERT INTO autofill_pairings (code_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)')
    .run(sha256hex(raw), now, expiresAt)
  return { code: formatCode(raw), expiresAt }
}

/** The pairing code currently on offer, if any -- so the dashboard can show
 *  "waiting for a browser" after a reload without minting a second code.
 *  The code itself is NOT recoverable (only its hash is stored); this reports
 *  that one is outstanding and when it dies. */
export function pendingPairingExpiry(): number | null {
  ensureAutofillTables()
  const row = getDb()
    .prepare('SELECT expires_at FROM autofill_pairings WHERE used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1')
    .get(nowSec()) as { expires_at: number } | undefined
  return row ? row.expires_at : null
}

export type RedeemFailure = 'unknown_code' | 'expired' | 'already_used'

/**
 * Trade a typed code for a client token.
 *
 * Every failure is named, because the extension has to tell the user which one
 * it was: "mistyped", "too late, ask for a new one" and "this code already
 * paired another browser" need three different next steps.
 */
export function redeemPairingCode(code: string, browserName: string): { ok: true; client: MintedAutofillClient } | { ok: false; reason: RedeemFailure } {
  ensureAutofillTables()
  const db = getDb()
  const normalized = normalizePairingCode(code)
  if (!normalized) return { ok: false, reason: 'unknown_code' }
  const row = db
    .prepare('SELECT id, expires_at, used_at FROM autofill_pairings WHERE code_hash = ?')
    .get(sha256hex(normalized)) as { id: number; expires_at: number; used_at: number | null } | undefined
  if (!row) return { ok: false, reason: 'unknown_code' }
  if (row.used_at !== null) return { ok: false, reason: 'already_used' }
  const now = nowSec()
  if (row.expires_at <= now) return { ok: false, reason: 'expired' }
  db.prepare('UPDATE autofill_pairings SET used_at = ? WHERE id = ?').run(now, row.id)
  return { ok: true, client: mintClient(browserName) }
}

function mintClient(name: string): MintedAutofillClient {
  const db = getDb()
  const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  // An empty name stays empty on purpose: a machine-written Hungarian
  // placeholder would be a screen string that no language file knows about.
  // The dashboard renders the fallback in the user's own language.
  const clean = (name || '').trim().slice(0, 80)
  const now = nowSec()
  const info = db
    .prepare('INSERT INTO autofill_clients (token_hash, name, created_at, last_used_at) VALUES (?, ?, ?, NULL)')
    .run(sha256hex(raw), clean, now)
  return { id: Number(info.lastInsertRowid), name: clean, createdAt: now, lastUsedAt: null, token: raw }
}

/**
 * Validate a presented token. Returns the client or null.
 *
 * The hash comparison is constant-time even though the value compared is
 * already a hash: the lookup is a plain SQL equality, so the timing signal
 * would be in the index probe, not here -- but a future refactor that iterates
 * rows must not silently become a timing oracle.
 */
export function resolveAutofillClient(raw: string | undefined | null): AutofillClient | null {
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null
  ensureAutofillTables()
  const db = getDb()
  const hash = sha256hex(raw)
  const row = db
    .prepare('SELECT id, token_hash, name, created_at, last_used_at FROM autofill_clients WHERE token_hash = ?')
    .get(hash) as { id: number; token_hash: string; name: string; created_at: number; last_used_at: number | null } | undefined
  if (!row) return null
  const a = Buffer.from(row.token_hash, 'utf-8')
  const b = Buffer.from(hash, 'utf-8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const now = nowSec()
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_DEBOUNCE_SEC) {
    const res = db.prepare('UPDATE autofill_clients SET last_used_at = ? WHERE id = ?').run(now, row.id)
    // Zero changed rows means the row went away between the read and the
    // write -- the browser was revoked a moment ago, and the request it is
    // making now must not be answered.
    if (res.changes === 0) return null
  }
  return { id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at }
}

export function listAutofillClients(): AutofillClient[] {
  ensureAutofillTables()
  const rows = getDb()
    .prepare('SELECT id, name, created_at, last_used_at FROM autofill_clients ORDER BY created_at DESC')
    .all() as Array<{ id: number; name: string; created_at: number; last_used_at: number | null }>
  return rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }))
}

/** Revocation is immediate and total: the next request from that browser is
 *  an unknown token, and the browser is told so rather than left guessing. */
export function revokeAutofillClient(id: number): boolean {
  ensureAutofillTables()
  return getDb().prepare('DELETE FROM autofill_clients WHERE id = ?').run(id).changes > 0
}

export function recordAutofillEvent(e: {
  clientId: number | null
  clientName: string
  host: string
  entryId?: string | null
  entryLabel?: string | null
  outcome: AutofillOutcome
}): void {
  ensureAutofillTables()
  const db = getDb()
  db.prepare(`
    INSERT INTO autofill_events (client_id, client_name, host, entry_id, entry_label, outcome, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(e.clientId, e.clientName, e.host, e.entryId ?? null, e.entryLabel ?? null, e.outcome, nowSec())
  db.prepare(`
    DELETE FROM autofill_events WHERE id NOT IN (
      SELECT id FROM autofill_events ORDER BY id DESC LIMIT ?
    )
  `).run(EVENT_KEEP)
}

export function listAutofillEvents(limit = 30): AutofillEvent[] {
  ensureAutofillTables()
  const rows = getDb()
    .prepare('SELECT id, client_name, host, entry_label, outcome, created_at FROM autofill_events ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, limit))) as Array<{ id: number; client_name: string; host: string; entry_label: string | null; outcome: string; created_at: number }>
  return rows.map(r => ({
    id: r.id,
    clientName: r.client_name,
    host: r.host,
    entryLabel: r.entry_label,
    outcome: r.outcome as AutofillOutcome,
    createdAt: r.created_at,
  }))
}

/** Test seam: the module caches "schema exists" per process, and a test that
 *  swaps the database underneath needs that forgotten. */
export function _resetAutofillTablesForTest(): void {
  tablesReady = false
}
