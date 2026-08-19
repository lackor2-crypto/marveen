import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { simpleParser } from 'mailparser'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { readBody, json } from '../http-helpers.js'
import { cacheGet, cacheGetStale, cacheSet, refreshInBackground, singleFlight } from '../email-list-cache.js'
import { readAttachmentFlags, saveAttachmentFlags } from '../email-attachment-flag-store.js'
import type { CacheEntry } from '../email-list-cache.js'
import { logger } from '../../logger.js'
import { readMessageBodyDirect, messageStillExists, listMailboxesDirect, listEnvelopesDirect, checkImapAccountConfig, declareSniffedHtmlCharset, resolveSpecialMailboxes } from '../email-imap.js'
import type { MailboxRole } from '../email-imap.js'
import { buildHimalayaSearchArgs, normalizeEmailSearchQuery } from '../email-search.js'
import { isPromotionalEnvelope } from '../../email-promo-classify.js'
import {
  loadRules, saveRules, addRule, removeRule, rulesFor, matchesRule,
  type EmailRule, type EmailRuleKind, type EnvelopeLike,
} from '../../email-rules.js'
import { translateEmailContent } from '../email-translate.js'
import { getSecret } from '../vault.js'
import { contentDispositionHeader } from './drive-browser.js'
import type { RouteContext } from './types.js'

// Per-install Himalaya CLI toolkit (binary + TOML config + per-account secret
// files) -- mirrors the ~/.local/share/marveen-voice/ convention. Never
// tracked in the repo: the config references secrets by path, the secrets
// themselves live in a 700-permission directory outside git entirely.
const HIMALAYA_BIN = `${process.env.HOME}/.local/bin/himalaya`
const HIMALAYA_CONFIG = `${process.env.HOME}/.local/share/marveen-himalaya/config.toml`
// There used to be a manual kill switch here: a marker file
// (~/.local/share/marveen-himalaya/disable-imap-direct) whose mere presence
// reverted body reads, the mailbox list AND the envelope list to himalaya.
// REMOVED on Boss's instruction (2026-08-12) after it cost two days of silent
// slowness: someone created the marker on 2026-08-10, nothing logged it,
// nothing showed it, and mail simply went back to downloading every attachment
// with every body -- a 55-character message with a 22MB video took 37s instead
// of 0.8s. It was found only because Boss complained.
//
// Nothing is lost by removing it: the escape hatch that matters is AUTOMATIC
// and still here. Each direct-IMAP helper returns null on any failure
// (unsupported message shape, connection error, timeout) and the caller falls
// through to the himalaya path for that one request. A manual global off-switch
// only added a way to silently degrade everything at once.
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

interface HimalayaResult { ok: boolean; stdout: string; stdoutBuf: Buffer; stderr: string }

// `encoding: 'buffer'` keeps the raw bytes intact in `stdoutBuf`: `message
// read --raw` hands back a whole MIME message whose body may be
// windows-1250 / iso-8859-2, and execFile's default utf8 decode would
// replace every 8-bit character with U+FFFD before mailparser ever got to
// read the part's declared charset. `stdout` stays the utf8 string every
// other caller (all of which parse himalaya's own JSON output) expects.
function himalayaOnce(args: string[]): Promise<HimalayaResult> {
  return new Promise(resolve => {
    execFile(HIMALAYA_BIN, ['-c', HIMALAYA_CONFIG, ...args], { timeout: TIMEOUT, maxBuffer: 96 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      // A timeout/maxBuffer kill leaves himalaya's own stdout/stderr empty
      // (the process never got to write an error of its own) -- fall back to
      // Node's own err.message/code so a caller sees "maxBuffer exceeded" or
      // "signal SIGTERM" instead of a bare, uninformative "himalaya failed"
      // (Boss, 2026-08-05: asked what the actual limit was after a large
      // attachment test -- this is the piece that would tell him next time).
      const fallback = err ? `${err.message}${'code' in err ? ` (${(err as NodeJS.ErrnoException).code})` : ''}` : ''
      const out = stdout ?? Buffer.alloc(0)
      resolve({ ok: !err, stdout: out.toString('utf8'), stdoutBuf: out, stderr: stderr?.toString('utf8') || fallback })
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
// himalaya `--json` modban a HIBAT is a stdoutra irja ({"error":"..."}), es
// ilyenkor a stderr URES -- amit viszont a himalayaOnce fallback szovege
// ("Command failed ... (1)") tolt ki, tehat a `stderr || stdout` sorrend
// SOSE latta a valodi hibauzenetet. Merve 2026-08-19: a Kuka listazasa igy
// "Command failed"-kent bukott el a felhasznalonak, pedig a mar ismert
// atmeneti "Resource temporarily unavailable (os error 11)" volt, amire epp
// van ujraprobalkozas -- csak nem ismertuk fel. Ezert a valodi hibaszoveget
// mostantol innen kell kerni, es MINDKET csatornat nezzuk.
export function himalayaErrorText(r: HimalayaResult): string {
  // Csak ertelmes meretu kimenetet probalunk JSON-kent olvasni: hiba eseten a
  // stdout rovid, de egy felig sikerult letoltes akar tobb tiz MB is lehet.
  if (r.stdout && r.stdout.length < 64 * 1024) {
    try {
      const parsed = JSON.parse(r.stdout)
      if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
        const text = (parsed as { error: string }).error
        if (text) return text
      }
    } catch { /* nem JSON -- marad a stderr */ }
  }
  return r.stderr || r.stdout || 'himalaya failed'
}

async function himalayaRead(args: string[]): Promise<HimalayaResult> {
  let attempt = await himalayaOnce(args)
  for (let i = 0; i < TRANSIENT_RETRY_ATTEMPTS; i++) {
    if (attempt.ok || !isTransientImapError(himalayaErrorText(attempt))) break
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

// Gmail names its system folders in the ACCOUNT's own language, so these can
// never be constants -- see MailboxRole in email-imap.ts for the measurement
// that settled it. This table is the LAST RESORT only: when the direct IMAP
// path (the one that reads the language-independent flags) is unavailable,
// falling back to the names Boss's own accounts use keeps today's behaviour
// instead of failing outright. Every real lookup goes through mailboxFor().
const FALLBACK_MAILBOX: Record<MailboxRole, string> = {
  inbox: 'Inbox',
  sent: '[Gmail]/Elküldött levelek',
  drafts: '[Gmail]/Piszkozatok',
  trash: '[Gmail]/Kuka',
  spam: '[Gmail]/Spam',
  important: '[Gmail]/Fontos',
  starred: '[Gmail]/Csillagozott',
  all: '[Gmail]/Összes levél',
}

/** The account's OWN name for one of Gmail's system folders. */
async function mailboxFor(account: string, role: MailboxRole): Promise<string> {
  const resolved = await resolveSpecialMailboxes(account)
  const name = resolved?.[role]
  if (name) return name
  logger.warn(`[email] a(z) "${role}" mappa nem oldhato fel IMAP-rol a(z) "${account}" fioknal; tartalek: "${FALLBACK_MAILBOX[role]}"`)
  return FALLBACK_MAILBOX[role]
}

// Boss, 2026-08-15: "ha spambe huzom akkor jeloje meg es a jovobeni leveleket
// azonnal a spambe iranyitsa." Egy listazasban ennyi levelet mozgatunk at
// legfeljebb. A hatar nem a helyesseg miatt kell, hanem hogy egy hirtelen
// beomlo szemet-hullam ne fagyassza be a bejovo lista betolteset: ami most
// kimarad, azt a kovetkezo listazas viszi el.
const SPAM_RULE_MOVE_LIMIT = 25

// Mirrors the frontend's EMAIL_SYSTEM_MAILBOX_ORDER (web/app.js) -- Gmail's
// own built-in folders, never user labels. The label-delete route (below)
// must never be able to touch these: an IMAP DELETE on one of them doesn't
// just remove a label, it breaks Gmail's own IMAP folder structure, and
// there's no undo (Boss, 2026-08-05: added label delete precisely so custom
// labels could be cleaned up from the dashboard -- system folders were
// never meant to be selectable in that UI, this is the backend backstop in
// case that ever slips).
const FALLBACK_SYSTEM_MAILBOXES = new Set<string>([
  ...Object.values(FALLBACK_MAILBOX),
  '[Gmail]/Beszélgetések',
])

/**
 * Is this one of Gmail's OWN folders rather than a user label?
 *
 * Checked against both the account's resolved names and the fallback list. On
 * an English account "[Gmail]/Kuka" simply does not exist, so keeping it
 * blocked costs nothing -- while "[Gmail]/Trash", which a Hungarian-only name
 * guard waved straight through to an irreversible IMAP DELETE, is now caught.
 */
async function isSystemMailbox(account: string, name: string): Promise<boolean> {
  if (FALLBACK_SYSTEM_MAILBOXES.has(name)) return true
  const resolved = await resolveSpecialMailboxes(account)
  return resolved ? Object.values(resolved).includes(name) : false
}

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

// A Sent-boritekok (a valasz-testverekhez) egyetlen himalaya-hivas, viszont
// hideg kapcsolattal ez elesben 5,7 mp volt -- ennyit varakozott a mar kesz
// levellista a kepernyon kivul (Boss, 2026-08-19: "a masodik oszlop sem
// toltodik be hamar"). A lista mostmar nem var ra, de a hivas maga is
// megkapja ugyanazt a kezelest, mint a boritek-lista: rovid TTL, azon tul
// elavult-de-azonnali valasz + hatterben frissites. Egy percnel frissebb Sent
// lista boven eleg ahhoz, hogy a sajat valaszok a szal ala kerulhessenek.

// "Elavult, de AZONNAL" -- a TTL lejarta utan sem dobjuk el a listat rogton.
//
// Boss, 2026-08-19: "az emailnal az elso oszlop es masodik oszlop sem
// toltodik be hamar. csak nagyon sokara. sokat kell varni ra." Merve
// ugyanaznap, a valodi bongeszo-hullamkepbol: a mappalista 22 ms (cache-bol),
// a levellista 4607 ms. A kulonbseg oka NEM a lekerdezes maga -- egy MELEG
// IMAP-kapcsolaton egy friss oldal 0,12 mp --, hanem a HIDEG kapcsolat:
// 5 perc utan a kapcsolatkezelo elengedi a socketet, es a kovetkezo kattintas
// fizeti ki ujra a TLS + bejelentkezes arat (2,3-4,6 mp, fiokfuggo).
//
// Ezert a TTL utan is kiadjuk a legutobbi listat -- azonnal --, es a friss
// valtozat a HATTERBEN erkezik meg a cache-be (Boss: "ami nem fontos azt a
// hatterben kesobb is be lehet tolteni"). A valasz `X-Marveen-Stale: 1`
// fejlecet kap, amirol a frontend tudja, hogy egy pillanat mulva erdemes
// meg egyszer, csendben elkernie.
//
// A ket ablak azert kulonbozik, mert mast kockaztat. A mappalista csak
// cimke-letrehozaskor/torleskor valtozik -- azt a ket utvonal amugy is
// explicit uriti --, tehat ott egy nap is biztonsagos. A levellista viszont
// uj levellel es minden mozgatassal valtozik, ott fel ora a hatar: azon tul
// inkabb varjon a felhasznalo, mint hogy egy fel napos listat lasson.
const MAILBOX_STALE_MAX_MS = 24 * 60 * 60_000
const ENVELOPE_STALE_MAX_MS = 30 * 60_000
const SENT_ENVELOPE_TTL_MS = 60_000
const SENT_ENVELOPE_STALE_MAX_MS = 30 * 60_000
const mailboxListCache = new Map<string, CacheEntry<unknown[]>>()
const sentEnvelopeCache = new Map<string, CacheEntry<{ mailbox: string; envelopes: SentEnvelope[] }>>()
const envelopeListCache = new Map<string, CacheEntry<unknown[]>>()

// Envelope list is paginated (`-p`) -- a mutation doesn't know which page(s)
// the frontend currently has open, so every cached page for this
// (account, mailbox) is dropped rather than tracking pages individually.
function invalidateEnvelopeCache(account: string, mailbox: string): void {
  const prefix = `${account}::${mailbox}::`
  for (const key of envelopeListCache.keys()) {
    if (key.startsWith(prefix)) envelopeListCache.delete(key)
  }
}

// A ket lista TENYLEGES lekerese, a valaszadastol elvalasztva: pontosan
// ugyanez fut a felhasznalo varakoztatasakor es a hatter-frissiteskor is.
// Ha a ketto kulon kodon menne, a hatterben mas lista allna elo, mint amit a
// blokkolo ag ad -- pont az a fajta elteres, amit senki sem venne eszre.
type MailboxFetch = { ok: true; mailboxes: unknown[] } | { ok: false; error: string }
type SentEnvelope = { id: string; subject?: string; date: string; from?: Array<{ email?: string }>; to?: Array<{ name?: string | null; email?: string }>; flags?: Array<{ iana?: string }>; 'message-id'?: string }

async function fetchSentEnvelopes(account: string): Promise<{ ok: boolean; mailbox: string; envelopes: SentEnvelope[] }> {
  return singleFlight(`sent-envelopes::${account}`, () => fetchSentEnvelopesOnce(account))
}

async function fetchSentEnvelopesOnce(account: string): Promise<{ ok: boolean; mailbox: string; envelopes: SentEnvelope[] }> {
  const mailbox = await mailboxFor(account, 'sent')
  const r = await himalayaRead(['-a', account, 'envelope', 'list', '-m', mailbox, '-p', '1', '-s', '50', '--json'])
  if (!r.ok) return { ok: false, mailbox, envelopes: [] }
  // Hibas JSON eseten inkabb "nincs testver", mint elszallo levellista.
  try { return { ok: true, mailbox, envelopes: JSON.parse(r.stdout).envelopes || [] } } catch { return { ok: false, mailbox, envelopes: [] } }
}

async function loadSentEnvelopes(account: string): Promise<{ mailbox: string; envelopes: SentEnvelope[] }> {
  const cached = cacheGet(sentEnvelopeCache, account)
  if (cached) return cached
  const stale = cacheGetStale(sentEnvelopeCache, account, SENT_ENVELOPE_STALE_MAX_MS)
  if (stale) {
    refreshInBackground(`sent-envelopes::${account}`, async () => {
      const fresh = await fetchSentEnvelopes(account)
      if (fresh.ok) cacheSet(sentEnvelopeCache, account, { mailbox: fresh.mailbox, envelopes: fresh.envelopes }, SENT_ENVELOPE_TTL_MS, SENT_ENVELOPE_STALE_MAX_MS)
    })
    return stale
  }
  const fetched = await fetchSentEnvelopes(account)
  if (fetched.ok) cacheSet(sentEnvelopeCache, account, { mailbox: fetched.mailbox, envelopes: fetched.envelopes }, SENT_ENVELOPE_TTL_MS, SENT_ENVELOPE_STALE_MAX_MS)
  return { mailbox: fetched.mailbox, envelopes: fetched.envelopes }
}

// A levellista cache-kulcsa. Egy helyen szamoljuk, mert az elomelegites es a
// kiszolgalo kulonben eltero kulcsra irhatna/olvashatna -- az ilyen elteres
// nema: nem hibazik, csak sosem talal.
function envelopeCacheKeyFor(account: string, mailbox: string, page: number, query: string, promoOnly: boolean): string {
  return `${account}::${mailbox}::${page}::${query}::${mailbox === 'Inbox' ? (promoOnly ? 'promo' : 'nopromo') : 'all'}`
}

// A Fontos-jelzo NEM IMAP-flag, hanem egy Gmail-cimke: hogy egy level fontos-e,
// azt csak ugy tudjuk meg, ha kilistazzuk a Fontos mappat -- egy teljes IMAP
// bejelentkezes. A frontend viszont oldalankent TOBBSZOR is kerdez (az elso
// rajzolasra, majd a Sent-testverek uj soraira), a nema ujratoltes pedig
// megegyszer: merve 2026-08-19-en ez 4 hivas volt egy oldalbetoltesre,
// egyenkent 0,9-1,9 masodperc, mikozben a szerver egy szalon szolgal ki
// mindent. A lista tartalma percekig alig valtozik, tehat ugyanaz a
// "lejart-de-meg-jo" tar jar neki, mint az Elkuldott-listanak.
const IMPORTANT_ENVELOPE_TTL_MS = 30_000
// Szandekosan rovid stale-ablak: a csillagot MASHOL is at lehet allitani (a
// telefon Gmail-alkalmazasaban), es azt a valtozast a dashboard csak a
// kovetkezo lekereskor latja. 30 mp friss + legfeljebb 2 perc "regi, de meg
// kiadhato" -- eleg ahhoz, hogy egy oldalbetoltes negy kerdese egy IMAP
// lekerest jelentsen, de nem eleg ahhoz, hogy sokaig hazudjon.
const IMPORTANT_ENVELOPE_STALE_MAX_MS = 2 * 60_000
const importantEnvelopeCache = new Map<string, CacheEntry<string[]>>()

async function fetchImportantMessageIds(account: string): Promise<{ ok: boolean; messageIds: string[] }> {
  return singleFlight(`important-envelopes::${account}`, () => fetchImportantMessageIdsOnce(account))
}

async function fetchImportantMessageIdsOnce(account: string): Promise<{ ok: boolean; messageIds: string[] }> {
  const mailbox = await mailboxFor(account, 'important')
  const r = await himalayaRead(['-a', account, 'envelope', 'list', '-m', mailbox, '-p', '1', '-s', '50', '--json'])
  if (!r.ok) return { ok: false, messageIds: [] }
  try {
    const envelopes = (JSON.parse(r.stdout).envelopes || []) as Array<{ 'message-id'?: string }>
    return { ok: true, messageIds: envelopes.map(e => e['message-id']).filter((m): m is string => typeof m === 'string') }
  } catch { return { ok: false, messageIds: [] } }
}

async function loadImportantMessageIds(account: string): Promise<string[]> {
  const cached = cacheGet(importantEnvelopeCache, account)
  if (cached) return cached
  const stale = cacheGetStale(importantEnvelopeCache, account, IMPORTANT_ENVELOPE_STALE_MAX_MS)
  if (stale) {
    refreshInBackground(`important-envelopes::${account}`, async () => {
      const fresh = await fetchImportantMessageIds(account)
      if (fresh.ok) cacheSet(importantEnvelopeCache, account, fresh.messageIds, IMPORTANT_ENVELOPE_TTL_MS, IMPORTANT_ENVELOPE_STALE_MAX_MS)
    })
    return stale
  }
  const fetched = await fetchImportantMessageIds(account)
  if (fetched.ok) cacheSet(importantEnvelopeCache, account, fetched.messageIds, IMPORTANT_ENVELOPE_TTL_MS, IMPORTANT_ENVELOPE_STALE_MAX_MS)
  return fetched.messageIds
}

/** A jelzo BEALLITASA utan a tar azonnal ervenytelen -- kulonben a csillag
 *  visszaugrana a kovetkezo rajzolaskor. */
function invalidateImportantFlagCache(account: string): void {
  importantEnvelopeCache.delete(account)
}

async function fetchMailboxList(account: string): Promise<MailboxFetch> {
  return singleFlight(`mailbox-list::${account}`, () => fetchMailboxListOnce(account))
}

async function fetchMailboxListOnce(account: string): Promise<MailboxFetch> {
  // Strangler fig: try IMAP direct path first, fall back to himalaya on any failure
  const direct = await listMailboxesDirect(account)
  if (direct) return { ok: true, mailboxes: direct }
  const r = await himalayaRead(['-a', account, 'mailbox', 'list', '--json'])
  if (!r.ok) {
    logger.warn(`[email] mailbox list failed: ${himalayaErrorText(r)}`)
    return { ok: false, error: himalayaErrorText(r) }
  }
  try {
    const parsed = JSON.parse(r.stdout)
    return { ok: true, mailboxes: parsed.mailboxes || [] }
  } catch {
    return { ok: false, error: 'unparseable himalaya output' }
  }
}

type EnvelopeFetch = { ok: true; envelopes: unknown[] } | { ok: false; error: string }
async function fetchEnvelopeList(
  account: string,
  mailbox: string,
  page: number,
  pageSize: number,
  query: string,
  promoOnly: boolean,
): Promise<EnvelopeFetch> {
  const key = `envelope-list::${envelopeCacheKeyFor(account, mailbox, page, query, promoOnly)}::${pageSize}`
  return singleFlight(key, () => fetchEnvelopeListOnce(account, mailbox, page, pageSize, query, promoOnly))
}

async function fetchEnvelopeListOnce(
  account: string,
  mailbox: string,
  page: number,
  pageSize: number,
  query: string,
  promoOnly: boolean,
): Promise<EnvelopeFetch> {
  // Strangler fig: try IMAP direct path first, fall back to himalaya on any failure
  const direct = await listEnvelopesDirect(account, mailbox, page, pageSize, query || undefined)
  if (direct) {
    let envelopes: unknown[] = direct
    if (mailbox === 'Inbox') {
      const applied = await applyInboxRules(account, envelopes, promoOnly, !query)
      envelopes = applied.list
      if (applied.movedToSpam > 0) invalidateEnvelopeCache(account, 'Inbox')
    }
    return { ok: true, envelopes }
  }
  const envelopeCommand = query ? ['envelope', 'search'] : ['envelope', 'list']
  const searchArgs = query ? buildHimalayaSearchArgs(query) : []
  const r = await himalayaRead(['-a', account, ...envelopeCommand, '-m', mailbox, '-p', String(page), '-s', String(pageSize), '--json', ...searchArgs])
  if (!r.ok) {
    logger.warn(`[email] envelope list failed (${mailbox}): ${himalayaErrorText(r)}`)
    return { ok: false, error: himalayaErrorText(r) }
  }
  try {
    const parsed = JSON.parse(r.stdout)
    let envelopes: unknown[] = parsed.envelopes || []
    if (mailbox === 'Inbox') {
      const applied = await applyInboxRules(account, envelopes, promoOnly, !query)
      envelopes = applied.list
      if (applied.movedToSpam > 0) invalidateEnvelopeCache(account, 'Inbox')
    }
    return { ok: true, envelopes }
  } catch {
    return { ok: false, error: 'unparseable himalaya output' }
  }
}

/**
 * A tanult felado-szabalyok ervenyesitese a BEJOVO listan.
 *
 * Boss, 2026-08-15: "ha spambe huzom akkor jeloje meg es a jovobeni leveleket
 * azonnal a spambe iranyitsa" -- plusz ugyanez a Promociokra, ami viszont nem
 * IMAP-mappa, hanem szuro (lasd email-promo-classify.ts), tehat ott nincs mit
 * mozgatni: a felado megjegyzese maga a "athuzas".
 *
 * KET dolgot csinal, ebben a sorrendben:
 *  1. SPAM: amelyik levelet szabaly talalja, azt tenylegesen ATMOZGATJA a Spam
 *     mappaba -- igy a telefonon es a Gmail-ben is ott lesz, nem csak itt tunik
 *     el. Csak azt a sort vesszuk ki a listabol, amelyiknek a mozgatasa
 *     SIKERULT: egy elhasalt mozgatas utan a level a helyen marad, es a
 *     kovetkezo listazas ujra megprobalja. Elrejteni egy olyan levelet, ami
 *     valojaban a bejovoben maradt, rosszabb lenne, mint meghagyni.
 *  2. PROMOCIOK: a heurisztika (isPromotionalEnvelope) MELLE a tanult feladok
 *     is promonak szamitanak.
 *
 * `moveSpam` KERESESNEL hamis: a talalati lista egy kerdes ("hol van ez a
 * level?"), nem a bejovo atnezese -- egy keresestol ne rendezodjon at a
 * postafiok. A szures ilyenkor is fut, a mozgatas a kovetkezo sima
 * bejovo-listazaskor.
 */
async function applyInboxRules(
  account: string,
  envelopes: unknown[],
  promoOnly: boolean,
  moveSpam: boolean,
): Promise<{ list: unknown[]; movedToSpam: number }> {
  const rules = loadRules()
  const spamSenders = rulesFor(rules, 'spam', account)
  const promoSenders = rulesFor(rules, 'promo', account)
  let list = envelopes
  let movedToSpam = 0

  if (moveSpam && spamSenders.size > 0) {
    const hits = list.filter((e) => matchesRule(spamSenders, e as EnvelopeLike))
      .slice(0, SPAM_RULE_MOVE_LIMIT)
    const movedIds = new Set<string>()
    const spamMailbox = await mailboxFor(account, 'spam')
    for (const e of hits) {
      const id = String((e as { id?: unknown }).id ?? '')
      if (!id) continue
      const r = await himalaya(['-a', account, 'message', 'move', id, '-f', 'Inbox', '-t', spamMailbox])
      if (r.ok) { movedIds.add(id); movedToSpam++ }
      else logger.warn(`[email] spam-szabaly mozgatas nem sikerult (${id}): ${himalayaErrorText(r)}`)
    }
    if (movedToSpam > 0) invalidateEnvelopeCache(account, spamMailbox)
    if (movedIds.size > 0) list = list.filter((e) => !movedIds.has(String((e as { id?: unknown }).id ?? '')))
  }

  const isPromo = (e: unknown): boolean =>
    isPromotionalEnvelope(e as Parameters<typeof isPromotionalEnvelope>[0])
    || matchesRule(promoSenders, e as EnvelopeLike)
  list = list.filter((e) => isPromo(e) === promoOnly)
  return { list, movedToSpam }
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
      // ...de a probat MAR NEM A FELHASZNALO FIZETI KI. Merve 2026-08-19: egy
      // mar cache-elt level teste is 0,6-2,5 mp-et varakozott, es a teljes ido
      // ez az egy IMAP-korut volt (Boss: "a level teste betoltesere meg mindig
      // kicsit varni kell"). A kesz test tehat AZONNAL kimegy, a proba pedig a
      // hatterben fut: ha kiderul, hogy a level mar nincs, a bejegyzes kiesik,
      // es a kovetkezo megnyitas mondja meg, hogy elerhetetlen -- az eredeti
      // eset (Gmail-ben torolt level F5 utan is latszott) igy sem ter vissza,
      // mert az F5 utani megnyitas mar a kiurult cache-t talalja.
      // Bump recency: delete + re-set moves it to the end of Map's
      // insertion order, which the eviction below reads as "most recently
      // used".
      messageBodyCache.delete(cacheKey)
      messageBodyCache.set(cacheKey, cached)
      void (async () => {
        try {
          if (!(await messageStillExists(account, mailbox, id))) messageBodyCache.delete(cacheKey)
        } catch { /* halozati zavar: a cache-t valtozatlanul hagyjuk, mint eddig */ }
      })()
      return cached.data
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
  // text in ~1-2s instead of ~30-90s (live-measured). It is unconditional now
  // (Boss, 2026-08-12: the old marker-file kill switch is gone -- see the note
  // where it used to be declared). readMessageBodyDirect() returns null on ANY
  // failure (unsupported message shape, connection error, timeout, ...) and
  // never throws, so falling through to the unchanged himalaya path below is
  // always safe -- this can only make a message load AS SLOW AS today, never
  // slower, never broken.
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

  // FALLBACK PATH: only reached when the direct-IMAP fast path above returned
  // null for this message (unsupported shape, connection error, ...). himalaya's
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
  if (!bodyR.ok) { logger.warn(`[email] message read failed: ${himalayaErrorText(bodyR)}`); return { error: himalayaErrorText(bodyR) } }
  let text = ''
  let html = ''
  try {
    const parsed = await simpleParser(declareSniffedHtmlCharset(bodyR.stdoutBuf), { skipHtmlToText: true })
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

  // Dashboard-facing health check for the direct-IMAP fast path (see the
  // 2026-08-18 config-format-drift incident documented on parseHimalayaToml
  // and checkImapAccountConfig in email-imap.ts) -- per account, whether the
  // fast path currently resolves at all, so the UI can show it loudly
  // instead of the user only finding out by a message loading slowly.
  if (path === '/api/email/fastpath-status' && method === 'GET') {
    const accounts = getAccounts().map(a => ({ account: a.id, label: a.label, ...checkImapAccountConfig(a.id) }))
    json(res, { accounts })
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
    const stale = cacheGetStale(mailboxListCache, account as string, MAILBOX_STALE_MAX_MS)
    if (stale) {
      json(res, stale, 200, { 'X-Marveen-Stale': '1' })
      refreshInBackground(`mailboxes::${account}`, async () => {
        const fresh = await fetchMailboxList(account as string)
        if (fresh.ok) cacheSet(mailboxListCache, account as string, fresh.mailboxes, MAILBOX_LIST_TTL_MS, MAILBOX_STALE_MAX_MS)
      })
      return true
    }
    const fetched = await fetchMailboxList(account as string)
    if (!fetched.ok) { json(res, { error: fetched.error }, 502); return true }
    cacheSet(mailboxListCache, account as string, fetched.mailboxes, MAILBOX_LIST_TTL_MS, MAILBOX_STALE_MAX_MS)
    json(res, fetched.mailboxes)
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
    if (!r.ok) { logger.warn(`[email] mailbox create failed: ${himalayaErrorText(r)}`); json(res, { error: himalayaErrorText(r) }, 502); return true }
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
    const systemHits = await Promise.all(names.map(n => isSystemMailbox(data.account as string, n)))
    if (systemHits.some(Boolean)) { json(res, { error: 'system mailbox cannot be deleted' }, 400); return true }
    const results = await Promise.all(names.map(async name => {
      const r = await himalaya(['-a', data.account as string, 'imap', 'delete', name])
      if (!r.ok) logger.warn(`[email] mailbox delete failed (${name}): ${himalayaErrorText(r)}`)
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
    const envelopeCacheKey = envelopeCacheKeyFor(account as string, mailbox, page, query, promoOnly)
    const cachedEnvelopes = cacheGet(envelopeListCache, envelopeCacheKey)
    if (cachedEnvelopes) { json(res, cachedEnvelopes); return true }
    const staleEnvelopes = cacheGetStale(envelopeListCache, envelopeCacheKey, ENVELOPE_STALE_MAX_MS)
    if (staleEnvelopes) {
      json(res, staleEnvelopes, 200, { 'X-Marveen-Stale': '1' })
      refreshInBackground(`envelopes::${envelopeCacheKey}`, async () => {
        const fresh = await fetchEnvelopeList(account as string, mailbox, page, pageSize, query, promoOnly)
        if (fresh.ok) cacheSet(envelopeListCache, envelopeCacheKey, fresh.envelopes, ENVELOPE_LIST_TTL_MS, ENVELOPE_STALE_MAX_MS)
      })
      return true
    }
    const fetched = await fetchEnvelopeList(account as string, mailbox, page, pageSize, query, promoOnly)
    if (!fetched.ok) { json(res, { error: fetched.error }, 502); return true }
    cacheSet(envelopeListCache, envelopeCacheKey, fetched.envelopes, ENVELOPE_LIST_TTL_MS, ENVELOPE_STALE_MAX_MS)
    json(res, fetched.envelopes)
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
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; ids?: unknown; items?: unknown }
    const hasShape = Array.isArray(data.items) || Array.isArray(data.ids)
    if (!isKnownAccount(data.account ?? null) || !hasShape) { json(res, { error: 'account and ids required' }, 400); return true }
    // Ket bemeneti alak: a regi `ids` (csak a mappan beluli szamozott
    // azonositok) es az uj `items` (azonosito + Message-ID). A Message-ID kell
    // a tartos cache-hez; ha nincs, a level minden alkalommal ujra sorra kerul
    // -- mukodik, csak lassabb.
    const items: Array<{ id: string; messageId: string }> = (Array.isArray(data.items)
      ? (data.items as Array<{ id?: unknown; messageId?: unknown }>)
        .filter(x => !!x && typeof x.id === 'string')
        .map(x => ({ id: x.id as string, messageId: typeof x.messageId === 'string' ? x.messageId : '' }))
      : (data.ids as unknown[]).filter((x): x is string => typeof x === 'string').map(id => ({ id, messageId: '' }))
    ).slice(0, 50)
    const mailbox = data.mailbox || 'Inbox'
    const result: Record<string, boolean> = {}
    // Amit egyszer mar megneztunk, azt nem nezzuk meg ujra: egy uzenet
    // csatolmanya nem valtozik. Ez volt a dashboard legnagyobb terhelese --
    // uzenetenkent egy himalaya-processz, sajat IMAP-bejelentkezessel.
    const known = readAttachmentFlags(items.map(i => i.messageId))
    const toScan = items.filter(i => {
      if (i.messageId && i.messageId in known) { result[i.id] = known[i.messageId]; return false }
      return true
    })
    const learned: Record<string, boolean> = {}
    const CONCURRENCY = 6
    let cursor = 0
    async function worker() {
      while (cursor < toScan.length) {
        const item = toScan[cursor++]
        const r = await himalayaRead(['-a', data.account as string, 'attachment', 'list', item.id, '-m', mailbox, '--json'])
        if (r.ok) {
          // Inline parts (signature logos, tracking pixels referenced by the
          // HTML body via cid:) come back in this list too -- only count real,
          // non-inline attachments so the paperclip doesn't light up on every
          // marketing email with an embedded logo.
          try {
            const has = ((JSON.parse(r.stdout).attachments || []) as Array<{ inline?: boolean }>).some(a => !a.inline)
            result[item.id] = has
            // Csak a sikeres, ertelmezett valasz tanulsag -- hibas/olvashatatlan
            // valaszt nem irunk be orokre.
            if (item.messageId) learned[item.messageId] = has
          } catch { result[item.id] = false }
        } else {
          result[item.id] = false
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toScan.length) }, worker))
    saveAttachmentFlags(learned)
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
    const fontosIds = new Set(await loadImportantMessageIds(data.account as string))
    const result: Record<string, boolean> = {}
    for (const mid of messageIds) result[mid] = fontosIds.has(mid)
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

    const sent = await loadSentEnvelopes(data.account as string)
    const sentMailbox = sent.mailbox
    const sentEnvelopes = sent.envelopes

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
        .map(e => ({ id: e.id, mailbox: sentMailbox, date: e.date, from: e.from, to: e.to, subject: e.subject, flags: e.flags, 'message-id': e['message-id'] }))
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
        res.setHeader('Content-Disposition', contentDispositionHeader(meta.filename || 'attachment', disposition))
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
      if (!r.ok) { logger.warn(`[email] attachment download failed: ${himalayaErrorText(r)}`); json(res, { error: himalayaErrorText(r) }, 502); rmSync(work, { recursive: true, force: true }); return true }
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
      res.setHeader('Content-Disposition', contentDispositionHeader(att.filename || 'attachment', disposition))
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
    if (!r.ok) { logger.warn(`[email] reply failed: ${himalayaErrorText(r)}`); json(res, { error: himalayaErrorText(r) }, 502); return true }
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
    if (!r.ok) { logger.warn(`[email] forward failed: ${himalayaErrorText(r)}`); json(res, { error: himalayaErrorText(r) }, 502); return true }
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
    const composeSentMailbox = await mailboxFor(data.account as string, 'sent')
    const args = ['-a', data.account as string, 'message', 'compose', '--from', accountEmail(data.account as string), '-t', data.to.trim(), '--body', data.text, '--send', '--save', composeSentMailbox]
    if (data.cc?.trim()) args.push('--cc', data.cc.trim())
    if (data.subject?.trim()) args.push('-s', data.subject.trim())
    const r = await himalaya(args)
    if (!r.ok) { logger.warn(`[email] compose failed: ${himalayaErrorText(r)}`); json(res, { error: himalayaErrorText(r) }, 502); return true }
    invalidateEnvelopeCache(data.account as string, composeSentMailbox)
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
    if (!r.ok) { logger.warn(`[email] flag ${sub} failed: ${himalayaErrorText(r)}`); json(res, { error: himalayaErrorText(r) }, 502); return true }
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
    if (!r.ok) { logger.warn(`[email] flag ${sub} (flagged) failed: ${himalayaErrorText(r)}`); json(res, { error: himalayaErrorText(r) }, 502); return true }
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
    const importantMailbox = await mailboxFor(data.account as string, 'important')
    if (data.important === false) {
      // Gmail assigns a DIFFERENT UID to the same message in every label
      // mailbox (verified live: an Inbox id of 112006 showed up as 22061 in
      // Fontos) -- data.id is only valid in `mailbox`, not in Fontos, so
      // removing the label means first finding ITS OWN id there via the
      // RFC822 Message-ID header, which is stable across labels.
      if (!data.messageId) { json(res, { error: 'messageId required to unmark important' }, 400); return true }
      const list = await himalaya(['-a', data.account as string, 'envelope', 'list', '-m', importantMailbox, '-p', '1', '-s', '50', '--json'])
      if (!list.ok) { logger.warn(`[email] unmark important lookup failed: ${himalayaErrorText(list)}`); json(res, { error: himalayaErrorText(list) }, 502); return true }
      let fontosId: string | undefined
      try {
        const envelopes = JSON.parse(list.stdout).envelopes || []
        fontosId = envelopes.find((e: { 'message-id'?: string }) => e['message-id'] === data.messageId)?.id
      } catch { /* fall through to not-found below */ }
      if (!fontosId) { json(res, { error: 'message not found in Fontos (older than the last 50?)' }, 404); return true }
      const store = await himalaya(['-a', data.account as string, 'imap', 'store', fontosId, '-f', '\\Deleted', '-m', importantMailbox])
      if (!store.ok) { logger.warn(`[email] unmark important store failed: ${himalayaErrorText(store)}`); json(res, { error: himalayaErrorText(store) }, 502); return true }
      const expunge = await himalaya(['-a', data.account as string, 'imap', 'expunge', importantMailbox])
      if (!expunge.ok) { logger.warn(`[email] unmark important expunge failed: ${himalayaErrorText(expunge)}`); json(res, { error: himalayaErrorText(expunge) }, 502); return true }
      invalidateEnvelopeCache(data.account as string, importantMailbox)
      invalidateImportantFlagCache(data.account as string)
      json(res, { ok: true })
      return true
    }
    const r = await himalaya(['-a', data.account as string, 'message', 'copy', data.id, '-f', mailbox, '-t', importantMailbox])
    if (!r.ok) { logger.warn(`[email] mark important failed: ${himalayaErrorText(r)}`); json(res, { error: himalayaErrorText(r) }, 502); return true }
    invalidateEnvelopeCache(data.account as string, importantMailbox)
    invalidateImportantFlagCache(data.account as string)
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
      if (!r.ok) { logger.warn(`[email] label (move to ${data.target}) failed for ${id}: ${himalayaErrorText(r)}`); failed.push(id) }
    }
    invalidateEnvelopeCache(data.account as string, data.target)
    invalidateEnvelopeCache(data.account as string, mailbox)
    if (failed.length === data.ids.length) { json(res, { error: 'himalaya failed for all messages' }, 502); return true }
    json(res, { ok: true, failed })
    return true
  }

  // Tanult felado-szabalyok (Boss, 2026-08-15: "ha spambe huzom akkor jeloje
  // meg es a jovobeni leveleket azonnal a spambe iranyitsa").
  //
  // Miert kell hozza kulon vegpont, es miert nem eleg a level athuzasa: a
  // mozgatas EGY levelrol szol, a szabaly a FELADOROL. A ketto kulon is
  // ertelmes -- a Boss visszavonhatja a szabalyt anelkul, hogy a mar
  // atmozgatott levelek visszajonnenek.
  if (path === '/api/email/rules' && method === 'GET') {
    const account = url.searchParams.get('account')
    if (!isKnownAccount(account)) { json(res, { error: 'unknown account' }, 400); return true }
    const rules = loadRules().filter((r) => r.account === account)
    json(res, { rules })
    return true
  }

  if (path === '/api/email/rules' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; kind?: string; senders?: unknown }
    const kind = data.kind === 'spam' || data.kind === 'promo' ? (data.kind as EmailRuleKind) : null
    if (!isKnownAccount(data.account ?? null) || !kind || !Array.isArray(data.senders)) {
      json(res, { error: 'account, kind (spam|promo) and senders required' }, 400); return true
    }
    let rules: EmailRule[] = loadRules()
    const before = rules.length
    for (const s of data.senders) rules = addRule(rules, kind, data.account as string, String(s ?? ''))
    if (rules.length !== before) saveRules(rules)
    // A szabaly AZONNAL hasson: a bejovo lista gyorsitotara kulonben meg a
    // regi (szures elotti) valtozatot adna vissza egy percig.
    invalidateEnvelopeCache(data.account as string, 'Inbox')
    json(res, { ok: true, added: rules.length - before, rules: rules.filter((r) => r.account === data.account) })
    return true
  }

  if (path === '/api/email/rules' && method === 'DELETE') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; kind?: string; sender?: string }
    const kind = data.kind === 'spam' || data.kind === 'promo' ? (data.kind as EmailRuleKind) : null
    if (!isKnownAccount(data.account ?? null) || !kind || !data.sender) {
      json(res, { error: 'account, kind and sender required' }, 400); return true
    }
    const rules = removeRule(loadRules(), kind, data.account as string, data.sender)
    saveRules(rules)
    invalidateEnvelopeCache(data.account as string, 'Inbox')
    json(res, { ok: true, rules: rules.filter((r) => r.account === data.account) })
    return true
  }

  if (path === '/api/email/delete' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { account?: string; mailbox?: string; id?: string }
    if (!isKnownAccount(data.account ?? null) || !data.id) { json(res, { error: 'account and id required' }, 400); return true }
    const mailbox = data.mailbox || 'Inbox'
    const trashMailbox = await mailboxFor(data.account as string, 'trash')
    // Gmail-IMAP trash semantics: UID MOVE (RFC 6851) into "[Gmail]/Kuka" both
    // removes the message from the source mailbox and files it into Trash --
    // this is what a normal Gmail client's delete button does (30-day
    // recoverable), unlike /api/email/archive which only unlabels Inbox.
    // Clicking Törlés from WITHIN Trash itself means "delete forever" --
    // mark \Deleted + expunge, same mechanism as archive but scoped to Kuka.
    // This used to just error out, leaving the button looking clickable but
    // permanently disabled after one click (Boss, 2026-08-05).
    if (mailbox === trashMailbox) {
      const store = await himalaya(['-a', data.account as string, 'imap', 'store', data.id, '-f', '\\Deleted', '-m', mailbox])
      if (!store.ok) { logger.warn(`[email] permanent delete store failed: ${himalayaErrorText(store)}`); json(res, { error: himalayaErrorText(store) }, 502); return true }
      const expunge = await himalaya(['-a', data.account as string, 'imap', 'expunge', mailbox])
      if (!expunge.ok) { logger.warn(`[email] permanent delete expunge failed: ${himalayaErrorText(expunge)}`); json(res, { error: himalayaErrorText(expunge) }, 502); return true }
      purgeAttachmentCacheForMessage(data.account as string, mailbox, data.id)
      purgeMessageBodyCache(data.account as string, mailbox, data.id)
      invalidateEnvelopeCache(data.account as string, mailbox)
      json(res, { ok: true })
      return true
    }
    const r = await himalaya(['-a', data.account as string, 'message', 'move', data.id, '-f', mailbox, '-t', trashMailbox])
    if (!r.ok) { logger.warn(`[email] delete (move to trash) failed: ${himalayaErrorText(r)}`); json(res, { error: himalayaErrorText(r) }, 502); return true }
    purgeMessageBodyCache(data.account as string, mailbox, data.id)
    invalidateEnvelopeCache(data.account as string, mailbox)
    invalidateEnvelopeCache(data.account as string, trashMailbox)
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
    if (!store.ok) { logger.warn(`[email] archive store failed: ${himalayaErrorText(store)}`); json(res, { error: himalayaErrorText(store) }, 502); return true }
    const expunge = await himalaya(['-a', data.account as string, 'imap', 'expunge', mailbox])
    if (!expunge.ok) { logger.warn(`[email] archive expunge failed: ${himalayaErrorText(expunge)}`); json(res, { error: himalayaErrorText(expunge) }, 502); return true }
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

// Indulas utani elomelegites. Merve 2026-08-19-en: ujraindulas utan az ELSO
// email-betoltes 12,3 mp (mappa-oszlop) es 19,3 mp (levellista), mert minden
// memoria-cache ures ES az IMAP-kapcsolat is hideg -- ugyanaz a betoltes
// melegen 0,85 mp. Minden telepites utan az elso latogato fizette ki ezt.
// Most a szerver fizeti ki, akkor, amikor meg senki nem var ra.
//
// Sorosan, fiokonkent: parhuzamosan inditva ugyanazt a torlodast csinalnank,
// ami elol menekulunk. Hiba eseten csak naplozunk -- egy elomelegites sosem
// akadalyozhatja meg a dashboard indulasat.
export async function warmEmailCaches(): Promise<void> {
  for (const acc of getAccounts()) {
    try {
      const mailboxes = await fetchMailboxList(acc.id)
      if (mailboxes.ok) cacheSet(mailboxListCache, acc.id, mailboxes.mailboxes, MAILBOX_LIST_TTL_MS, MAILBOX_STALE_MAX_MS)
      const query = normalizeEmailSearchQuery(null)
      const key = envelopeCacheKeyFor(acc.id, 'Inbox', 1, query, false)
      const envelopes = await fetchEnvelopeList(acc.id, 'Inbox', 1, 50, query, false)
      if (envelopes.ok) cacheSet(envelopeListCache, key, envelopes.envelopes, ENVELOPE_LIST_TTL_MS, ENVELOPE_STALE_MAX_MS)
      // A lista MELLE kert ket kiegeszites (Fontos-jelzok, Sent-testverek) --
      // ezek nelkul a lista ugyan megjelenik, de a csillagok es a valasz-sorok
      // csak masodpercekkel kesobb.
      await loadImportantMessageIds(acc.id)
      await loadSentEnvelopes(acc.id)
    } catch (err) {
      logger.warn(`[email] elomelegites elhasalt (${acc.id}): ${err}`)
    }
  }
}
