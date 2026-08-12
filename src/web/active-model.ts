import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Claude Code writes one .jsonl session log per session under
// ~/.claude/projects/<encoded-working-dir>/. Every assistant turn carries the
// model id that answered it. We use that to surface the *live* running model
// (vs. the configured value in agent-config.json), so the dashboard can show
// what the running process is actually using, including across restarts.
//
// When an agent is launched with --continue, Claude Code appends to the same
// session jsonl across restarts, so the latest "model" field may reflect a
// pre-restart turn rather than the freshly-spawned process. Callers that know
// when the current session started should pass sinceUnixSec; we then ignore
// any line whose own timestamp predates that, leaving the caller to fall back
// to the configured model until the new session writes its first turn.
const cache = new Map<string, { value: string | null; expiresAt: number }>()
const TTL_MS = 3000

// Resolve the session-log directory Claude Code writes for a working dir.
// Logs live under <config-root>/projects/<encoded-working-dir>/, where the
// config root is ~/.claude by default but an alternate one when the agent was
// launched with CLAUDE_CONFIG_DIR. Pass that absolute config root as configDir
// so we read the right project dir for agents on a non-default config.
export function projectsDirFor(workingDir: string, configDir?: string, homeDirOverride?: string): string {
  const base = configDir ?? join(homeDirOverride ?? homedir(), '.claude')
  const encoded = workingDir.replace(/[/.]/g, '-')
  return join(base, 'projects', encoded)
}

// Pick the transcript that belongs to the LIVE session.
//
// "Newest .jsonl by mtime" is wrong, and it silently killed the context gate
// for three of four agents (Boss reported it 2026-08-12). Claude Code rewrites
// a handful of timestamp-less metadata lines (last-prompt, mode,
// permission-mode, custom-title) into a session file long after that session
// stopped producing turns -- a `/rename Gypsy` left behind an 8-line file whose
// mtime was NEWER than the live 113 KB transcript. Reading that stub finds no
// usage, so the gate reported "context-tokens-unmeasurable (fail-closed)" and
// never compacted anything, for gypsy and usalackor both.
//
// So rank candidates by the newest TIMESTAMPED entry inside the file (real
// content), falling back to mtime only when a file carries no timestamp at all.
// A genuinely fresh session still wins -- its content is the newest -- so this
// never resurrects an old heavy session in place of a live young one.
const CANDIDATE_LIMIT = 6            // newest-by-mtime files worth ranking
const TAIL_PROBE_BYTES = 64 * 1024   // enough to reach the last timestamp

function lastContentTimestampMs(path: string, size: number): number | null {
  try {
    let text: string
    if (size <= TAIL_PROBE_BYTES) {
      text = readFileSync(path, 'utf-8')
    } else {
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(TAIL_PROBE_BYTES)
        const read = readSync(fd, buf, 0, TAIL_PROBE_BYTES, size - TAIL_PROBE_BYTES)
        text = buf.subarray(0, read).toString('utf-8')
      } finally { closeSync(fd) }
    }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const ts = JSON.parse(line)?.timestamp
        if (typeof ts !== 'string') continue
        const ms = new Date(ts).getTime()
        if (Number.isFinite(ms)) return ms
      } catch { /* partial first line of a tail read, or malformed */ }
    }
  } catch { /* unreadable: fall back to mtime */ }
  return null
}

function newestTranscript(dir: string): string | null {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const p = join(dir, f)
      const st = statSync(p)
      return { path: p, mtime: st.mtimeMs, size: st.size }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, CANDIDATE_LIMIT)
  if (files.length === 0) return null
  let best = files[0]
  let bestRank = lastContentTimestampMs(best.path, best.size) ?? best.mtime
  for (const f of files.slice(1)) {
    const rank = lastContentTimestampMs(f.path, f.size) ?? f.mtime
    if (rank > bestRank) { best = f; bestRank = rank }
  }
  return best.path
}

export function readActiveModelFromProjectDir(workingDir: string, sinceUnixSec?: number, configDir?: string): string | null {
  const now = Date.now()
  const cacheKey = `${workingDir}:${sinceUnixSec ?? ''}:${configDir ?? ''}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.value
  let value: string | null = null
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (!existsSync(dir)) {
      cache.set(cacheKey, { value: null, expiresAt: now + TTL_MS })
      return null
    }
    const transcript = newestTranscript(dir)
    if (transcript === null) {
      cache.set(cacheKey, { value: null, expiresAt: now + TTL_MS })
      return null
    }
    const content = readFileSync(transcript, 'utf-8')
    const lines = content.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        const msg = entry?.message
        const model = msg?.model
        if (typeof model !== 'string' || model.startsWith('<')) continue
        if (sinceUnixSec !== undefined) {
          const ts = entry?.timestamp
          if (typeof ts !== 'string') continue
          const lineUnix = Math.floor(new Date(ts).getTime() / 1000)
          if (!Number.isFinite(lineUnix) || lineUnix < sinceUnixSec) continue
        }
        value = model
        break
      } catch { /* skip malformed JSON line */ }
    }
  } catch { /* fall through */ }
  cache.set(cacheKey, { value, expiresAt: now + TTL_MS })
  return value
}

/**
 * Why a context size is missing matters, because the two causes need opposite
 * handling:
 *
 *   'measured' -- we have a real number.
 *   'fresh'    -- we found the live transcript and it has not run a turn yet.
 *                 That is the SMALLEST possible context, not an unknown one, so
 *                 blocking on it must not escalate into a "measurement broken"
 *                 alert the way fail-closed does.
 *   'no-usage' -- the transcript has turns, but every usage record on them is
 *                 zero. That is what a quota-limited agent looks like: each turn
 *                 gets a <synthetic> reply that never reached the API. The size
 *                 is genuinely unknown here, so this stays fail-closed.
 *   'unknown'  -- no transcript directory, no transcript, or a read error. Also
 *                 fail-closed.
 */
export type ContextReadingState = 'measured' | 'fresh' | 'no-usage' | 'unknown'
export interface ContextReading { tokens: number | null; state: ContextReadingState }

const ctxCache = new Map<string, { value: ContextReading; expiresAt: number }>()

// Current context size of the live session, in tokens. Claude Code records a
// `usage` object on each assistant turn; the context that gets re-read every
// turn is input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// (output_tokens is the new reply, not context). We scan the newest transcript
// from the end for the last turn carrying a usage and sum those three. Returns
// null when there is no transcript / no usage yet (fresh session). This is what
// the dashboard surfaces so the operator can see a session growing heavy and
// decide to restart it.
//
// Compaction caveat: `usage` is only emitted on an API call. Right after a
// `/compact` the session sits idle with no new turn, so the newest `usage` is
// still the PRE-compaction (large) one — the dashboard would keep showing the
// old heavy number and compaction would look broken. Claude Code writes a
// `system`/`compact_boundary` entry carrying `compactMetadata.postTokens` (the
// real resident size after compaction). So when we reach that boundary while
// scanning backward BEFORE finding any post-compaction usage, we return
// postTokens instead of the stale pre-compaction figure.
export function readContextReadingFromProjectDir(workingDir: string, configDir?: string): ContextReading {
  const now = Date.now()
  const cacheKey = `${workingDir}:${configDir ?? ''}`
  const cached = ctxCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.value
  let reading: ContextReading = { tokens: null, state: 'unknown' }
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (existsSync(dir)) {
      const transcript = newestTranscript(dir)
      if (transcript !== null) {
        const content = readFileSync(transcript, 'utf-8')
        const lines = content.split('\n')
        // The transcript is there and readable; from here on the only question
        // is whether it carries a number, so anything short of that is 'fresh'
        // (a live session with no API accounting), never 'unknown'.
        reading = { tokens: null, state: 'fresh' }
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim()
          if (!line) continue
          try {
            const entry = JSON.parse(line)
            // A turn happened here even if it carries no numbers: distinguishes
            // "session never ran" from "session ran and we cannot size it".
            if (entry?.type === 'assistant' && reading.state === 'fresh') {
              reading = { tokens: null, state: 'no-usage' }
            }
            // Post-compaction and still idle: no fresh usage exists yet, so the
            // authoritative current size is the boundary's postTokens.
            if (entry?.type === 'system' && entry?.subtype === 'compact_boundary') {
              const post = Number(entry?.compactMetadata?.postTokens)
              if (Number.isFinite(post) && post > 0) { reading = { tokens: post, state: 'measured' }; break }
              // Boundary without a usable postTokens: treat as fresh (empty),
              // never fall through to the stale pre-compaction usage below.
              break
            }
            const u = entry?.message?.usage
            if (u && typeof u === 'object') {
              const inp = Number(u.input_tokens) || 0
              const cr = Number(u.cache_read_input_tokens) || 0
              const cc = Number(u.cache_creation_input_tokens) || 0
              const total = inp + cr + cc
              if (total > 0) { reading = { tokens: total, state: 'measured' }; break }
            }
          } catch { /* skip malformed JSON line */ }
        }
      }
    }
  } catch { /* fall through as 'unknown' */ }
  ctxCache.set(cacheKey, { value: reading, expiresAt: now + TTL_MS })
  return reading
}

/** Tokens only. Callers that need to tell 'fresh' from 'unknown' (the context
 *  gate) must use readContextReadingFromProjectDir instead. */
export function readContextTokensFromProjectDir(workingDir: string, configDir?: string): number | null {
  return readContextReadingFromProjectDir(workingDir, configDir).tokens
}
