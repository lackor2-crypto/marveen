// Direct-IMAP fast path for reading a message's text/html body, bypassing
// himalaya (which has no "text only" mode -- `message read` always downloads
// the whole message, attachment bytes included, see src/web/routes/email.ts
// for the incident that documented this). This module is a "strangler fig":
// it only ever ADDS a fast path in front of the existing himalaya code, never
// replaces it. `readMessageBodyDirect()` returns null on ANY failure -- the
// caller in routes/email.ts falls straight back to the old, always-working
// himalaya path. Nothing here can make email reading worse than it is today.
//
// Credentials are read from the SAME place himalaya already reads them from
// (~/.local/share/marveen-himalaya/config.toml + secrets/*.txt) -- nothing is
// copied to a new location, so file permissions (700 dir, 600 files) stay the
// single source of truth for who can read a mailbox password.

import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import type { MessageStructureObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import { parse as parseToml } from 'smol-toml'
import { logger } from '../logger.js'

const HIMALAYA_CONFIG = `${process.env.HOME}/.local/share/marveen-himalaya/config.toml`

export interface ImapAccountConfig {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
}

// Was a hand-rolled, deliberately narrow line-by-line reader that only
// understood ONE of the two equally-valid ways TOML can spell the same
// structure: dotted keys under a single bare `[accounts.X]` header
// (`imap.server = "..."`). routes/email.ts's `buildUpdatedTomlConfig` -- the
// only thing that ever WRITES this file -- builds a nested JS object and
// hands it to `smol-toml`'s `stringify()`, which always emits the OTHER
// spelling: per-level table headers (`[accounts.X.imap]`, `[accounts.X.imap.
// sasl.plain]`, ...). The two never had to interoperate until the first time
// anyone edited an account through the dashboard after this file existed --
// that rewrote the WHOLE config (every account, not just the edited one)
// into the header-per-level form, and the narrow reader silently returned an
// empty record for every account it saw, degrading (as designed) to the slow
// himalaya path for 100% of message opens (Boss, 2026-08-18: connected a new
// Gmail account, then "a level teste megint tul keson toltott be" -- store/
// dashboard.log confirmed EVERY account, not just the new one, switched to
// "direct IMAP body fetch unavailable ... falling back to himalaya" at the
// exact second config.toml's mtime changed). Fix: parse with the real TOML
// grammar (same library the writer uses) so both spellings -- and any other
// legal TOML shape -- land on the identical nested object, then flatten that
// into the dotted-key Record the rest of this file already expects. Still
// never throws past this function; a genuinely malformed file just yields no
// accounts, same graceful-degradation contract as before.
function flattenTomlRecord(node: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  if (node === null || node === undefined || typeof node !== 'object' || Array.isArray(node)) return out
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenTomlRecord(value, dotted))
    } else if (value !== undefined) {
      out[dotted] = String(value)
    }
  }
  return out
}

function parseHimalayaToml(text: string): Map<string, Record<string, string>> {
  const accounts = new Map<string, Record<string, string>>()
  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch (e) {
    logger.warn(`[email-imap] failed to parse himalaya config as TOML: ${e instanceof Error ? e.message : e}`)
    return accounts
  }
  const accountsNode = (parsed as { accounts?: Record<string, unknown> })?.accounts
  if (!accountsNode || typeof accountsNode !== 'object') return accounts
  for (const [id, raw] of Object.entries(accountsNode)) {
    accounts.set(id, flattenTomlRecord(raw))
  }
  return accounts
}

function runPasswordCommand(command: string): Promise<string | null> {
  return new Promise(resolve => {
    // The command in this install's config is always a plain `cat <path>` --
    // shell:true so any equivalent form (e.g. a future `pass show ...`) also
    // works, matching how himalaya itself would invoke it. 5s is generous for
    // a local file read; a hung command must not block a page load forever.
    execFile('/bin/sh', ['-c', command], { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return }
      resolve(stdout.trim())
    })
  })
}

// Parsed once, re-parsed only if the config file's mtime changes -- so
// editing config.toml (e.g. adding a third account) is picked up without a
// dashboard restart, without re-parsing on every single message open either.
let cachedConfigMtimeMs = -1
let cachedAccounts: Map<string, Record<string, string>> = new Map()
const resolvedAccountCache = new Map<string, ImapAccountConfig>()

function loadRawAccounts(): Map<string, Record<string, string>> {
  let mtimeMs: number
  try {
    mtimeMs = statSync(HIMALAYA_CONFIG).mtimeMs
  } catch {
    return new Map()
  }
  if (mtimeMs === cachedConfigMtimeMs) return cachedAccounts
  try {
    cachedAccounts = parseHimalayaToml(readFileSync(HIMALAYA_CONFIG, 'utf-8'))
    cachedConfigMtimeMs = mtimeMs
    resolvedAccountCache.clear() // config changed -- stale resolved passwords must go too
  } catch (e) {
    logger.warn(`[email-imap] failed to read/parse himalaya config: ${e instanceof Error ? e.message : e}`)
    return new Map()
  }
  return cachedAccounts
}

function parseImapServer(server: string): { host: string; port: number; secure: boolean } | null {
  // imaps://host:port -> secure (implicit TLS); imap://host:port -> plain
  // (STARTTLS not modeled -- this install only ever uses imaps://, and a
  // scheme this parser doesn't recognise correctly falls through to null,
  // i.e. "use himalaya", rather than guessing at security-relevant defaults.
  const m = /^imaps?:\/\/([^:/]+)(?::(\d+))?\/?$/.exec(server.trim())
  if (!m) return null
  const secure = server.trim().startsWith('imaps://')
  const host = m[1]!
  const port = m[2] ? Number(m[2]) : (secure ? 993 : 143)
  return { host, port, secure }
}

// Resolves and caches ONE account's IMAP connection config, including
// running its password command. Returns null if this account's config
// doesn't match the shape this reader understands (missing keys, unsupported
// auth form, unparseable server URL) -- the caller falls back to himalaya.
export async function resolveImapAccount(accountId: string): Promise<ImapAccountConfig | null> {
  const cached = resolvedAccountCache.get(accountId)
  if (cached) return cached

  const raw = loadRawAccounts().get(accountId)
  if (!raw) return null

  const server = raw['imap.server']
  const user = raw['imap.sasl.plain.username']
  const passwordCommand = raw['imap.sasl.plain.password.command']
  if (!server || !user || !passwordCommand) return null // e.g. OAuth2 accounts have no password.command -- not this reader's job

  const parsed = parseImapServer(server)
  if (!parsed) return null

  const password = await runPasswordCommand(passwordCommand)
  if (password === null || password === '') {
    logger.warn(`[email-imap] password command failed for account "${accountId}" -- falling back to himalaya`)
    return null
  }

  const config: ImapAccountConfig = { host: parsed.host, port: parsed.port, secure: parsed.secure, user, password }
  resolvedAccountCache.set(accountId, config)
  return config
}

export interface ImapFastPathStatus {
  ok: boolean
  reason?: string
}

// A dashboard-facing health check for the "does the fast path even resolve
// this account's config" question -- the exact thing that broke silently
// for every account on 2026-08-18 (see parseHimalayaToml's comment above).
// Deliberately does NOT go through resolveImapAccount()/resolvedAccountCache:
// that cache never expires once an account resolves successfully once, so a
// status indicator built on it would keep reporting "ok" forever after the
// first success even if config.toml regressed again later -- exactly the
// silent-failure this check exists to catch. loadRawAccounts() underneath
// still re-parses on its own (mtime-based), so this always reflects the
// CURRENT file. Never runs the password command (no subprocess per poll) --
// structural resolvability is the signal, not live connectivity.
export function checkImapAccountConfig(accountId: string): ImapFastPathStatus {
  const raw = loadRawAccounts().get(accountId)
  if (!raw) return { ok: false, reason: 'a fiók nem található a config.toml-ban' }

  const server = raw['imap.server']
  const user = raw['imap.sasl.plain.username']
  const passwordCommand = raw['imap.sasl.plain.password.command']
  if (!server || !user || !passwordCommand) {
    return { ok: false, reason: 'hianyzo IMAP mezo a config.toml-ban (szerver/felhasznalonev/jelszo-parancs) -- valoszinuleg config-format-drift, lasd a parseHimalayaToml komment' }
  }
  if (!parseImapServer(server)) {
    return { ok: false, reason: `nem ertelmezheto IMAP szerver-cim: "${server}"` }
  }
  return { ok: true }
}

// === Connection manager =====================================================
// At most ONE ImapFlow client per account, reused across calls -- this file's
// header comment on the himalaya side already records the "Resource
// temporarily unavailable (os error 11)" incident from too many concurrent
// IMAP connections; one long-lived connection per account is FEWER
// connections than today's per-request himalaya subprocess model, not more.
// Idle eviction after 5 minutes so a quiet dashboard doesn't hold a socket
// open forever; `.unref()` so the timer never keeps the process alive.

type ImapClientState = { client: ImapFlow; idleTimer: NodeJS.Timeout | null }
const clients = new Map<string, ImapClientState>()
const IDLE_EVICT_MS = 5 * 60_000

function scheduleEviction(accountId: string): void {
  const state = clients.get(accountId)
  if (!state) return
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = setTimeout(() => {
    clients.delete(accountId)
    state.client.logout().catch(() => {})
  }, IDLE_EVICT_MS)
  state.idleTimer.unref()
}

async function getClient(accountId: string): Promise<ImapFlow | null> {
  const existing = clients.get(accountId)
  if (existing) { scheduleEviction(accountId); return existing.client }

  const cfg = await resolveImapAccount(accountId)
  if (!cfg) return null

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
    disableAutoIdle: true, // reused on-demand, not a live-updating mailbox watcher
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
    clientInfo: { name: 'Marveen' },
  })
  client.on('error', (err: Error) => {
    logger.warn(`[email-imap] connection error for account "${accountId}": ${err.message}`)
    clients.delete(accountId)
  })
  client.on('close', () => { clients.delete(accountId) })

  try {
    await client.connect()
  } catch (e) {
    logger.warn(`[email-imap] connect failed for account "${accountId}" (${cfg.host}:${cfg.port}): ${e instanceof Error ? e.message : e}`)
    return null
  }
  clients.set(accountId, { client, idleTimer: null })
  scheduleEviction(accountId)
  return client
}

// === BODYSTRUCTURE body-part selection ======================================
// Pure, network-free -- unit-testable against hand-written synthetic trees.
// A leaf counts as "the body" only if it's text/plain or text/html AND has no
// attachment disposition AND no filename (a text/plain FILE attached to a
// mail is still text/plain, but it is not the mail's body).
function isBodyCandidate(node: MessageStructureObject): boolean {
  const type = node.type?.toLowerCase() ?? ''
  if (type !== 'text/plain' && type !== 'text/html') return false
  if (node.disposition?.toLowerCase() === 'attachment') return false
  if (node.dispositionParameters?.filename || node.parameters?.name) return false
  return true
}

export interface SelectedBodyParts {
  textPart: string | null
  htmlPart: string | null
}

// multipart/alternative -> best text/plain + best text/html among DIRECT
// children (recursing into a multipart/related child by treating that
// child's first child as its body root, since multipart/related's own first
// part is the "displayable" one and the rest are inline resources like cid:
// images).
// multipart/related -> first child is the body root.
// multipart/mixed, multipart/signed, anything else multipart -> recurse into
// children; the FIRST child subtree supplies the body (matches how mail
// clients typically nest a real message ahead of trailing attachments).
// A single leaf (no childNodes) is the whole body if it qualifies.
// NEVER descend into message/rfc822 -- a forwarded/attached message is an
// attachment, not part of THIS message's body.
export function selectBodyParts(node: MessageStructureObject): SelectedBodyParts {
  const type = node.type?.toLowerCase() ?? ''
  if (type === 'message/rfc822') return { textPart: null, htmlPart: null }

  if (!node.childNodes || node.childNodes.length === 0) {
    if (!isBodyCandidate(node)) return { textPart: null, htmlPart: null }
    return type === 'text/html' ? { textPart: null, htmlPart: node.part ?? null } : { textPart: node.part ?? null, htmlPart: null }
  }

  if (type === 'multipart/alternative') {
    let textPart: string | null = null
    let htmlPart: string | null = null
    for (const child of node.childNodes) {
      const childType = child.type?.toLowerCase() ?? ''
      if (childType === 'multipart/related') {
        const related = selectBodyParts(child)
        textPart = textPart ?? related.textPart
        htmlPart = htmlPart ?? related.htmlPart
        continue
      }
      if (!isBodyCandidate(child)) continue
      if (childType === 'text/plain') textPart = child.part ?? textPart
      if (childType === 'text/html') htmlPart = child.part ?? htmlPart
    }
    return { textPart, htmlPart }
  }

  if (type === 'multipart/related') {
    return selectBodyParts(node.childNodes[0]!)
  }

  // multipart/mixed, multipart/signed, or any other multipart/* -- the first
  // child subtree is the body, the rest are attachments/signature parts.
  return selectBodyParts(node.childNodes[0]!)
}

// === Attachment enumeration (id parity with himalaya) =======================
// Depth-first, document order, over every leaf (message/rfc822 counts as ONE
// opaque leaf, its own internals are never descended into). A leaf that is
// one of the selected body parts (matched by 'part' number) is excluded from
// the id sequence entirely -- himalaya's own numbering (see the `attachment
// list --help` example this was derived from) counts only attachment-like
// parts, not the displayed body. Ids are 1-based, inline parts included in
// the numbering (a caller filters those out afterwards for display, exactly
// as the existing himalaya-based code already does with `!a.inline`).
export interface DirectAttachmentMeta {
  id: string
  filename: string
  mime: string
  size: number
  inline?: boolean
}

function isInlinePart(node: MessageStructureObject): boolean {
  if (node.disposition?.toLowerCase() === 'inline') return true
  // A part with a Content-ID and no explicit "attachment" disposition is a
  // cid: inline resource (typical for a logo/signature image) even when the
  // server never sent a Content-Disposition header at all.
  return !!node.id && node.disposition?.toLowerCase() !== 'attachment'
}

// BODYSTRUCTURE reports the ENCODED size (e.g. base64), not the decoded byte
// count -- base64 expands ~78 bytes of output per 57 bytes of input, so the
// true size is roughly size * 57/78. Quoted-printable and 7bit/8bit/binary
// are already ~1:1, left uncorrected. This is a cosmetic label (matches
// himalaya within ~3%), never used for buffer sizing.
function decodedSizeEstimate(node: MessageStructureObject): number {
  const raw = node.size ?? 0
  if ((node.encoding ?? '').toLowerCase() === 'base64') return Math.round(raw * (57 / 78))
  return raw
}

export function enumerateAttachments(root: MessageStructureObject, body: SelectedBodyParts): DirectAttachmentMeta[] {
  const out: DirectAttachmentMeta[] = []
  let nextId = 1
  const walk = (node: MessageStructureObject): void => {
    const type = node.type?.toLowerCase() ?? ''
    const isBodyLeaf = (node.part && (node.part === body.textPart || node.part === body.htmlPart)) ?? false
    if (node.childNodes && node.childNodes.length > 0 && type !== 'message/rfc822') {
      for (const child of node.childNodes) walk(child)
      return
    }
    // Leaf (or an opaque message/rfc822 subtree, which we do not descend into).
    if (isBodyLeaf) return
    const id = String(nextId++)
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? ''
    out.push({
      id,
      filename,
      mime: type,
      size: decodedSizeEstimate(node),
      inline: isInlinePart(node),
    })
  }
  walk(root)
  return out
}

// === Charset repair ==========================================================
// Some senders -- classically Outlook/Exchange -- emit a text/html MIME part
// with NO charset= parameter and declare the real charset only inside the
// markup, in a <meta charset> / <meta http-equiv="Content-Type"> tag.
// mailparser resolves charset from MIME headers alone (mail-parser.js:
// `let charset = node.charset || 'utf-8'`), so with none declared it assumes
// utf-8 and passes the bytes through undecoded -- 8-bit windows-1250 /
// iso-8859-2 text then arrives as U+FFFD. That damage happens inside the
// parser and cannot be undone afterwards, so the tag has to be sniffed and
// written into the part header BEFORE parsing; mailparser's own iconv
// decoding then does the actual conversion, instead of a second, divergent
// decoder living here (same reasoning as the synthetic-part assembly below).
// A part we can't sniff (base64 body, no meta tag) is left exactly as it is.

const META_SCAN_BYTES = 4096
// `=3D` covers a quoted-printable part, where `charset=` is spelled `charset=3D`.
const META_CHARSET_RE = /<meta[^>]*?charset\s*=\s*(?:3D)?\s*["']?\s*([A-Za-z0-9][A-Za-z0-9._:-]{1,39})/i
// Value plus any folded continuation lines -- a charset sitting on the second
// line of a folded header must count as "already declared".
const CONTENT_TYPE_RE = /^Content-Type:[ \t]*([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/im

export function declareSniffedHtmlCharset(raw: Buffer): Buffer {
  // latin1 round-trips every byte unchanged, so scanning as text here cannot
  // corrupt the very 8-bit content this exists to protect.
  const s = raw.toString('latin1')
  if (!/charset/i.test(s)) return raw

  // A MIME header block starts at the very beginning of the message and after
  // every boundary line; anchoring to those keeps a "Content-Type:" that
  // merely appears inside body text from being treated as a header.
  const starts = [0]
  const boundary = /^--[^\r\n]+\r?\n/gm
  for (let b = boundary.exec(s); b; b = boundary.exec(s)) starts.push(b.index + b[0].length)

  const edits: Array<{ at: number; text: string }> = []
  const blank = /\r?\n\r?\n/g
  for (const start of starts) {
    blank.lastIndex = start
    const gap = blank.exec(s)
    const headEnd = gap ? gap.index : s.length
    const bodyStart = gap ? gap.index + gap[0].length : s.length
    const ct = CONTENT_TYPE_RE.exec(s.slice(start, headEnd))
    if (!ct) continue
    if (!/^text\/html\b/i.test(ct[1].trim())) continue
    if (/charset\s*=/i.test(ct[1])) continue
    const meta = META_CHARSET_RE.exec(s.slice(bodyStart, bodyStart + META_SCAN_BYTES))
    if (!meta) continue
    edits.push({ at: start + ct[0].length, text: `; charset="${meta[1]}"` })
  }
  if (edits.length === 0) return raw

  let out = s
  for (const e of edits.reverse()) out = out.slice(0, e.at) + e.text + out.slice(e.at)
  return Buffer.from(out, 'latin1')
}

// === Main entry point ========================================================
export interface DirectMessageBody {
  text: string
  html: string
  attachments: DirectAttachmentMeta[]
}

const FETCH_TIMEOUT_MS = 20_000
const MAX_BODY_PART_BYTES = 25 * 1024 * 1024

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

// Returns null on ANY failure -- the caller (routes/email.ts) falls back to
// the existing himalaya path. Never throws.
export async function readMessageBodyDirect(accountId: string, mailbox: string, uid: string): Promise<DirectMessageBody | null> {
  const uidNum = Number(uid)
  if (!Number.isInteger(uidNum) || uidNum <= 0) return null

  const client = await getClient(accountId)
  if (!client) return null

  let lock
  try {
    lock = await withTimeout(client.getMailboxLock(mailbox), FETCH_TIMEOUT_MS)
  } catch (e) {
    logger.warn(`[email-imap] failed to open mailbox "${mailbox}" for account "${accountId}": ${e instanceof Error ? e.message : e}`)
    return null
  }

  try {
    const structMsg = await withTimeout(client.fetchOne(uid, { bodyStructure: true }, { uid: true }), FETCH_TIMEOUT_MS)
    if (!structMsg || !structMsg.bodyStructure) return null
    const structure = structMsg.bodyStructure

    // Non-multipart message: no childNodes means no attachments either --
    // fetch the whole thing and parse as today, nothing to save by peeking.
    if (!structure.childNodes || structure.childNodes.length === 0) {
      if (!isBodyCandidate(structure)) return null // unsupported single-part shape (e.g. a lone attachment with no body) -- fall back
      if ((structure.size ?? 0) > MAX_BODY_PART_BYTES) return null
      const full = await withTimeout(client.fetchOne(uid, { source: true }, { uid: true }), FETCH_TIMEOUT_MS)
      if (!full || !full.source) return null
      const parsed = await simpleParser(declareSniffedHtmlCharset(full.source), { skipHtmlToText: true })
      return { text: parsed.text || '', html: typeof parsed.html === 'string' ? parsed.html : '', attachments: [] }
    }

    const body = selectBodyParts(structure)
    if (!body.textPart && !body.htmlPart) return null // couldn't find a body candidate -- fall back rather than show nothing

    const attachments = enumerateAttachments(structure, body)

    const partIds = [body.textPart, body.htmlPart].filter((p): p is string => !!p)
    const bodyParts: Array<string | { key: string }> = []
    // Lowercase "mime", not "MIME": confirmed live -- whatever case is
    // requested, imapflow's response Map always keys the MIME-header part as
    // "<part>.mime" (lowercase). Requesting/looking up "MIME" silently
    // returns undefined for that key, which used to make every message with
    // a body fall through to `!mime || !content` and return null (fall back
    // to himalaya) even though the fetch itself succeeded.
    for (const p of partIds) { bodyParts.push(p, `${p}.mime`) }
    const fetched = await withTimeout(client.fetchOne(uid, { bodyParts }, { uid: true }), FETCH_TIMEOUT_MS)
    if (!fetched || !fetched.bodyParts) return null

    // Assemble a tiny synthetic RFC5322 fragment per part (MIME headers for
    // that part + its content) and hand it to mailparser -- this gets
    // base64/quoted-printable and charset (iso-8859-2, windows-1252, ...)
    // decoding for free, from the SAME parser routes/email.ts already uses,
    // so output is byte-identical to today's for the same input. Hand-rolling
    // transfer-encoding/charset decoding here would be a second, divergent
    // implementation of something mailparser already does correctly.
    let text = ''
    let html = ''
    for (const p of partIds) {
      const mime = fetched.bodyParts.get(`${p}.mime`)
      const content = fetched.bodyParts.get(p)
      if (!mime || !content) continue
      const synthetic = declareSniffedHtmlCharset(Buffer.concat([mime, content]))
      const parsed = await simpleParser(synthetic, { skipHtmlToText: true })
      if (p === body.textPart) text = parsed.text || (typeof parsed.html !== 'string' ? '' : text)
      if (p === body.htmlPart) html = typeof parsed.html === 'string' ? parsed.html : html
    }
    if (!text && !html) return null

    return { text, html, attachments }
  } catch (e) {
    logger.warn(`[email-imap] direct body fetch failed for account "${accountId}" uid=${uid}: ${e instanceof Error ? e.message : e}`)
    return null
  } finally {
    lock.release()
  }
}

// Confirms a UID still resolves to a real message before a caller trusts a
// CACHED body for it -- a bare UID-only fetch (no BODYSTRUCTURE, no content),
// so this stays cheap even for a huge-attachment message; it exists purely to
// answer "is this UID still here" (Boss, 2026-08-06: deleted a mail straight
// in Gmail, Marveen's reader pane kept showing it after an F5 refresh because
// the cached body was served without ever re-checking IMAP). Returns false
// ONLY when the fetch cleanly came back empty (message genuinely gone) --
// returns true on ANY other outcome (transient timeout, connection drop, no
// client available) so a momentary blip evicts nothing; worst case this
// behaves exactly like the check didn't run at all, never worse.
export async function messageStillExists(accountId: string, mailbox: string, uid: string): Promise<boolean> {
  const uidNum = Number(uid)
  if (!Number.isInteger(uidNum) || uidNum <= 0) return true

  const client = await getClient(accountId)
  if (!client) return true

  let lock
  try {
    lock = await withTimeout(client.getMailboxLock(mailbox), FETCH_TIMEOUT_MS)
  } catch {
    return true
  }
  try {
    const found = await withTimeout(client.fetchOne(uid, { uid: true }, { uid: true }), FETCH_TIMEOUT_MS)
    return !!found
  } catch (e) {
    logger.warn(`[email-imap] existence check failed for account "${accountId}" uid=${uid}: ${e instanceof Error ? e.message : e}`)
    return true
  } finally {
    lock.release()
  }
}

// === Mailbox list (strangler fig: fast path with himalaya fallback) ============
// Returns array of { id: string; name: string; total: null; unread: null } matching
// himalaya's `mailbox list --json` output exactly. Returns null on ANY failure
// so the caller falls back to himalaya.
/**
 * Gmail's built-in folders, identified by ROLE instead of by name.
 *
 * The name is localized to the ACCOUNT's own Gmail language. Measured
 * 2026-08-18 against two live accounts: Trash is "[Gmail]/Kuka" on a Hungarian
 * account and "[Gmail]/Trash" on an English one, and Sent/Drafts/Starred/
 * Important/All Mail differ the same way. Only "[Gmail]/Spam" happens to be
 * spelled identically in both. So anything that hardcodes one spelling works on
 * the accounts it was written against and fails on every other one -- which is
 * exactly what happened when Boss added freeberischeaper@gmail.com and Delete
 * came back "Command failed ... -t [Gmail]/Kuka".
 *
 * The IMAP flags do NOT move with the language, so they are what we key on.
 */
export type MailboxRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'important' | 'starred' | 'all'

// RFC 6154 special-use attributes, plus Gmail's non-standard "\Important".
// Read from `flags` rather than imapflow's `specialUse` on purpose: measured on
// a live account, "\Important" appears ONLY in `flags` (imapflow lifts just the
// RFC 6154 set into specialUse), while the inbox carries "\Inbox" only in
// specialUse and never in flags -- hence the path check for the inbox below.
const ROLE_BY_FLAG: ReadonlyArray<readonly [string, MailboxRole]> = [
  ['\\Sent', 'sent'],
  ['\\Drafts', 'drafts'],
  ['\\Trash', 'trash'],
  ['\\Junk', 'spam'],
  ['\\Important', 'important'],
  ['\\Flagged', 'starred'],
  ['\\All', 'all'],
]

export function mailboxRoleFromFlags(path: string, flags?: Set<string> | string[]): MailboxRole | null {
  // RFC 3501 defines the inbox case-insensitively, and it carries no
  // special-use flag of its own in the LIST response.
  if (path.toUpperCase() === 'INBOX') return 'inbox'
  const has = (f: string): boolean =>
    flags instanceof Set ? flags.has(f) : Array.isArray(flags) ? flags.includes(f) : false
  for (const [flag, role] of ROLE_BY_FLAG) if (has(flag)) return role
  return null
}

export interface DirectMailbox {
  id: string
  name: string
  total: null
  unread: null
  /** Which Gmail system folder this is, independent of the account's language. */
  role: MailboxRole | null
}

/**
 * The name himalaya would have printed for an IMAP mailbox path.
 *
 * This is a CONTRACT, not a cosmetic choice. The mailbox name travels: the
 * folder column pins the system folders by name, every read/move/flag call
 * sends the name back, and the himalaya fallback must accept the same string.
 * himalaya prints the inbox as "Inbox" and every other folder at its full path
 * ("[Gmail]/Kuka"), so this path must produce exactly that.
 *
 * Boss, 2026-08-12: "mar megint eltunt az elso oszlopbol a beerkezo levelek meg
 * a tobbi!" The direct path had been mapping imapflow's `name` (the LEAF
 * segment: "Kuka") instead of its `path` (the full "[Gmail]/Kuka"), so not one
 * system folder matched the frontend's list, all of them fell through to the
 * custom-label bucket, and the column turned into a flat alphabetical list with
 * a raw "INBOX" buried in the middle of it.
 */
export function himalayaMailboxName(path: string): string {
  // IMAP folder names are case-sensitive EXCEPT the inbox, which RFC 3501
  // defines case-insensitively -- servers answer to INBOX/Inbox/inbox alike.
  return path.toUpperCase() === 'INBOX' ? 'Inbox' : path
}

/**
 * Map an IMAP LIST response to himalaya's mailbox-list shape, or null when the
 * result is not fit to serve.
 *
 * Pure and exported so the contract can be tested without a mail server: the
 * folder column is the part of the email view that broke twice, and both times
 * it broke in a way no type check could see (a real list of real folders, just
 * not the names the rest of the system speaks).
 */
export function mapDirectMailboxes(
  mailboxes: Array<{ path: string; flags?: Set<string> | string[] }>,
): DirectMailbox[] | null {
  const hasFlag = (mb: { flags?: Set<string> | string[] }, flag: string): boolean =>
    mb.flags instanceof Set ? mb.flags.has(flag) : Array.isArray(mb.flags) ? mb.flags.includes(flag) : false
  const mapped = mailboxes
    .filter(mb => !hasFlag(mb, '\\Noselect'))   // non-selectable pseudo-mailboxes
    .map(mb => {
      const name = himalayaMailboxName(mb.path)
      return { id: name, name, total: null, unread: null, role: mailboxRoleFromFlags(mb.path, mb.flags) } as DirectMailbox
    })
  // Refuse a list that lost the inbox. Whatever went wrong -- a server that
  // answers differently, a library upgrade that renames a field -- a folder
  // column without "Beérkező levelek" in it is not an improvement over the
  // slower path, and the fallback costs about a second. This is the guard Boss
  // asked for after the same column broke twice: not "we tested it", but "it
  // cannot ship broken" (2026-08-12).
  if (!mapped.some(mb => mb.name === 'Inbox')) return null
  return mapped
}

export async function listMailboxesDirect(accountId: string): Promise<DirectMailbox[] | null> {
  const client = await getClient(accountId)
  if (!client) return null

  try {
    const mailboxes = await withTimeout(client.list(), FETCH_TIMEOUT_MS)
    if (!mailboxes) return null
    // imapflow returns MailboxObject[] with .path (full), .name (leaf segment),
    // .flags, .delimiter.
    const mapped = mapDirectMailboxes(mailboxes)
    if (mapped === null) {
      logger.warn(`[email-imap] mailbox list for account "${accountId}" is unusable (no Inbox among ${mailboxes.length} entries); falling back to himalaya`)
      return null
    }
    return mapped
  } catch (e) {
    logger.warn(`[email-imap] mailbox list failed for account "${accountId}": ${e instanceof Error ? e.message : e}`)
    return null
  }
}

/**
 * The account's OWN names for Gmail's system folders, keyed by role.
 *
 * Only the direct IMAP path can answer this: himalaya's `mailbox list --json`
 * carries no flags at all (measured 2026-08-18 -- id/name/total/unread and
 * nothing else), so there is no second source to fall back to. Callers get
 * null when it cannot be resolved and decide for themselves what to do.
 */
export type SpecialMailboxes = Partial<Record<MailboxRole, string>>

export function specialMailboxesFrom(mailboxes: DirectMailbox[]): SpecialMailboxes {
  const out: SpecialMailboxes = {}
  // First one wins: a role is single-valued, and Gmail reports each exactly once.
  for (const mb of mailboxes) if (mb.role && !out[mb.role]) out[mb.role] = mb.name
  return out
}

// Folder names change about as often as an account's language does, i.e. never
// in practice -- but the TTL means a change is picked up on its own instead of
// needing a restart.
const SPECIAL_MAILBOX_TTL_MS = 10 * 60 * 1000
const specialMailboxCache = new Map<string, { at: number; value: SpecialMailboxes }>()

export async function resolveSpecialMailboxes(accountId: string): Promise<SpecialMailboxes | null> {
  const hit = specialMailboxCache.get(accountId)
  if (hit && Date.now() - hit.at < SPECIAL_MAILBOX_TTL_MS) return hit.value
  const list = await listMailboxesDirect(accountId)
  if (!list) return null
  const value = specialMailboxesFrom(list)
  specialMailboxCache.set(accountId, { at: Date.now(), value })
  return value
}

// === Envelope list / search (strangler fig: fast path with himalaya fallback) ===
// Returns array of envelope objects matching himalaya's `envelope list --json` /
// `envelope search --json` output exactly. Returns null on ANY failure so the
// caller falls back to himalaya.
// searchQuery: if provided, uses IMAP SEARCH with TEXT/SUBJECT/FROM/TO criteria
// (translated from the same normalized query the himalaya path uses).
export interface DirectEnvelope {
  id: string
  'message-id': string
  flags: Array<{ raw: string; iana: string }>
  subject: string
  from: Array<{ name: string | null; email: string }>
  to: Array<{ name: string | null; email: string }>
  date: string
  size: number
  'has-attachment': null
}

function parseImapFlags(imapFlags: string[]): Array<{ raw: string; iana: string }> {
  const mapping: Record<string, string> = {
    '\\Seen': 'seen',
    '\\Flagged': 'flagged',
    '\\Answered': 'answered',
    '\\Draft': 'draft',
    '\\Deleted': 'deleted',
    'Junk': 'junk',
    'NonJunk': 'nonjunk',
    '$Forwarded': 'forwarded',
    '$MDNSent': 'mdnsent',
  }
  return imapFlags
    .filter(f => mapping[f])
    .map(f => ({ raw: f, iana: mapping[f] }))
}

function buildImapSearchCriteria(query: string): Record<string, string | string[]> {
  // The normalized query from routes/email.ts is already in a simple format:
  // "from:foo subject:bar to:baz date:2024-01-01 content:qux"
  // Parse into IMAP SEARCH criteria object for imapflow
  const criteria: Record<string, string | string[]> = {}
  const parts = query.split(' ').filter(Boolean)
  for (const part of parts) {
    const colon = part.indexOf(':')
    if (colon <= 0) continue
    const field = part.slice(0, colon).toLowerCase()
    const value = part.slice(colon + 1)
    if (!value) continue
    switch (field) {
      case 'from':
        criteria.from = value
        break
      case 'to':
        criteria.to = value
        break
      case 'subject':
        criteria.subject = value
        break
      case 'date':
        // IMAP SEARCH expects DD-MON-YYYY format
        const d = new Date(value)
        if (!isNaN(d.getTime())) {
          const day = String(d.getDate()).padStart(2, '0')
          const month = d.toLocaleString('en-US', { month: 'short' }).toUpperCase()
          const year = d.getFullYear()
          criteria.on = `${day}-${month}-${year}`
        }
        break
      case 'content':
      case 'body':
        criteria.body = value
        break
      default:
        criteria.text = value
    }
  }
  return criteria
}

export async function listEnvelopesDirect(
  accountId: string,
  mailbox: string,
  page: number,
  pageSize: number,
  searchQuery?: string
): Promise<DirectEnvelope[] | null> {
  const client = await getClient(accountId)
  if (!client) return null

  let lock
  try {
    lock = await withTimeout(client.getMailboxLock(mailbox), FETCH_TIMEOUT_MS)
  } catch (e) {
    logger.warn(`[email-imap] failed to open mailbox "${mailbox}" for account "${accountId}": ${e instanceof Error ? e.message : e}`)
    return null
  }

  try {
    // Get total count for pagination
    let uids: number[]
    if (searchQuery) {
      const criteria = buildImapSearchCriteria(searchQuery)
      if (Object.keys(criteria).length === 0) return []
      const searchResult = await withTimeout(client.search(criteria, { uid: true }), FETCH_TIMEOUT_MS)
      if (searchResult === false) return null
      uids = searchResult
    } else {
      const searchResult = await withTimeout(client.search({ all: true }, { uid: true }), FETCH_TIMEOUT_MS)
      if (searchResult === false) return null
      uids = searchResult
    }
    if (!uids || uids.length === 0) return []

    // Sort by UID descending (newest first) to match himalaya's default
    uids.sort((a, b) => b - a)

    // Pagination
    const start = (page - 1) * pageSize
    const end = start + pageSize
    const pageUids = uids.slice(start, end)
    if (pageUids.length === 0) return []

    // Fetch ENVELOPE + FLAGS + BODYSTRUCTURE (for size/attachment detection)
    const fetchOptions = { envelope: true, flags: true, bodyStructure: true }
    const messages = await withTimeout(
      client.fetchAll(pageUids, fetchOptions, { uid: true }),
      FETCH_TIMEOUT_MS
    )

    // Build a map for quick lookup
    const msgMap = new Map<number, any>()
    for (const msg of messages) {
      if (msg.uid) msgMap.set(msg.uid, msg)
    }
    if (msgMap.size === 0) return null

    const results: DirectEnvelope[] = []
    for (const uid of pageUids) {
      const msg = msgMap.get(uid)
      if (!msg || !msg.envelope) continue

      const env = msg.envelope
      const flags = msg.flags || []
      const struct = msg.bodyStructure

      // Extract size from BODYSTRUCTURE if available
      const size = struct?.size ?? 0

      // Parse addresses
      const parseAddresses = (addrs: any[]): Array<{ name: string | null; email: string }> => {
        if (!addrs) return []
        return addrs.map(a => ({
          name: a.name ? Buffer.from(a.name, 'binary').toString('utf8') : null,
          email: a.mailbox && a.host ? `${a.mailbox}@${a.host}` : ''
        })).filter(a => a.email)
      }

      // Parse date
      let dateStr = ''
      if (env.date) {
        try {
          dateStr = new Date(env.date).toISOString()
        } catch {
          dateStr = String(env.date)
        }
      }

      // Parse message-id
      const messageId = env.messageId || `no-message-id-${uid}`

      // Extract subject
      const subject = env.subject ? Buffer.from(env.subject, 'binary').toString('utf8') : '(no subject)'

      // Parse from/to
      const from = parseAddresses(env.from)
      const to = parseAddresses(env.to)

      results.push({
        id: String(uid),
        'message-id': messageId,
        flags: parseImapFlags(flags),
        subject,
        from,
        to,
        date: dateStr,
        size,
        'has-attachment': null,
      })
    }
    return results
  } catch (e) {
    logger.warn(`[email-imap] envelope list failed for account "${accountId}" mailbox="${mailbox}": ${e instanceof Error ? e.message : e}`)
    return null
  } finally {
    lock.release()
  }
}

// Exported for tests only -- not part of the module's real entry point.
export const _internal = { parseHimalayaToml, parseImapServer }
