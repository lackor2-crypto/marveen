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
import { logger } from '../logger.js'

const HIMALAYA_CONFIG = `${process.env.HOME}/.local/share/marveen-himalaya/config.toml`

export interface ImapAccountConfig {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
}

// A purpose-built, deliberately narrow TOML reader -- not a general parser.
// It only understands the exact dotted-key shape this install's config
// generator produces (see the file itself: `[accounts.X]` sections with
// `imap.server`, `imap.sasl.plain.username`, `imap.sasl.plain.password.command`).
// Anything it doesn't recognise for a given account simply yields no entry
// for that account, which the caller treats as "use himalaya for this
// account" -- so a config shape drift degrades gracefully instead of
// crashing the fast path.
function parseHimalayaToml(text: string): Map<string, Record<string, string>> {
  const accounts = new Map<string, Record<string, string>>()
  let current: Record<string, string> | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const section = /^\[accounts\.([^\]]+)\]$/.exec(line)
    if (section) {
      current = {}
      accounts.set(section[1]!, current)
      continue
    }
    if (line.startsWith('[')) { current = null; continue } // some other section (e.g. a future [general]) -- not an account
    if (!current) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    current[key] = value
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
      const parsed = await simpleParser(full.source, { skipHtmlToText: true })
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
      const synthetic = Buffer.concat([mime, content])
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

// Exported for tests only -- not part of the module's real entry point.
export const _internal = { parseHimalayaToml, parseImapServer }
