// TEMPORARY forensic watcher for Claude login files. REMOVE AFTER 2027-01-16.
//
// Why it exists (Boss, 2026-10-16, card #653): the main agent's isolated login
// (<config dir>/.credentials.json) was found emptied (tokens "" and expiresAt 0)
// with no log line saying who or what did it. Next time it happens the log has
// to answer that. Every 15 s it looks at the credentials file of the main agent,
// the install default and every registered Claude account, and writes ONE JSON
// line to store/credential-forensics.log whenever one of them changes: before
// and after shape, file mtime/size, and which claude processes were running
// against that config dir at that moment. It also notes the moment a refresh
// token passes its own expiry date.
//
// It NEVER writes token values: only lengths, expiry stamps and states.
//
// Removal: delete this file, its test, the startCredentialForensics() call in
// src/index.ts and this module's mention in the card. After SUNSET_MS the
// watcher stops by itself and logs a one-time reminder, so it cannot linger.
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { readClaudePlans } from './claude-plans.js'
import { mainAgentEffectiveConfigDir } from './agent-config.js'

export const SUNSET_MS = Date.parse('2027-01-16T00:00:00+01:00')
export const FORENSICS_INTERVAL_MS = 15_000
const LOG_PATH = join(STORE_DIR, 'credential-forensics.log')
const MAX_LOG_BYTES = 2_000_000

export type CredState = 'missing' | 'unreadable' | 'empty' | 'present'

export interface CredSummary {
  state: CredState
  accessLen: number
  refreshLen: number
  expiresAt: number
  refreshExpiresAt: number
}

/** Shape of a credentials file: lengths and stamps only, never the secrets. */
export function summarizeCredentials(raw: string | null): CredSummary {
  const none = { accessLen: 0, refreshLen: 0, expiresAt: 0, refreshExpiresAt: 0 }
  if (raw === null) return { state: 'missing', ...none }
  let o: Record<string, unknown> | undefined
  try {
    const j = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }
    o = j && typeof j === 'object' ? j.claudeAiOauth : undefined
  } catch { return { state: 'unreadable', ...none } }
  if (!o || typeof o !== 'object') return { state: 'empty', ...none }
  const len = (v: unknown) => (typeof v === 'string' ? v.length : 0)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const s: CredSummary = {
    state: 'present',
    accessLen: len(o['accessToken']),
    refreshLen: len(o['refreshToken']),
    expiresAt: num(o['expiresAt']),
    refreshExpiresAt: num(o['refreshTokenExpiresAt']),
  }
  if (s.accessLen === 0 && s.refreshLen === 0) s.state = 'empty'
  return s
}

/** A short label for what changed, or null when nothing worth a line did. */
export function describeChange(prev: CredSummary | undefined, cur: CredSummary): string | null {
  if (!prev) return 'baseline'
  if (prev.state !== cur.state) return `${prev.state} -> ${cur.state}`
  if (prev.refreshLen !== cur.refreshLen || prev.accessLen !== cur.accessLen) return 'token length changed'
  if (prev.refreshExpiresAt !== cur.refreshExpiresAt) return 'refresh expiry moved'
  if (prev.expiresAt !== cur.expiresAt) return 'access token rotated'
  return null
}

/** True from SUNSET_MS on: the watcher must stop and say it is due for removal. */
export function pastSunset(now: number): boolean {
  return now >= SUNSET_MS
}

export function watchedConfigDirs(): string[] {
  const dirs = new Set<string>()
  dirs.add(join(homedir(), '.claude'))
  try { dirs.add(mainAgentEffectiveConfigDir()) } catch { /* resolver not ready */ }
  try { for (const p of readClaudePlans()) if (p.configDir) dirs.add(p.configDir) } catch { /* no registry */ }
  return [...dirs]
}

interface ProcInfo { pid: number; ppid: number; cmd: string }

/** Linux only: claude processes whose CLAUDE_CONFIG_DIR is this dir (or unset, for the default). */
function claudeProcessesFor(dir: string): ProcInfo[] {
  const out: ProcInfo[] = []
  let pids: string[] = []
  try { pids = readdirSync('/proc').filter(n => /^\d+$/.test(n)) } catch { return out }
  const isDefault = dir === join(homedir(), '.claude')
  for (const pid of pids) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').join(' ').trim()
      if (!/\bclaude\b/.test(cmd) || cmd.length === 0) continue
      const env = readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0')
      const cfg = env.find(e => e.startsWith('CLAUDE_CONFIG_DIR='))?.slice('CLAUDE_CONFIG_DIR='.length)
      if (cfg ? cfg !== dir : !isDefault) continue
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0
      out.push({ pid: Number(pid), ppid, cmd: cmd.slice(0, 160) })
    } catch { /* process ended or not readable */ }
  }
  return out.slice(0, 12)
}

function writeLine(entry: Record<string, unknown>): void {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_LOG_BYTES) {
      const tail = readFileSync(LOG_PATH, 'utf-8').split('\n').slice(-2000).join('\n')
      writeFileSync(LOG_PATH, tail)
    }
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
  } catch (err) {
    logger.warn({ err }, 'credential-forensics: could not write the log')
  }
}

const last = new Map<string, CredSummary>()
const expiredNoted = new Set<string>()

export function forensicsTick(now = Date.now()): void {
  for (const dir of watchedConfigDirs()) {
    const file = join(dir, '.credentials.json')
    let raw: string | null = null
    let mtime = 0
    let size = 0
    try {
      const st = statSync(file)
      mtime = st.mtimeMs
      size = st.size
      raw = readFileSync(file, 'utf-8')
    } catch { raw = null }
    const cur = summarizeCredentials(raw)
    const what = describeChange(last.get(dir), cur)
    const prev = last.get(dir)
    last.set(dir, cur)
    if (what) {
      const bad = cur.state !== 'present' && prev?.state === 'present'
      writeLine({
        ts: new Date(now).toISOString(), dir, event: what, before: prev ?? null, after: cur,
        fileMtime: mtime ? new Date(mtime).toISOString() : null, fileSize: size,
        ...(bad || what === 'baseline' ? { claudeProcesses: claudeProcessesFor(dir) } : {}),
      })
    }
    if (cur.state === 'present' && cur.refreshExpiresAt > 0 && now > cur.refreshExpiresAt && !expiredNoted.has(dir)) {
      expiredNoted.add(dir)
      writeLine({
        ts: new Date(now).toISOString(), dir, event: 'refresh token passed its own expiry date',
        after: cur, claudeProcesses: claudeProcessesFor(dir),
      })
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startCredentialForensics(): void {
  if (process.env['CRED_FORENSICS'] === '0') return
  if (timer) return
  if (pastSunset(Date.now())) {
    logger.warn('credential-forensics: past its sunset date (2027-01-16) -- remove src/web/credential-forensics.ts')
    return
  }
  const tick = () => {
    try {
      if (pastSunset(Date.now())) {
        if (timer) clearInterval(timer)
        timer = null
        logger.warn('credential-forensics: sunset reached, watcher stopped -- remove src/web/credential-forensics.ts')
        return
      }
      forensicsTick()
    } catch (err) {
      logger.warn({ err }, 'credential-forensics: tick failed')
    }
  }
  timer = setInterval(tick, FORENSICS_INTERVAL_MS)
  timer.unref?.()
  setTimeout(tick, 5_000).unref?.()
}
