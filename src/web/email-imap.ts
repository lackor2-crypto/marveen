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

// Exported for tests only -- not part of the module's real entry point.
export const _internal = { parseHimalayaToml, parseImapServer }
