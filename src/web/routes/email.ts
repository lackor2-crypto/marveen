import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { simpleParser } from 'mailparser'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { readMessageBodyDirect, messageStillExists, listMailboxesDirect, listEnvelopesDirect } from '../email-imap.js'
import { buildHimalayaSearchArgs, normalizeEmailSearchQuery } from '../email-search.js'
import { isPromotionalEnvelope } from '../../email-promo-classify.js'
import { translateEmailContent } from '../email-translate.js'
import { getSecret } from '../vault.js'
import type { RouteContext } from './types.js'

// Per-install Himalaya CLI toolkit (binary + TOML config + per-account secret
// files) -- mirrors the ~/.local/share/marveen-voice/ convention. Never
// tracked in the repo: the config references secrets by path, the secrets
// themselves live in a 700-permission directory outside git entirely.
const HIMALAYA_BIN = `${process.env.HOME}/.local/bin/himalaya`
const HIMALAYA_CONFIG = `${process.env.HOME}/.local/share/marveen-himalaya/config.toml`
// Presence-only marker: revert readMessageBody() to the himalaya-only path
// with no rebuild/restart. `touch` to disable, `rm` to re-enable.
const IMAP_DIRECT_KILL_SWITCH = `${process.env.HOME}/.local/share/marveen-himalaya/disable-imap-direct`
// `message read` fetches the WHOLE message body over IMAP -- including every
// attachment's bytes -- regardless of --json/--raw or of whether the caller
// only wants the text/html part; himalaya has no "skip attachments" flag.
// A message with a large (tens of MB) attachment can take well past the old
// 20s timeout / 8MB buffer to come back, which failed silently and rendered
// as if the mail were simply empty (Boss, 2026-08-05: video attachment,
// "video, üres a törzs" -- root-caused live: `himalaya message read --raw`
// on that message took ~33s and produced ~31MB of output). Generous, not a
// performance fix -- large attachments are still slow, just no longer
// spuriously fail.
const TIMEOUT = 90_000

// The UI/route logic below is already account-parametrized -- adding an
// account here is just wiring its IMAP credentials into
// ~/.local/share/marveen-himalaya/config.toml (see lackor2/usalackor for the
// pattern). usalackor added 2026-08-06: the corporate account shared with
// Botond (freelance programmer, freeberischeaper), so his emails are
// readable here instead of Boss pasting them in manually.
//
// Derived fresh from config.toml on every call (not a hardcoded list, and
// not cached) -- the Iroda "Beallitasok" account-config POST route can add a
// brand new [accounts.X] block at runtime, and every caller here (nav list,
// isKnownAccount, ...) needs to see it immediately, not just after a
// restart. config.toml is a handful of lines; re-parsing it per request is
// not a real cost.
function getAccounts(): Array<{ id: string; label: string }> {
  try {
    const config = existsSync(HIMALAYA_CONFIG) ? (parseToml(readFileSync(HIMALAYA_CONFIG, 'utf8')) as any) : { accounts: {} }
    return Object.keys(config.accounts || {}).map(id => ({
      id,
      label: config.accounts[id]?.imap?.sasl?.plain?.username || id,
    }))
  } catch {
    return []
  }
}

function himalayaOnce(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(HIMALAYA_BIN, ['-c', HIMALAYA_CONFIG, ...args], { timeout: TIMEOUT, maxBuffer: 96 * 1024 * 1024 }, (err, stdout, stderr) => {
      // A timeout/maxBuffer kill leaves himalaya's own stdout/stderr empty
      // (the process never got to write an error of its own) -- fall back to
      // Node's own err.message/code so a caller sees "maxBuffer exceeded" or
      // "signal SIGTERM" instead of a bare, uninformative "himalaya failed"
      // (Boss, 2026-08-05: asked what the actual limit was after a large
      // attachment test -- this is the piece that would tell him next time).
      const fallback = err ? `${err.message}${'code' in err ? ` (${(err as NodeJS.ErrnoException).code})` : ''}` : ''
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || fallback })
    })
  })
}

// Every himalaya call opens a BRAND NEW IMAP/TLS connection from scratch
// (no persistent/pooled session) -- Gmail allows 15 concurrent IMAP
// connections per account, and under fast repeated use (folder-hopping,
// reopening messages) this occasionally trips that limit, surfacing as
// "Resource temporarily unavailable (os error 11)". Confirmed live
// 2026-08-05: the exact same command failed once, then succeeded twice in a
// row a few seconds later -- transient, not a real break. Researched first
// (Boss's standing rule): exponential backoff + jitter is the standard
// pattern for a transient provider-side throttle (same shape as retrying a
// 429) -- fixed-interval retries risk repeatedly landing on the same
// throttle window. Only used for read-only calls, where retrying is always
// safe (no risk of double-sending like a retried `message reply --send`
// would have).
const TRANSIENT_RETRY_ATTEMPTS = 2
const TRANSIENT_RETRY_BASE_MS = 400
function isTransientImapError(text: string): boolean {
  return /resource temporarily unavailable|os error 11/i.test(text)
}
async function himalayaRead(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let attempt = await himalayaOnce(args)
  for (let i = 0; i < TRANSIENT_RETRY_ATTEMPTS; i++) {
    if (attempt.ok || !isTransientImapError(attempt.stderr || attempt.stdout)) break
    const delay = TRANSIENT_RETRY_BASE_MS * 2 ** i + Math.random() * 200
    await new Promise(r => setTimeout(r, delay))
    attempt = await himalayaOnce(args)
  }
  return attempt
}
const himalaya = himalayaOnce

function isKnownAccount(id: string | null): boolean {
  return !!id && getAccounts().some(a => a.id === id)
}

function accountEmail(id: string): string {
  return getAccounts().find(a => a.id === id)?.label ?? ''
}

// === Iroda "Beallitasok" -> IMAP/SMTP account settings =====================
// Researched first (Boss's standing rule, 2026-08-06): a same-machine key
// can't defend a stored secret against full machine compromise -- that's the
// accepted limit for self-hosted single-user tools (Thunderbird/Roundcube
// have the identical constraint). AES-256-GCM with the key in a separate
// 0600 file is the realistic bar for this class of app, matching that
// prior art rather than reaching for cloud-KMS-grade infrastructure this
// single-user install has no use for.
//
// himalaya already supports a `password.command` secret backend (see
// config.toml today: `cat <plaintext secrets file>`) -- swapping that
// command to invoke scripts/email-secret.mjs's `decrypt` mode, instead of
// `cat`-ing a plaintext file, is the entire integration: himalaya itself
// needs zero changes, it just runs a different command and gets the
// password on stdout either way. The encrypt/decrypt cipher lives in that
// one script, invoked by both himalaya (decrypt, at IMAP/SMTP connect time)
// and this route (encrypt, when the Iroda settings form saves a password) --
// a single source of truth for the AES layout instead of duplicating it.
const __dirname = dirname(fileURLToPath(import.meta.url))
const EMAIL_SECRET_SCRIPT = join(__dirname, '../../../scripts/email-secret.mjs')
const EMAIL_SECRETS_ENC_DIR = `${process.env.HOME}/.local/share/marveen-himalaya/secrets-enc`

function hasEncryptedSecret(account: string): boolean {
  return existsSync(join(EMAIL_SECRETS_ENC_DIR, `${account}.enc`))
}

// Pipes the password over stdin only -- it must never appear in argv (a
// live `ps` on this machine already lists other himalaya invocations by
// their full command line; a password there would leak to anyone who can
// run `ps`).
function encryptAccountPassword(account: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [EMAIL_SECRET_SCRIPT, 'encrypt', account], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`))))
    child.stdin.write(password)
    child.stdin.end()
  })
}

// Researched first (himalaya's own config.sample.toml, github.com/pimalaya/himalaya):
// encryption is NOT just the imap(s)/smtp(s) URL scheme -- that alone can't
// tell "cleartext" and "STARTTLS-upgraded cleartext" apart, both use the
// plain imap://smtp:// scheme, distinguished only by a separate `starttls`
// boolean. A single TLS on/off checkbox would silently produce a truly
// unencrypted config for any provider needing STARTTLS on port 587 (common
// outside Gmail) -- so encryption is a 3-way mode, not a boolean.
type EmailEncryption = 'tls' | 'starttls' | 'none'
function encryptionToServerUrl(host: string, port: number, encryption: EmailEncryption, kind: 'imap' | 'smtp'): { server: string; starttls: boolean } {
  if (encryption === 'tls') return { server: `${kind}s://${host}:${port}`, starttls: false }
  return { server: `${kind}://${host}:${port}`, starttls: encryption === 'starttls' }
}
function serverUrlToEncryption(scheme: string, starttls: unknown): EmailEncryption {
  if (scheme === 'imaps' || scheme === 'smtps') return 'tls'
  return starttls === true ? 'starttls' : 'none'
}

type AccountConfigBody = {
  account?: string
  email?: string // new accounts only -- account id is derived from this, server-side
  isNew?: boolean
  imapHost?: string; imapPort?: number; imapEncryption?: EmailEncryption; imapUsername?: string
  smtpHost?: string; smtpPort?: number; smtpEncryption?: EmailEncryption; smtpUsername?: string
  password?: string
}

function parseServerUrl(serverUrl: unknown): { scheme: string; host: string; port: number } {
  const m = typeof serverUrl === 'string' ? /^(\w+):\/\/([^:]+):(\d+)$/.exec(serverUrl) : null
  return m ? { scheme: m[1], host: m[2], port: Number(m[3]) } : { scheme: '', host: '', port: 0 }
}

const VALID_ENCRYPTIONS = new Set(['tls', 'starttls', 'none'])
function validateAccountConfigBody(body: AccountConfigBody, isNew: boolean): string | null {
  if (!body.imapHost?.trim() || !body.imapPort || !body.imapUsername?.trim()) return 'IMAP host/port/felhasznalonev kotelezo'
  if (!body.smtpHost?.trim() || !body.smtpPort || !body.smtpUsername?.trim()) return 'SMTP host/port/felhasznalonev kotelezo'
  if (!Number.isInteger(body.imapPort) || body.imapPort < 1 || body.imapPort > 65535) return 'Ervenytelen IMAP port'
  if (!Number.isInteger(body.smtpPort) || body.smtpPort < 1 || body.smtpPort > 65535) return 'Ervenytelen SMTP port'
  if (body.imapEncryption && !VALID_ENCRYPTIONS.has(body.imapEncryption)) return 'Ervenytelen IMAP titkositas'
  if (body.smtpEncryption && !VALID_ENCRYPTIONS.has(body.smtpEncryption)) return 'Ervenytelen SMTP titkositas'
  if (isNew && !body.password?.trim()) return 'Uj fioknal a jelszo kotelezo'
  return null
}

// New-account ids are derived from the typed email address server-side
// (never trust a client-supplied id outright) -- lowercased, non-alphanumeric
// collapsed to underscores, so "Someone@Example.com" and a stray space both
// land on the same predictable id instead of himalaya seeing two subtly
// different account names.
function slugifyAccountId(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

// Builds the FULL updated config (every account, not just the one being
// edited) by merging the edited account's block into whatever config.toml
// already parses to -- so saving one account's settings can never drop
// another account's block. Reuses the existing password.command untouched
// when the form didn't submit a new password (so editing just the host/port
// never requires re-entering a password that hasn't changed).
async function buildUpdatedTomlConfig(account: string, body: AccountConfigBody): Promise<{ toml: string; passwordChanged: boolean }> {
  const existing = existsSync(HIMALAYA_CONFIG) ? (parseToml(readFileSync(HIMALAYA_CONFIG, 'utf8')) as any) : { accounts: {} }
  const existingAccount = existing.accounts?.[account] || {}
  const passwordChanged = !!body.password
  if (passwordChanged) await encryptAccountPassword(account, body.password as string)
  const passwordCommand = passwordChanged
    ? `node ${EMAIL_SECRET_SCRIPT} decrypt ${account}`
    : (existingAccount.imap?.sasl?.plain?.password?.command || existingAccount.smtp?.sasl?.plain?.password?.command)
  if (!passwordCommand) throw new Error('nincs mentett jelszo -- eloszor add meg a jelszot')
  const imapUrl = encryptionToServerUrl(body.imapHost as string, body.imapPort as number, body.imapEncryption || 'tls', 'imap')
  const smtpUrl = encryptionToServerUrl(body.smtpHost as string, body.smtpPort as number, body.smtpEncryption || 'tls', 'smtp')
  const updatedAccount = {
    ...existingAccount,
    mailbox: existingAccount.mailbox || { alias: { inbox: 'Inbox' } },
    imap: { server: imapUrl.server, starttls: imapUrl.starttls, sasl: { plain: { username: body.imapUsername, password: { command: passwordCommand } } } },
    smtp: { server: smtpUrl.server, starttls: smtpUrl.starttls, sasl: { plain: { username: body.smtpUsername, password: { command: passwordCommand } } } },
  }
  const updated = { ...existing, accounts: { ...existing.accounts, [account]: updatedAccount } }
  return { toml: stringifyToml(updated), passwordChanged }
}

// Runs a cheap, read-only IMAP probe against a CANDIDATE config (a temp file,
// never the live one) before anything real gets overwritten -- a typo'd
// host/port/password fails against the sandbox copy, live email keeps
// working, and the user sees the actual himalaya error instead of a
// silently broken account discovered next time mail is opened.
async function testAccountConfigToml(account: string, toml: string): Promise<{ ok: boolean; error?: string }> {
  const work = mkdtempSync(join(tmpdir(), 'marveen-email-test-'))
  const configPath = join(work, 'config.toml')
  try {
    writeFileSync(configPath, toml, { mode: 0o600 })
    return await new Promise((resolve) => {
      execFile(HIMALAYA_BIN, ['-c', configPath, '-a', account, 'envelope', 'list', '-m', 'Inbox', '--page-size', '1', '--json'],
        { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) { resolve({ ok: false, error: (stderr || stdout || err.message || '').toString().slice(0, 500) }); return }
          resolve({ ok: true })
        })
    })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Persistent, per-install disk cache for downloaded attachment bytes --
// unlike the in-memory message-body cache above, attachment bytes can be
// tens of MB each, so this lives on disk (same per-install convention as
// HIMALAYA_CONFIG, never git-tracked) instead of RAM. Before this, every
// single open of a large attachment (preview, "Nagyítás", "Letöltés") re-ran
// `himalaya attachment download` from scratch, even for the SAME attachment
// moments apart -- Boss, 2026-08-05, re-opened a message with a 22MB video
// and watched it redownload: "ez nonsensz... akkor mar azonnal be tud
// jonni". An attachment's bytes are immutable once sent, so this is safe to
// keep indefinitely, bounded by ATTACHMENT_CACHE_MAX_BYTES total (evicts
// oldest-by-mtime first) rather than a TTL.
const ATTACHMENT_CACHE_DIR = `${process.env.HOME}/.local/share/marveen-himalaya/attachment-cache`
// Boss, 2026-08-05: has ~400GB free locally, asked why cap this at just
// 2GB instead of something that actually uses the room he has -- fair, 2GB
// was an arbitrary starting guess, not tied to any real constraint. 50GB
// leaves the machine's disk overwhelmingly free either way.
const ATTACHMENT_CACHE_MAX_BYTES = 50 * 1024 * 1024 * 1024 // 50GB
function attachmentCacheKey(account: string, mailbox: string, id: string, attachmentId: string): string {
  return createHash('sha1').update(`${account}::${mailbox}::${id}::${attachmentId}`).digest('hex')
}
function attachmentCachePaths(key: string): { bin: string; meta: string } {
  return { bin: join(ATTACHMENT_CACHE_DIR, `${key}.bin`), meta: join(ATTACHMENT_CACHE_DIR, `${key}.json`) }
}
// Evicts oldest-by-mtime entries once the cache exceeds its byte budget --
// called after writing a new entry, not before, so a single very large
// attachment can still be cached even from an empty/near-empty cache.
// `protect` is the entry just written this request -- without excluding it,
// a single attachment bigger than the whole budget (Boss asked exactly this:
// "mi van ha egy 2.5GB-os videot kapok?") would evict every OTHER file and
// then, still over budget with nothing else left to remove, evict the file
// this very request is about to serve out from under itself.
function pruneAttachmentCache(protect: string): void {
  try {
    const files = readdirSync(ATTACHMENT_CACHE_DIR)
      .filter(name => name.endsWith('.bin') && name !== protect)
      .map(name => {
        const p = join(ATTACHMENT_CACHE_DIR, name)
        const stat = statSync(p)
        return { path: p, metaPath: join(ATTACHMENT_CACHE_DIR, name.replace(/\.bin$/, '.json')), size: stat.size, mtime: stat.mtimeMs }
      })
      .sort((a, b) => a.mtime - b.mtime)
    const protectedSize = existsSync(join(ATTACHMENT_CACHE_DIR, protect)) ? statSync(join(ATTACHMENT_CACHE_DIR, protect)).size : 0
    let total = protectedSize + files.reduce((sum, f) => sum + f.size, 0)
    for (const f of files) {
      if (total <= ATTACHMENT_CACHE_MAX_BYTES) break
      rmSync(f.path, { force: true })
      rmSync(f.metaPath, { force: true })
      total -= f.size
    }
  } catch { /* best-effort housekeeping, never block a request on it */ }
}
// A permanently-deleted message (Törlés from within Kuka -- gone for good,
// not just moved) shouldn't leave its attachment(s) sitting in the cache
// forever waiting for size-based eviction (Boss, 2026-08-05: "ha törli
// valaki... akkor ott is törölni kell, hogy ne halmozódjon fel"). Meta files
// carry the plaintext account/mailbox/id (the .bin/.json filenames are just
// a hash, not reversible), so this is a directory scan, not a key lookup --
// fine at this cache's expected size (a handful to a few dozen entries).
function purgeAttachmentCacheForMessage(account: string, mailbox: string, id: string): void {
  try {
    for (const name of readdirSync(ATTACHMENT_CACHE_DIR)) {
      if (!name.endsWith('.json')) continue
      const metaPath = join(ATTACHMENT_CACHE_DIR, name)
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { account?: string; mailbox?: string; id?: string }
        if (meta.account === account && meta.mailbox === mailbox && meta.id === id) {
          rmSync(metaPath, { force: true })
          rmSync(join(ATTACHMENT_CACHE_DIR, name.replace(/\.json$/, '.bin')), { force: true })
        }
      } catch { /* skip an unreadable/corrupt entry, don't let it block the rest */ }
    }
  } catch { /* cache dir may not exist yet -- nothing to purge */ }
}

// Gmail's own Sent folder -- same hardcoded-Gmail-path precedent as the
// Trash/"[Gmail]/Kuka" handling in the delete/archive routes below.
const SENT_MAILBOX = '[Gmail]/Elküldött levelek'
const IMPORTANT_MAILBOX = '[Gmail]/Fontos'

// Mirrors the frontend's EMAIL_SYSTEM_MAILBOX_ORDER (web/app.js) -- Gmail's
// own built-in folders, never user labels. The label-delete route (below)
// must never be able to touch these: an IMAP DELETE on one of them doesn't
// just remove a label, it breaks Gmail's own IMAP folder structure, and
// there's no undo (Boss, 2026-08-05: added label delete precisely so custom
// labels could be cleaned up from the dashboard -- system folders were
// never meant to be selectable in that UI, this is the backend backstop in
// case that ever slips).
const SYSTEM_MAILBOXES = new Set([
  'Inbox',
  SENT_MAILBOX,
  '[Gmail]/Piszkozatok',
  '[Gmail]/Spam',
  '[Gmail]/Kuka',
  IMPORTANT_MAILBOX,
  '[Gmail]/Csillagozott',
  '[Gmail]/Beszélgetések',
  '[Gmail]/Összes levél',
])

// Gmail's IMAP has no THREAD extension (RFC 5256) and himalaya has no
// Gmail-JMAP-thread-id lookup wired in, so conversation grouping is
// approximated by normalized subject alone -- matches Gmail's own behavior
// of keeping a forward chained to the original thread even when it goes to
// a brand-new third party (Boss, 2026-08-05).
function normalizeThreadSubject(subject: string): string {
  let s = (subject || '').trim()
  // Repeat: "Re: Fwd: AW: WG: ..." chains can stack from multiple hops.
  while (/^(re|fwd|fw|aw|wg)\s*:\s*/i.test(s)) {
    s = s.replace(/^(re|fwd|fw|aw|wg)\s*:\s*/i, '')
  }
  return s.trim().toLowerCase()
}

// Short-TTL caches for the two hottest, most-repeated read calls (mailbox
// list on every sidebar render, envelope list on every folder open) --
// Boss, 2026-08-05: "ha háttér-cacheled... akkor be is gyorsulna a
// menüpontokban való átkattintás is." Folder-hopping back and forth (Inbox
// -> label -> Inbox) previously re-ran a fresh IMAP round-trip every single
// time; now a repeat within the TTL is served from memory, instant, and
// doesn't count against Gmail's connection throttle at all.
//
// Mailbox list: himalaya's `mailbox list --json` always reports
// total/unread as null on this account (verified live) -- the ONLY thing
// that actually changes it is a label being created/deleted, which this
// route already handles explicitly, so its TTL can be long.
// Envelope list: message flags (seen/starred/important) and membership
// (delete/archive/move) DO change what a mailbox listing should show, so
// its TTL is short AND every mutating route below explicitly evicts the
// affected (account, mailbox) entry rather than waiting out the TTL.
const MAILBOX_LIST_TTL_MS = 5 * 60_000
const ENVELOPE_LIST_TTL_MS = 20_000
type CacheEntry<T> = { data: T; expires: number }
const mailboxListCache = new Map<string, CacheEntry<unknown[]>>()
const envelopeListCache = new Map<string, CacheEntry<unknown[]>>()

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expires) { cache.delete(key); return undefined }
  return entry.data
}
function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T, ttlMs: number): void {
  cache.set(key, { data, expires: Date.now() + ttlMs })
}
// Envelope list is paginated (`-p`) -- a mutation doesn't know which page(s)
// the frontend currently has open, so every cached page for this
// (account, mailbox) is dropped rather than tracking pages individually.
function invalidateEnvelopeCache(account: string, mailbox: string): void {
  const prefix = `${account}::${mailbox}::`
  for (const key of envelopeListCache.keys()) {
    if (key.startsWith(prefix)) envelopeListCache.delete(key)
  }
}

// A message's text/html/attachment-list is immutable once sent (only flags
// like read/starred change, which live in the separate envelope/flags
// endpoints, never touched here) -- so the CONTENT never needs invalidating.
// Its EXISTENCE at this (account, mailbox, id) key can still change though:
// delete/archive routes below purge the entry explicitly, same pattern as
// purgeAttachmentCacheForMessage. That only covers deletes made through
// Marveen itself -- a message removed straight from Gmail's own web client
// (Boss, 2026-08-06: deleted a lottery-spam mail in Gmail, F5-refreshed
// Marveen, the now-gone mail still rendered in the reader pane "like it was
// never deleted") leaves no signal here at all, so MESSAGE_BODY_CACHE_TTL_MS
// is the backstop for that case -- long enough to keep the reopen-instant
// win (re-opening a message with a 22MB video attachment used to re-run the
// whole 30-90s himalaya fetch, "ez nonsensz, ha mar egyszer letoltotte...
// akkor mar azonnal be tud jonni") within one working session, short enough
// that a ghost entry can't outlive it indefinitely. Small LRU-ish cap
// (insertion order = recency; a cache hit is deleted+re-set to bump it) on
// top -- a handful of large-attachment messages is the realistic worst case
// for one account's session, not worth a byte-budget tracker.
const MESSAGE_BODY_CACHE_MAX = 20
const MESSAGE_BODY_CACHE_TTL_MS = 15 * 60_000
type MessageBody = { text: string; html: string; attachments: Array<{ id: string; filename: string; mime: string; size: number; inline?: boolean }> }
const messageBodyCache = new Map<string, { data: MessageBody; expires: number }>()
function messageBodyCacheKey(account: string, mailbox: string, id: string): string {
  return `${account}::${mailbox}::${id}`
}
// Mirrors purgeAttachmentCacheForMessage: a message that's been removed
// (deleted or archived, not just re-read) shouldn't keep serving its old
// body from cache under this (account, mailbox, id) key.
function purgeMessageBodyCache(account: string, mailbox: string, id: string): void {
  messageBodyCache.delete(messageBodyCacheKey(account, mailbox, id))
}

async function readMessageBody(account: string, mailbox: string, id: string): Promise<
  { text: string; html: string; attachments: Array<{ id: string; filename: string; mime: string; size: number; inline?: boolean }> } | { error: string; notFound?: boolean }
> {
  const cacheKey = messageBodyCacheKey(account, mailbox, id)
  const cached = messageBodyCache.get(cacheKey)
  if (cached) {
    if (Date.now() <= cached.expires) {
      // A cache hit only proves the body was real WHEN IT WAS FETCHED -- the
      // message can have been deleted since, including entirely outside
      // Marveen (straight in Gmail's own web client), which leaves no local
      // signal to purge on. So a hit still pays for one cheap UID-only
      // existence probe before being trusted (Boss, 2026-08-06: deleted a
      // mail in Gmail, F5-refreshed Marveen, the reader pane kept showing it
      // -- a bare TTL alone wasn't enough, this was well inside the window).
      // Only a CONFIRMED-gone result evicts the entry; any other outcome
      // (timeout, connection blip) trusts the cache exactly like before.
      if (await messageStillExists(account, mailbox, id)) {
        // Bump recency: delete + re-set moves it to the end of Map's
        // insertion order, which the eviction below reads as "most recently
        // used".
        messageBodyCache.delete(cacheKey)
        messageBodyCache.set(cacheKey, cached)
        return cached.data
      }
      messageBodyCache.delete(cacheKey)
      return { error: 'A levél már nem érhető el.', notFound: true }
    }
    messageBodyCache.delete(cacheKey)
    // Expired -- fall through and re-fetch fresh instead of trusting a body
    // that may no longer exist server-side.
  }

  // Direct-IMAP fast path (2026-08-06): himalaya's `message read` below
  // always downloads the WHOLE message including attachment bytes -- see the
  // comment on that call for the incident that documented it. email-imap.ts
  // fetches only the BODYSTRUCTURE + the text/html MIME parts via IMAP
  // BODY.PEEK, so a message with a 22MB video attachment now returns its
  // text in ~1-2s instead of ~30-90s (live-measured). Kill switch: create
  // ~/.local/share/marveen-himalaya/disable-imap-direct to revert to the
  // himalaya-only path below with no rebuild/restart -- a marker file, not an
  // env var, because .env values never reach process.env in this process
  // (see src/config.ts). readMessageBodyDirect() returns null on ANY
  // failure (unsupported message shape, connection error, timeout, ...) and
  // never throws, so falling through to the unchanged himalaya path below is
  // always safe -- this can only make a message load AS SLOW AS today, never
  // slower, never broken.
  if (!existsSync(IMAP_DIRECT_KILL_SWITCH)) {
    const t0 = Date.now()
    const direct = await readMessageBodyDirect(account, mailbox, id)
    if (direct) {
      const result = { text: direct.text, html: direct.html, attachments: direct.attachments.filter(a => !a.inline) }
      logger.info(`[email] imap body uid=${id} mailbox=${mailbox} parts=${direct.attachments.length} ms=${Date.now() - t0}`)
      messageBodyCache.set(cacheKey, { data: result, expires: Date.now() + MESSAGE_BODY_CACHE_TTL_MS })
      if (messageBodyCache.size > MESSAGE_BODY_CACHE_MAX) {
        const oldest = messageBodyCache.keys().next().value
        if (oldest !== undefined) messageBodyCache.delete(oldest)
      }
      return result
    }
    logger.warn(`[email] direct IMAP body fetch unavailable for uid=${id} mailbox=${mailbox}, falling back to himalaya`)
    // The direct path returns null both for "message is gone" and for other
    // failures (unsupported shape, timeout, ...) -- disambiguate with the same
    // cheap existence probe used for cache-hit revalidation above, so a
    // deleted message reports as gone instead of running the full (and, for
    // a gone message, pointless) himalaya fallback below only to fail there
    // too with a raw command-error string.
    if (!(await messageStillExists(account, mailbox, id))) {
      return { error: 'A levél már nem érhető el.', notFound: true }
    }
  }

  // FALLBACK PATH: only reached when the direct-IMAP fast path above is
  // disabled (kill switch) or returned null for this message. himalaya's
  // `message read` always fetches the whole body over IMAP no matter the
  // output format -- there's no "text only" mode -- which is exactly why
  // email-imap.ts's BODYSTRUCTURE + BODY.PEEK path exists. This block is kept
  // as-is, not a performance fix: large attachments are still slow here, just
  // no longer the ONLY path, and no longer spuriously failing outright.
  //
  // `--raw` (RFC 5322 source, base64 for binary parts, ~1.37x the original
  // attachment size) instead of `--json` (himalaya's parsed struct, which
  // serializes attachment bytes as a JSON array of decimal numbers -- ~3.67x
  // the original size, measured live on a 22MB attachment: 81MB of JSON).
  // Parsed here with `mailparser` instead of relying on himalaya's own JSON
  // shape. This lifts the maxBuffer ceiling from ~25MB of attachment to
  // ~65-70MB (Boss, 2026-08-05: a 22MB video attachment nearly filled the old
  // 96MB buffer at the 3.67x rate; this format leaves real headroom at the
  // same buffer size).
  //
  // Run alongside `attachment list` (already a separate, himalaya-native-id
  // call, needed for /api/email/attachment downloads to work) rather than
  // after it -- `attachment list` ALSO independently re-fetches the whole
  // body internally (confirmed live: ~37s for that same 22MB message, not
  // the "cheap, structure-only" call its help text implies), so running
  // them sequentially would double the wait for every large-attachment
  // message. In parallel, total wait stays bounded by the slower of the two.
  const [bodyR, attR] = await Promise.all([
    himalayaRead(['-a', account, 'message', 'read', id, '-m', mailbox, '--raw']),
    himalayaRead(['-a', account, 'attachment', 'list', id, '-m', mailbox, '--json']),
  ])
  if (!bodyR.ok) { logger.warn(`[email] message read failed: ${bodyR.stderr || bodyR.stdout}`); return { error: bodyR.stderr || bodyR.stdout || 'himalaya failed' } }
  let text = ''
  let html = ''
  try {
    const parsed = await simpleParser(bodyR.stdout, { skipHtmlToText: true })
    text = parsed.text || ''
    html = typeof parsed.html === 'string' ? parsed.html : ''
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'unparseable message' }
  }
  // Attachment listing is best-effort: a message with no attachments (the
  // common case) makes this command fail or return an empty list depending
  // on himalaya version -- either way we still want to show the body, so a
  // failure here degrades to "no attachments" instead of failing the load.
  // IDs here come from himalaya's OWN attachment-list call, not from
  // mailparser's parse of the same message -- /api/email/attachment download
  // passes this id straight to `himalaya attachment download`, which expects
  // himalaya's "position in mail_parser's iteration order" numbering; a
  // different MIME parser (mailparser) could order/classify parts
  // differently on edge-case messages, and a mismatched id would silently
  // download the WRONG attachment.
  let attachments: Array<{ id: string; filename: string; mime: string; size: number; inline?: boolean }> = []
  if (attR.ok) {
    // Same inline filter as /api/email/attachments-flags -- signature logos
    // and other cid:-referenced body images aren't real attachments.
    try { attachments = (JSON.parse(attR.stdout).attachments || []).filter((a: { inline?: boolean }) => !a.inline) } catch { /* no-op, keep empty */ }
  }
  const result = { text, html, attachments }
  messageBodyCache.set(cacheKey, { data: result, expires: Date.now() + MESSAGE_BODY_CACHE_TTL_MS })
  if (messageBodyCache.size > MESSAGE_BODY_CACHE_MAX) {
    const oldest = messageBodyCache.keys().next().value
    if (oldest !== undefined) messageBodyCache.delete(oldest)
  }
  return result
}

export async function tryHandleEmail(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/email/accounts' && method === 'GET') {
    json(res, getAccounts())
    return true
  }

  if (path === '/api/email/account-config' && method === 'GET') {
    const account = url.searchParams.get('account')
    if (!isKnownAccount(account)) { json(res, { error: 'unknown account' }, 400); return true }
    try {
      const config = existsSync(HIMALAYA_CONFIG) ? (parseToml(readFileSync(HIMALAYA_CONFIG, 'utf8')) as any) : { accounts: {} }
      const acc = config.accounts?.[account as string]
      if (!acc) { json(res, { error: 'fiok nem talalhato a config-ban' }, 404); return true }
      const imap = parseServerUrl(acc.imap?.server)
      const smtp = parseServerUrl(acc.smtp?.server)
      json(res, {
        account,
        imapHost: imap.host, imapPort: imap.port, imapEncryption: serverUrlToEncryption(imap.scheme, acc.imap?.starttls),
        imapUsername: acc.imap?.sasl?.plain?.username || '',
        smtpHost: smtp.host, smtpPort: smtp.port, smtpEncryption: serverUrlToEncryption(smtp.scheme, acc.smtp?.starttls),
        smtpUsername: acc.smtp?.sasl?.plain?.username || '',
        hasStoredPassword: hasEncryptedSecret(account as string) || !!acc.imap?.sasl?.plain?.password?.command,
      })
    } catch (err) {
      logger.warn(`[email] account-config read failed: ${err}`)
      json(res, { error: 'nem sikerult beolvasni a konfiguraciot' }, 500)
    }
    return true
  }

  // Test-only: builds the same candidate TOML as a save would and runs the
  // himalaya probe against it, but never writes to the real config or
  // touches the encrypted secret store unless the caller then calls the
  // save endpoint below. Lets the "Kapcsolat tesztelese" button in the UI
  // validate before committing to anything.
  if (path === '/api/email/account-config/test' && method === 'POST') {
    const raw = await readBody(req)
    let body: AccountConfigBody
    try { body = JSON.parse(raw.toString()) } catch { json(res, { error: 'ervenytelen JSON' }, 400); return true }
    const isNew = !!body.isNew
    if (isNew) {
      const slug = slugifyAccountId(body.email || '')
      if (!slug) { json(res, { error: 'ervenytelen email cim' }, 400); return true }
      body.account = slug
    } else if (!isKnownAccount(body.account ?? null)) {
      json(res, { error: 'unknown account' }, 400); return true
    }
    const validationError = validateAccountConfigBody(body, isNew)
    if (validationError) { json(res, { error: validationError }, 400); return true }
    try {
      // A test never wants to permanently overwrite the real encrypted
      // secret just because "Kapcsolat tesztelese" was clicked -- only a
      // real save should do that. If a new password was typed, encrypt it
      // under a throwaway account id so the probe can still use it, and
      // clean that up either way afterward.
      const testAccountId = body.password ? `${body.account}__test__` : (body.account as string)
      let toml: string
      if (body.password) {
        await encryptAccountPassword(testAccountId, body.password)
        const imapUrl = encryptionToServerUrl(body.imapHost as string, body.imapPort as number, body.imapEncryption || 'tls', 'imap')
        const smtpUrl = encryptionToServerUrl(body.smtpHost as string, body.smtpPort as number, body.smtpEncryption || 'tls', 'smtp')
        const passwordCommand = `node ${EMAIL_SECRET_SCRIPT} decrypt ${testAccountId}`
        toml = stringifyToml({
          accounts: {
            [testAccountId]: {
              mailbox: { alias: { inbox: 'Inbox' } },
              imap: { server: imapUrl.server, starttls: imapUrl.starttls, sasl: { plain: { username: body.imapUsername, password: { command: passwordCommand } } } },
              smtp: { server: smtpUrl.server, starttls: smtpUrl.starttls, sasl: { plain: { username: body.smtpUsername, password: { command: passwordCommand } } } },
            },
          },
        })
      } else {
        const built = await buildUpdatedTomlConfig(body.account as string, body)
        toml = built.toml
      }
      const result = await testAccountConfigToml(testAccountId, toml)
      if (body.password) rmSync(join(EMAIL_SECRETS_ENC_DIR, `${testAccountId}.enc`), { force: true })
      json(res, result)
    } catch (err: any) {
      json(res, { ok: false, error: err?.message || 'teszt sikertelen' }, 200)
    }
    return true
  }

  if (path === '/api/email/account-config' && method === 'POST') {
    const raw = await readBody(req)
    let body: AccountConfigBody
    try { body = JSON.parse(raw.toString()) } catch { json(res, { error: 'ervenytelen JSON' }, 400); return true }
    const isNew = !!body.isNew
    if (isNew) {
      const slug = slugifyAccountId(body.email || '')
      if (!slug) { json(res, { error: 'ervenytelen email cim' }, 400); return true }
      if (isKnownAccount(slug)) { json(res, { error: 'mar letezik ilyen fiok' }, 409); return true }
      body.account = slug
    } else if (!isKnownAccount(body.account ?? null)) {
      json(res, { error: 'unknown account' }, 400); return true
    }
    const validationError = validateAccountConfigBody(body, isNew)
    if (validationError) { json(res, { error: validationError }, 400); return true }
    const account = body.account as string
    try {
      const { toml } = await buildUpdatedTomlConfig(account, body)
      const testResult = await testAccountConfigToml(account, toml)
      if (!testResult.ok) { json(res, { ok: false, error: testResult.error || 'kapcsolat teszt sikertelen, nincs mentve' }); return true }
      // Backup before overwrite -- belt-and-suspenders alongside the
      // pre-write connection test, in case of a bug in the TOML merge logic
      // itself rather than a bad credential.
      if (existsSync(HIMALAYA_CONFIG)) {
        writeFileSync(`${HIMALAYA_CONFIG}.bak-${Date.now()}`, readFileSync(HIMALAYA_CONFIG))
      }
      writeFileSync(HIMALAYA_CONFIG, toml, { mode: 0o600 })
      json(res, { ok: true })
    } catch (err: any) {
      logger.warn(`[email] account-config save failed: ${err}`)
      json(res, { ok: false, error: err?.message || 'mentes sikertelen' }, 200)
    }
    return true
  }

  if (path === '/api/email/mailboxes' && method === 'GET') {
    const account = url.searchParams.get('account')
    if (!isKnownAccount(account)) { json(res, { error: 'unknown account' }, 400); return true }
    const cached = cacheGet(mailboxListCache, account as string)
    if (cached) { json(res, cached); return true }
    // Strangler fig: try IMAP direct path first, fall back to himalaya on any failure
    if (!existsSync(IMAP_DIRECT_KILL_SWITCH)) {
      const direct = await listMailboxesDirect(account as string)
      if (direct) {
        cacheSet(mailboxListCache, account as string, direct, MAILBOX_LIST_TTL_MS)
        json(res, direct)
        return true
      }
    }
    const r = await himalayaRead(['-a', account as string, 'mailbox', 'list', '--json'])
    if (!r.ok) { logger.warn(`[email] mailbox list failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    try {
      const parsed = JSON.parse(r.stdout)
      const mailboxes = parsed.mailboxes || []
      cacheSet(mailboxListCache, account as string, mailboxes, MAILBOX_LIST_TTL_MS)
      json(res, mailboxes)
    } catch {
      json(res, { error: 'unparseable himalaya output' }, 502)
    }
    return true
  }

  if (path === '/api/email/mailboxes' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; name?: string }
    if (!isKnownAccount(data.account ?? null) || !data.name?.trim()) { json(res, { error: 'account and name required' }, 400); return true }
    // Raw IMAP CREATE (RFC 3501) -- `himalaya mailbox` only lists, it has no
    // create/delete/rename subcommand. Gmail treats an IMAP mailbox 1:1 with
    // a label, so this is the same as adding a label from Gmail's own UI.
    const r = await himalaya(['-a', data.account as string, 'imap', 'create', data.name.trim()])
    if (!r.ok) { logger.warn(`[email] mailbox create failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    mailboxListCache.delete(data.account as string)
    json(res, { ok: true })
    return true
  }

  // DELETE /api/email/mailboxes -- removes a custom Gmail label (IMAP DELETE,
  // RFC 3501, same "mailbox == label" equivalence as the create route above).
  // Irreversible and never allowed on a system folder (see SYSTEM_MAILBOXES).
  if (path === '/api/email/mailboxes' && method === 'DELETE') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; names?: unknown }
    const names = Array.isArray(data.names) ? data.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0) : []
    if (!isKnownAccount(data.account ?? null) || !names.length) { json(res, { error: 'account and names required' }, 400); return true }
    if (names.some(n => SYSTEM_MAILBOXES.has(n))) { json(res, { error: 'system mailbox cannot be deleted' }, 400); return true }
    const results = await Promise.all(names.map(async name => {
      const r = await himalaya(['-a', data.account as string, 'imap', 'delete', name])
      if (!r.ok) logger.warn(`[email] mailbox delete failed (${name}): ${r.stderr || r.stdout}`)
      return { name, ok: r.ok }
    }))
    if (results.some(r => !r.ok)) { json(res, { error: 'Néhány címke törlése nem sikerült', results }, 502); return true }
    mailboxListCache.delete(data.account as string)
    json(res, { ok: true })
    return true
  }

  if (path === '/api/email/envelopes' && method === 'GET') {
    const account = url.searchParams.get('account')
    const mailbox = url.searchParams.get('mailbox') || 'Inbox'
    const page = parseInt(url.searchParams.get('page') || '1', 10)
    const pageSize = 50
    const query = normalizeEmailSearchQuery(url.searchParams.get('q'))
    // Promóciók view (kanban 8449bbac): Gmail's Promotions category isn't an
    // IMAP folder, so it's a rule-based filter over the Inbox listing rather
    // than a separate mailbox -- promoOnly=1 shows ONLY the matches, and the
    // normal Inbox listing (promoOnly unset) excludes them so they stop
    // showing up mixed into the regular inbox. Only applies to Inbox; other
    // mailboxes (Sent, labels, ...) are returned unfiltered regardless of the
    // param, since the heuristic was only ever validated against Inbox mail.
    const promoOnly = url.searchParams.get('promoOnly') === '1'
    if (!isKnownAccount(account)) { json(res, { error: 'unknown account' }, 400); return true }
    const envelopeCacheKey = `${account}::${mailbox}::${page}::${query}::${mailbox === 'Inbox' ? (promoOnly ? 'promo' : 'nopromo') : 'all'}`
    const cachedEnvelopes = cacheGet(envelopeListCache, envelopeCacheKey)
    if (cachedEnvelopes) { json(res, cachedEnvelopes); return true }
    // Strangler fig: try IMAP direct path first, fall back to himalaya on any failure
    if (!existsSync(IMAP_DIRECT_KILL_SWITCH)) {
      const direct = await listEnvelopesDirect(account as string, mailbox, page, pageSize, query || undefined)
      if (direct) {
        let envelopes = direct
        if (mailbox === 'Inbox') {
          envelopes = envelopes.filter((e: unknown) => isPromotionalEnvelope(e as Parameters<typeof isPromotionalEnvelope>[0]) === promoOnly)
        }
        cacheSet(envelopeListCache, envelopeCacheKey, envelopes, ENVELOPE_LIST_TTL_MS)
        json(res, envelopes)
        return true
      }
    }
    const envelopeCommand = query ? ['envelope', 'search'] : ['envelope', 'list']
    const searchArgs = query ? buildHimalayaSearchArgs(query) : []
    const r = await himalayaRead(['-a', account as string, ...envelopeCommand, '-m', mailbox, '-p', String(page), '-s', '50', '--json', ...searchArgs])
    if (!r.ok) { logger.warn(`[email] envelope list failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    try {
      const parsed = JSON.parse(r.stdout)
      let envelopes = parsed.envelopes || []
      if (mailbox === 'Inbox') {
        envelopes = envelopes.filter((e: unknown) => isPromotionalEnvelope(e as Parameters<typeof isPromotionalEnvelope>[0]) === promoOnly)
      }
      cacheSet(envelopeListCache, envelopeCacheKey, envelopes, ENVELOPE_LIST_TTL_MS)
      json(res, envelopes)
    } catch {
      json(res, { error: 'unparseable himalaya output' }, 502)
    }
    return true
  }

  // POST /api/email/attachments-flags -- Boss 2026-08-05: wants a paperclip
  // marker in the envelope list. himalaya's envelope JSON always reports
  // has-attachment=null (not populated by this backend), so the only way to
  // know is one `attachment list` call per message -- too slow to do inline
  // with the envelope list render, hence a separate bulk lookup the frontend
  // fires after the list is already on screen. Runs with bounded concurrency
  // so a 50-message page doesn't spawn 50 himalaya processes at once.
  if (path === '/api/email/attachments-flags' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; ids?: unknown }
    if (!isKnownAccount(data.account ?? null) || !Array.isArray(data.ids)) { json(res, { error: 'account and ids required' }, 400); return true }
    const mailbox = data.mailbox || 'Inbox'
    const ids = data.ids.filter((x): x is string => typeof x === 'string').slice(0, 50)
    const CONCURRENCY = 6
    const result: Record<string, boolean> = {}
    let cursor = 0
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++]
        const r = await himalayaRead(['-a', data.account as string, 'attachment', 'list', id, '-m', mailbox, '--json'])
        if (r.ok) {
          // Inline parts (signature logos, tracking pixels referenced by the
          // HTML body via cid:) come back in this list too -- only count real,
          // non-inline attachments so the paperclip doesn't light up on every
          // marketing email with an embedded logo.
          try { result[id] = ((JSON.parse(r.stdout).attachments || []) as Array<{ inline?: boolean }>).some(a => !a.inline) } catch { result[id] = false }
        } else {
          result[id] = false
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker))
    json(res, result)
    return true
  }

  if (path === '/api/email/message' && method === 'GET') {
    const account = url.searchParams.get('account')
    const mailbox = url.searchParams.get('mailbox') || 'Inbox'
    const id = url.searchParams.get('id')
    if (!isKnownAccount(account) || !id) { json(res, { error: 'account and id required' }, 400); return true }
    const body = await readMessageBody(account as string, mailbox, id)
    if ('error' in body) { json(res, { error: body.error, notFound: body.notFound }, 502); return true }
    json(res, body)
    return true
  }

  // Whether each message is in the Gmail "Fontos" (Important) label -- not a
  // flag, so it isn't in the normal envelope JSON (unlike \Flagged/starred,
  // which the frontend reads straight off envelope.flags). One Fontos listing
  // fetched once per list load, matched by Message-ID (stable across labels,
  // unlike the per-mailbox numeric id -- see /api/email/important below).
  if (path === '/api/email/important-flags' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; messageIds?: unknown }
    if (!isKnownAccount(data.account ?? null) || !Array.isArray(data.messageIds)) { json(res, { error: 'account and messageIds required' }, 400); return true }
    const messageIds = data.messageIds.filter((x): x is string => typeof x === 'string').slice(0, 50)
    const r = await himalayaRead(['-a', data.account as string, 'envelope', 'list', '-m', IMPORTANT_MAILBOX, '-p', '1', '-s', '50', '--json'])
    const result: Record<string, boolean> = {}
    if (r.ok) {
      try {
        const fontosIds = new Set((JSON.parse(r.stdout).envelopes || []).map((e: { 'message-id'?: string }) => e['message-id']))
        for (const mid of messageIds) result[mid] = fontosIds.has(mid)
      } catch { for (const mid of messageIds) result[mid] = false }
    } else {
      for (const mid of messageIds) result[mid] = false
    }
    json(res, result)
    return true
  }

  // Lightweight, batched sibling lookup for the list pane's nested-reply rows
  // (Boss, 2026-08-05: "a levél tartalma" column stays single-message; the
  // conversation grouping belongs in the list, like a message's own replies
  // nested underneath it). One Sent-mailbox envelope fetch total, matched
  // in-memory against every row the frontend is currently rendering -- same
  // "one call, patch after the fact" shape as /api/email/attachments-flags.
  // No bodies here; the reader loads a specific message's content via
  // /api/email/message when a row (top-level or nested) is actually clicked.
  if (path === '/api/email/thread-siblings' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; items?: unknown }
    if (!isKnownAccount(data.account ?? null) || !Array.isArray(data.items)) { json(res, { error: 'account and items required' }, 400); return true }
    const items = (data.items as Array<{ id?: unknown; subject?: unknown }>)
      .filter((it): it is { id: string; subject: string } => typeof it.id === 'string' && typeof it.subject === 'string')
      .slice(0, 50)

    let sentEnvelopes: Array<{ id: string; subject?: string; date: string; from?: Array<{ email?: string }>; to?: Array<{ name?: string | null; email?: string }>; flags?: Array<{ iana?: string }>; 'message-id'?: string }> = []
    const r = await himalayaRead(['-a', data.account as string, 'envelope', 'list', '-m', SENT_MAILBOX, '-p', '1', '-s', '50', '--json'])
    if (r.ok) {
      try { sentEnvelopes = JSON.parse(r.stdout).envelopes || [] } catch { /* report no siblings rather than fail the list */ }
    }

    // Subject-only match, no participant/recipient filter: Gmail's own
    // conversation view keeps a forward in the original thread even when it
    // goes to a brand-new third party, because Gmail groups by the
    // References chain, not by shared recipients (Boss, 2026-08-05, pointed
    // at his own "Fwd: TUV toyota corolla -> Karacs Gabor" as proof -- it
    // stays chained to the cars2000 conversation in Gmail's own UI).
    // flags/message-id are passed through so the list pane can render a
    // star/important toggle on nested rows too, not just the anchor.
    const result: Record<string, Array<{ id: string; mailbox: string; date: string; from: unknown; to: unknown; subject?: string; flags?: unknown; 'message-id'?: string }>> = {}
    for (const it of items) {
      const targetSubject = normalizeThreadSubject(it.subject)
      // An empty subject isn't a real thread key -- every no-subject message
      // in the mailbox would otherwise bucket together (Boss, 2026-08-05,
      // screenshot showed an unrelated Cecilia Nemeth message merged with a
      // "Somnakaj Produkcio" thread because both had a blank subject).
      if (!targetSubject) continue
      const matches = sentEnvelopes
        .filter(e => normalizeThreadSubject(e.subject || '') === targetSubject)
        .map(e => ({ id: e.id, mailbox: SENT_MAILBOX, date: e.date, from: e.from, to: e.to, subject: e.subject, flags: e.flags, 'message-id': e['message-id'] }))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      if (matches.length) result[it.id] = matches
    }
    json(res, result)
    return true
  }

  if (path === '/api/email/attachment' && method === 'GET') {
    const account = url.searchParams.get('account')
    const mailbox = url.searchParams.get('mailbox') || 'Inbox'
    const id = url.searchParams.get('id')
    const attachmentId = url.searchParams.get('attachmentId')
    if (!isKnownAccount(account) || !id || !attachmentId) { json(res, { error: 'account, id and attachmentId required' }, 400); return true }
    // ?view=1 requests inline rendering (PDF/image preview in the 4th reader
    // column); the plain download chip omits it and gets a forced download,
    // same as clicking an attachment link normally would.
    const disposition = url.searchParams.get('view') === '1' ? 'inline' : 'attachment'
    const cacheKey = attachmentCacheKey(account as string, mailbox, id, attachmentId)
    const cachePaths = attachmentCachePaths(cacheKey)
    if (existsSync(cachePaths.bin) && existsSync(cachePaths.meta)) {
      try {
        const meta = JSON.parse(readFileSync(cachePaths.meta, 'utf8')) as { mime?: string; filename?: string }
        const stat = statSync(cachePaths.bin)
        res.setHeader('Content-Type', meta.mime || 'application/octet-stream')
        res.setHeader('Content-Disposition', `${disposition}; filename="${(meta.filename || 'attachment').replace(/"/g, '')}"`)
        res.setHeader('Content-Length', stat.size)
        createReadStream(cachePaths.bin).pipe(res)
        return true
      } catch { /* fall through to a fresh download if the cache entry is somehow bad */ }
    }
    const work = mkdtempSync(join(tmpdir(), 'marveen-attachment-dl-'))
    try {
      // himalayaRead (not the bare himalaya() alias) -- attachment download is
      // read-only same as message/attachment list, so the transient-IMAP-error
      // retry is safe here too. Was previously the one himalaya call in this
      // file with no retry, so it alone could fail when a sibling attachment's
      // concurrent fetch tripped Gmail's 15-connection IMAP cap (Boss screenshot
      // 2026-08-06: one attachment preview loaded, the other on the same email
      // didn't).
      const r = await himalayaRead(['-a', account as string, 'attachment', 'download', id, attachmentId, '-m', mailbox, '--dir', work, '--json'])
      if (!r.ok) { logger.warn(`[email] attachment download failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); rmSync(work, { recursive: true, force: true }); return true }
      const parsed = JSON.parse(r.stdout)
      const att = (parsed.attachments || [])[0]
      if (!att?.path) { json(res, { error: 'attachment not found' }, 404); rmSync(work, { recursive: true, force: true }); return true }
      // Move (not copy) into the persistent cache -- the temp dir is
      // discarded either way, no reason to duplicate the bytes on disk.
      mkdirSync(ATTACHMENT_CACHE_DIR, { recursive: true })
      renameSync(att.path, cachePaths.bin)
      writeFileSync(cachePaths.meta, JSON.stringify({
        mime: att.mime || 'application/octet-stream', filename: att.filename || 'attachment',
        // Plaintext identity, not just the hash -- lets purgeAttachmentCacheForMessage
        // find every cached attachment belonging to a given message when it's
        // permanently deleted, without needing to know attachmentIds up front.
        account, mailbox, id,
      }))
      rmSync(work, { recursive: true, force: true })
      pruneAttachmentCache(`${cacheKey}.bin`)
      const stat = statSync(cachePaths.bin)
      res.setHeader('Content-Type', att.mime || 'application/octet-stream')
      res.setHeader('Content-Disposition', `${disposition}; filename="${(att.filename || 'attachment').replace(/"/g, '')}"`)
      res.setHeader('Content-Length', stat.size)
      createReadStream(cachePaths.bin).pipe(res)
    } catch (err) {
      logger.warn(`[email] attachment download error: ${err}`)
      json(res, { error: 'attachment download failed' }, 502)
      rmSync(work, { recursive: true, force: true })
    }
    return true
  }

  if (path === '/api/email/reply' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; id?: string; text?: string }
    if (!isKnownAccount(data.account ?? null) || !data.id || !data.text?.trim()) { json(res, { error: 'account, id and text required' }, 400); return true }
    const mailbox = data.mailbox || 'Inbox'
    // Recipients (Reply-To/From) and the "Re:" subject are derived by
    // himalaya from the source message -- we only supply the body text.
    // --from is required: himalaya v2 doesn't fall back to the account's
    // configured address for `message reply`, it errors with "No `From:`
    // header found" if omitted.
    const r = await himalaya(['-a', data.account as string, 'message', 'reply', data.id, '-m', mailbox, '--from', accountEmail(data.account as string), '--body', data.text, '--send'])
    if (!r.ok) { logger.warn(`[email] reply failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/email/forward' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; id?: string; to?: string; text?: string }
    if (!isKnownAccount(data.account ?? null) || !data.id || !data.to?.trim() || !data.text?.trim()) { json(res, { error: 'account, id, to and text required' }, 400); return true }
    const mailbox = data.mailbox || 'Inbox'
    // See the reply route above: --from must be passed explicitly for himalaya v2.
    const r = await himalaya(['-a', data.account as string, 'message', 'forward', data.id, '-m', mailbox, '--from', accountEmail(data.account as string), '-t', data.to.trim(), '--body', data.text, '--send'])
    if (!r.ok) { logger.warn(`[email] forward failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    json(res, { ok: true })
    return true
  }

  // POST /api/email/compose -- brand-new message, not tied to any existing
  // one (unlike /reply and /forward above, which both derive recipients/
  // subject from a source message id). `message compose` is himalaya's own
  // flag-based composer; --send pushes it straight through SMTP, --save
  // additionally appends a copy into the account's Sent mailbox so it shows
  // up in the dashboard's own Sent list right away (Gmail itself does this
  // automatically over its own web client, but a raw SMTP send bypasses
  // that -- IMAP APPEND is the only way to get the same effect here).
  if (path === '/api/email/compose' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; to?: string; cc?: string; subject?: string; text?: string }
    if (!isKnownAccount(data.account ?? null) || !data.to?.trim() || !data.text?.trim()) { json(res, { error: 'account, to and text required' }, 400); return true }
    const args = ['-a', data.account as string, 'message', 'compose', '--from', accountEmail(data.account as string), '-t', data.to.trim(), '--body', data.text, '--send', '--save', SENT_MAILBOX]
    if (data.cc?.trim()) args.push('--cc', data.cc.trim())
    if (data.subject?.trim()) args.push('-s', data.subject.trim())
    const r = await himalaya(args)
    if (!r.ok) { logger.warn(`[email] compose failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    invalidateEnvelopeCache(data.account as string, SENT_MAILBOX)
    json(res, { ok: true })
    return true
  }

  if (path === '/api/email/read' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; id?: string; read?: boolean }
    if (!isKnownAccount(data.account ?? null) || !data.id) { json(res, { error: 'account and id required' }, 400); return true }
    const mailbox = data.mailbox || 'Inbox'
    const sub = data.read === false ? 'remove' : 'add'
    const r = await himalaya(['-a', data.account as string, 'flag', sub, '-m', mailbox, '-f', 'seen', data.id])
    if (!r.ok) { logger.warn(`[email] flag ${sub} failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    invalidateEnvelopeCache(data.account as string, mailbox)
    json(res, { ok: true })
    return true
  }

  // Star -- a plain standard IMAP flag (\Flagged), same shape as the seen/
  // unseen toggle above.
  if (path === '/api/email/star' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; id?: string; starred?: boolean }
    if (!isKnownAccount(data.account ?? null) || !data.id) { json(res, { error: 'account and id required' }, 400); return true }
    const mailbox = data.mailbox || 'Inbox'
    const sub = data.starred === false ? 'remove' : 'add'
    const r = await himalaya(['-a', data.account as string, 'flag', sub, '-m', mailbox, '-f', 'flagged', data.id])
    if (!r.ok) { logger.warn(`[email] flag ${sub} (flagged) failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    invalidateEnvelopeCache(data.account as string, mailbox)
    json(res, { ok: true })
    return true
  }

  // Important -- NOT a standard flag, a Gmail system label ("[Gmail]/Fontos",
  // already visible in the mailbox list). Marking important = copying the
  // message into that label (IMAP COPY; Gmail dedupes by its own message id,
  // so this adds a label rather than duplicating the message -- verified live
  // 2026-08-05). Unmarking = removing it from that one label the same way
  // /api/email/archive removes Inbox's label (store \Deleted + expunge,
  // scoped to Fontos only -- the message stays everywhere else it's filed).
  if (path === '/api/email/important' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; id?: string; important?: boolean; messageId?: string }
    if (!isKnownAccount(data.account ?? null) || !data.id) { json(res, { error: 'account and id required' }, 400); return true }
    const mailbox = data.mailbox || 'Inbox'
    if (data.important === false) {
      // Gmail assigns a DIFFERENT UID to the same message in every label
      // mailbox (verified live: an Inbox id of 112006 showed up as 22061 in
      // Fontos) -- data.id is only valid in `mailbox`, not in Fontos, so
      // removing the label means first finding ITS OWN id there via the
      // RFC822 Message-ID header, which is stable across labels.
      if (!data.messageId) { json(res, { error: 'messageId required to unmark important' }, 400); return true }
      const list = await himalaya(['-a', data.account as string, 'envelope', 'list', '-m', IMPORTANT_MAILBOX, '-p', '1', '-s', '50', '--json'])
      if (!list.ok) { logger.warn(`[email] unmark important lookup failed: ${list.stderr || list.stdout}`); json(res, { error: list.stderr || list.stdout || 'himalaya failed' }, 502); return true }
      let fontosId: string | undefined
      try {
        const envelopes = JSON.parse(list.stdout).envelopes || []
        fontosId = envelopes.find((e: { 'message-id'?: string }) => e['message-id'] === data.messageId)?.id
      } catch { /* fall through to not-found below */ }
      if (!fontosId) { json(res, { error: 'message not found in Fontos (older than the last 50?)' }, 404); return true }
      const store = await himalaya(['-a', data.account as string, 'imap', 'store', fontosId, '-f', '\\Deleted', '-m', IMPORTANT_MAILBOX])
      if (!store.ok) { logger.warn(`[email] unmark important store failed: ${store.stderr || store.stdout}`); json(res, { error: store.stderr || store.stdout || 'himalaya failed' }, 502); return true }
      const expunge = await himalaya(['-a', data.account as string, 'imap', 'expunge', IMPORTANT_MAILBOX])
      if (!expunge.ok) { logger.warn(`[email] unmark important expunge failed: ${expunge.stderr || expunge.stdout}`); json(res, { error: expunge.stderr || expunge.stdout || 'himalaya failed' }, 502); return true }
      invalidateEnvelopeCache(data.account as string, IMPORTANT_MAILBOX)
      json(res, { ok: true })
      return true
    }
    const r = await himalaya(['-a', data.account as string, 'message', 'copy', data.id, '-f', mailbox, '-t', IMPORTANT_MAILBOX])
    if (!r.ok) { logger.warn(`[email] mark important failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    invalidateEnvelopeCache(data.account as string, IMPORTANT_MAILBOX)
    json(res, { ok: true })
    return true
  }

  // Drag-and-drop / bulk "move to label" (Boss, 2026-08-07, corrected same
  // day): UID-MOVE (RFC 6851) into the target mailbox -- this is what real
  // Gmail actually does when you drag a message onto a label in the sidebar:
  // it adds the label AND removes the message from its current mailbox (e.g.
  // out of Inbox), it does not leave a copy behind there. An earlier version
  // of this endpoint used UID-COPY (mirroring /api/email/important, which
  // genuinely should leave the original in place) -- Boss caught that the
  // dragged message was staying in the source list, which isn't how Gmail
  // itself behaves. Accepts multiple ids for the bulk "Mozgat" button (one
  // himalaya call per id -- the CLI has no multi-id move that reports
  // partial failure per-id, and partial failure needs to be visible per
  // message, not all-or-nothing).
  if (path === '/api/email/label' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; ids?: string[]; target?: string }
    if (!isKnownAccount(data.account ?? null) || !data.target?.trim() || !Array.isArray(data.ids) || data.ids.length === 0) {
      json(res, { error: 'account, target and ids required' }, 400); return true
    }
    const mailbox = data.mailbox || 'Inbox'
    const failed: string[] = []
    for (const id of data.ids) {
      const r = await himalaya(['-a', data.account as string, 'message', 'move', id, '-f', mailbox, '-t', data.target])
      if (!r.ok) { logger.warn(`[email] label (move to ${data.target}) failed for ${id}: ${r.stderr || r.stdout}`); failed.push(id) }
    }
    invalidateEnvelopeCache(data.account as string, data.target)
    invalidateEnvelopeCache(data.account as string, mailbox)
    if (failed.length === data.ids.length) { json(res, { error: 'himalaya failed for all messages' }, 502); return true }
    json(res, { ok: true, failed })
    return true
  }

  if (path === '/api/email/delete' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; id?: string }
    if (!isKnownAccount(data.account ?? null) || !data.id) { json(res, { error: 'account and id required' }, 400); return true }
    const mailbox = data.mailbox || 'Inbox'
    // Gmail-IMAP trash semantics: UID MOVE (RFC 6851) into "[Gmail]/Kuka" both
    // removes the message from the source mailbox and files it into Trash --
    // this is what a normal Gmail client's delete button does (30-day
    // recoverable), unlike /api/email/archive which only unlabels Inbox.
    // Clicking Törlés from WITHIN Trash itself means "delete forever" --
    // mark \Deleted + expunge, same mechanism as archive but scoped to Kuka.
    // This used to just error out, leaving the button looking clickable but
    // permanently disabled after one click (Boss, 2026-08-05).
    if (mailbox === '[Gmail]/Kuka') {
      const store = await himalaya(['-a', data.account as string, 'imap', 'store', data.id, '-f', '\\Deleted', '-m', mailbox])
      if (!store.ok) { logger.warn(`[email] permanent delete store failed: ${store.stderr || store.stdout}`); json(res, { error: store.stderr || store.stdout || 'himalaya failed' }, 502); return true }
      const expunge = await himalaya(['-a', data.account as string, 'imap', 'expunge', mailbox])
      if (!expunge.ok) { logger.warn(`[email] permanent delete expunge failed: ${expunge.stderr || expunge.stdout}`); json(res, { error: expunge.stderr || expunge.stdout || 'himalaya failed' }, 502); return true }
      purgeAttachmentCacheForMessage(data.account as string, mailbox, data.id)
      purgeMessageBodyCache(data.account as string, mailbox, data.id)
      invalidateEnvelopeCache(data.account as string, mailbox)
      json(res, { ok: true })
      return true
    }
    const r = await himalaya(['-a', data.account as string, 'message', 'move', data.id, '-f', mailbox, '-t', '[Gmail]/Kuka'])
    if (!r.ok) { logger.warn(`[email] delete (move to trash) failed: ${r.stderr || r.stdout}`); json(res, { error: r.stderr || r.stdout || 'himalaya failed' }, 502); return true }
    purgeMessageBodyCache(data.account as string, mailbox, data.id)
    invalidateEnvelopeCache(data.account as string, mailbox)
    invalidateEnvelopeCache(data.account as string, '[Gmail]/Kuka')
    json(res, { ok: true })
    return true
  }

  if (path === '/api/email/archive' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; id?: string }
    if (!isKnownAccount(data.account ?? null) || !data.id) { json(res, { error: 'account and id required' }, 400); return true }
    const mailbox = data.mailbox || 'Inbox'
    // Gmail-IMAP archive semantics: removing a message from the Inbox mailbox
    // (mark \Deleted + expunge, scoped to THIS mailbox only) unlabels it from
    // Inbox but Gmail keeps it in "All Mail" -- this is not a real delete.
    // Non-Gmail IMAP providers would actually delete it, so this route stays
    // Gmail-only until a per-provider archive strategy is added.
    const store = await himalaya(['-a', data.account as string, 'imap', 'store', data.id, '-f', '\\Deleted', '-m', mailbox])
    if (!store.ok) { logger.warn(`[email] archive store failed: ${store.stderr || store.stdout}`); json(res, { error: store.stderr || store.stdout || 'himalaya failed' }, 502); return true }
    const expunge = await himalaya(['-a', data.account as string, 'imap', 'expunge', mailbox])
    if (!expunge.ok) { logger.warn(`[email] archive expunge failed: ${expunge.stderr || expunge.stdout}`); json(res, { error: expunge.stderr || expunge.stdout || 'himalaya failed' }, 502); return true }
    purgeMessageBodyCache(data.account as string, mailbox, data.id)
    invalidateEnvelopeCache(data.account as string, mailbox)
    json(res, { ok: true })
    return true
  }

  // POST /api/email/translate -- translate email content to Hungarian
  // Body: { account, mailbox, id, text?, html? } -- text/html optional, will fetch from message if not provided
  if (path === '/api/email/translate' && method === 'POST') {
    const body = await readBody(req)
    let data: { account?: string; mailbox?: string; id?: string; text?: string; html?: string; targetLang?: string; sourceLang?: string }
    try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const { account, mailbox, id, text, html, targetLang, sourceLang } = data
    if (!isKnownAccount(account ?? null) || !id) { json(res, { error: 'account and id required' }, 400); return true }
    const mb = mailbox || 'Inbox'
    const apiKey = getSecret('openrouter-fleet-key')
    if (!apiKey) { json(res, { error: 'OpenRouter API key not configured' }, 503); return true }

    // Fetch message body if not provided
    let msgText = text || ''
    let msgHtml = html || ''
    if (!msgText && !msgHtml) {
      const msg = await readMessageBody(account as string, mb, id)
      if ('error' in msg) { json(res, { error: msg.error, notFound: msg.notFound }, 502); return true }
      msgText = msg.text
      msgHtml = msg.html
    }

    const result = await translateEmailContent(msgText, msgHtml, apiKey, { targetLang, sourceLang })
    json(res, {
      translation: result.translation,
      sourceLang: result.sourceLang,
      targetLang: result.targetLang,
      fromCache: result.fromCache,
    })
    return true
  }

  return false
}
