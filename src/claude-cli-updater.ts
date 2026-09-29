/**
 * KEEPS THE INSTALLED CLAUDE PROGRAM CURRENT, SO NEW MODELS SHOW UP.
 *
 * The model dropdowns learn about new Claude models by reading the INSTALLED
 * Claude program (`claude-model-discovery.ts`). That only helps if the program
 * itself gets updated -- and on a Marvin install nothing did:
 *
 *   - every agent session runs with DISABLE_AUTOUPDATER=1 (concurrent
 *     self-updates raced and wiped the binary, see scripts/channels.sh);
 *   - the one remaining updater in channels.sh runs `npm install -g`, which
 *     never touches a NATIVE install (~/.local/share/claude/versions/...), the
 *     kind the official installer sets up today.
 *
 * Measured 2026-09-29: the box ran 2.1.283 while 2.1.284 was out, and only
 * 2.1.284 knows `claude-sonnet-5-5` -- so the owner could not pick Sonnet 5.5.
 *
 * This module is the single, serialized update point inside the dashboard:
 * a fixed daily schedule (early morning, early afternoon, late evening) plus a
 * button in the model settings. After every update it re-measures the program
 * and registers the new ids, so they are selectable and savable at once,
 * without a dashboard restart.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { APP_TZ, STORE_DIR } from './config.js'
import { findClaudeBinary, scanInstalledClaude, type ClaudeModelScan } from './claude-model-discovery.js'
import { registerDiscoveredClaudeModels } from './config-registry.js'
import { logger } from './logger.js'

const execFileAsync = promisify(execFile)

export const CLAUDE_CLI_UPDATE_STATE_PATH = join(STORE_DIR, 'claude-cli-update.json')

/** Local hours of the automatic checks (owner: at least twice, early morning and late evening). */
export const CLAUDE_UPDATE_HOURS = [5, 14, 22]

export type ClaudeInstallKind = 'native' | 'npm' | 'pinned' | 'missing'

export interface ClaudeUpdateResult {
  ok: boolean
  kind: ClaudeInstallKind
  before: string
  after: string
  updated: boolean
  /** Human sentence, shown in the UI and the log. */
  message: string
  messageEn: string
  checkedAt: string
  scan?: ClaudeModelScan
}

/** Native installs live under `.../claude/versions/<ver>`; everything else is npm. */
export function installKindFromPath(realPath: string | null): ClaudeInstallKind {
  if (!realPath) return 'missing'
  const p = realPath.replace(/\\/g, '/')
  if (/\/claude\/versions\/[^/]+$/.test(p)) return 'native'
  return 'npm'
}

/**
 * AVX-less x86 hosts run a pinned Node-based claude (see channels.sh
 * CLAUDE_PIN): "keep it current" is exactly what breaks them, so never update.
 */
export function isAvxLessHost(cpuinfo?: string): boolean {
  let text = cpuinfo
  if (text === undefined) {
    if (process.platform !== 'linux') return false
    try { text = readFileSync('/proc/cpuinfo', 'utf-8') } catch { return false }
  }
  if (!/^flags\s*:/m.test(text)) return false
  return !/\bavx\b/i.test(text)
}

/** `2.1.284 (Claude Code)` -> `2.1.284`. */
export function parseCliVersion(out: string): string {
  const m = /(\d+\.\d+\.\d+)/.exec(String(out || ''))
  return m ? m[1] : ''
}

async function installedVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 15000 })
    return parseCliVersion(String(stdout || ''))
  } catch {
    return ''
  }
}

/** The environment of the update call: the fleet-wide autoupdate kill switch must not reach it. */
export function updateEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.DISABLE_AUTOUPDATER
  return env
}

function saveState(r: ClaudeUpdateResult): void {
  try {
    const { scan: _scan, ...rest } = r
    writeFileSync(CLAUDE_CLI_UPDATE_STATE_PATH, JSON.stringify(rest, null, 2) + '\n')
  } catch { /* the state file is a convenience; the update itself already happened */ }
}

export function loadUpdateState(): Omit<ClaudeUpdateResult, 'scan'> | null {
  try {
    if (!existsSync(CLAUDE_CLI_UPDATE_STATE_PATH)) return null
    const o = JSON.parse(readFileSync(CLAUDE_CLI_UPDATE_STATE_PATH, 'utf-8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}

async function runUpdate(): Promise<ClaudeUpdateResult> {
  const checkedAt = new Date().toISOString()
  const bin = await findClaudeBinary()
  let kind = installKindFromPath(bin)
  if (kind !== 'missing' && isAvxLessHost()) kind = 'pinned'
  const before = await installedVersion()
  const base = { kind, before, after: before, updated: false, checkedAt }

  if (kind === 'missing') {
    return { ...base, ok: false, message: 'A Claude programot nem találtam a gépen (a „claude" parancs nincs az elérési úton), ezért frissíteni sem tudom.', messageEn: 'The Claude program was not found on this machine (the "claude" command is not on the PATH), so it cannot be updated.' }
  }
  if (kind === 'pinned') {
    return { ...base, ok: true, message: `Ez a gép processzora régebbi (AVX nélküli), ezért itt a Claude program szándékosan rögzített verzión fut (${before || '?'}), nem frissítem.`, messageEn: `This machine has an older (AVX-less) processor, so the Claude program is deliberately pinned here (${before || '?'}) and is not updated.` }
  }

  try {
    if (kind === 'native') {
      await execFileAsync('claude', ['update'], { timeout: 5 * 60 * 1000, env: updateEnv(), cwd: STORE_DIR })
    } else {
      await execFileAsync('npm', ['install', '-g', '@anthropic-ai/claude-code@latest'], { timeout: 5 * 60 * 1000, env: updateEnv() })
    }
  } catch (err) {
    const detail = String((err as { stderr?: string; message?: string })?.stderr || (err as Error)?.message || err).trim().split('\n').slice(-2).join(' ')
    return { ...base, ok: false, message: `A Claude program frissítése nem sikerült (${before || 'ismeretlen verzió'} maradt). Hibaüzenet: ${detail}`, messageEn: `Updating the Claude program failed (${before || 'unknown version'} kept). Error: ${detail}` }
  }

  const after = (await installedVersion()) || before
  const updated = !!after && after !== before
  return {
    ...base, ok: true, after, updated,
    message: updated
      ? `A Claude program frissült: ${before || '?'} -> ${after}.`
      : `A Claude program naprakész (${after || '?'}).`,
    messageEn: updated
      ? `The Claude program was updated: ${before || '?'} -> ${after}.`
      : `The Claude program is up to date (${after || '?'}).`,
  }
}

let inFlight: Promise<ClaudeUpdateResult> | null = null

/**
 * Update the program, then re-measure its model list and register the new ids.
 * Concurrent callers (the schedule and the button) share ONE run: two parallel
 * updates of the same install are what wiped the binary before.
 */
export function refreshClaudeModels(): Promise<ClaudeUpdateResult> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const r = await runUpdate()
    try {
      const scan = await scanInstalledClaude(true)
      registerDiscoveredClaudeModels(scan.models.map((m) => m.id))
      r.scan = scan
    } catch (err) {
      logger.warn({ err }, 'Claude model re-scan after update failed')
    }
    saveState(r)
    logger.info({ kind: r.kind, before: r.before, after: r.after, ok: r.ok, newModels: r.scan?.models.map((m) => m.id) }, 'Claude program update check')
    return r
  })().finally(() => { inFlight = null })
  return inFlight
}

/** Which slot (date + hour, in the install's time zone) a moment falls in, or null outside the update hours. */
export function updateSlot(d: Date, hours: number[] = CLAUDE_UPDATE_HOURS, tz: string = APP_TZ): string | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  const h = Number(get('hour'))
  if (!hours.includes(h)) return null
  return `${get('year')}-${get('month')}-${get('day')}-${h}`
}

/** Stale = never checked, or the last check is older than the longest gap between two slots. */
export function isCheckStale(lastIso: string | undefined, now: Date = new Date()): boolean {
  const t = lastIso ? Date.parse(lastIso) : NaN
  if (!Number.isFinite(t)) return true
  return now.getTime() - t > 12 * 60 * 60 * 1000
}

let timer: NodeJS.Timeout | null = null

export function startClaudeCliUpdateScheduler(): void {
  if (timer) return
  let lastSlot: string | null = null
  const tick = () => {
    const slot = updateSlot(new Date())
    if (!slot || slot === lastSlot) return
    lastSlot = slot
    refreshClaudeModels().catch((err) => logger.warn({ err }, 'Scheduled Claude update failed'))
  }
  timer = setInterval(tick, 60 * 1000)
  timer.unref?.()
  // A box that was off during the slots would otherwise wait up to a day.
  if (isCheckStale(loadUpdateState()?.checkedAt)) {
    const t = setTimeout(() => {
      refreshClaudeModels().catch((err) => logger.warn({ err }, 'Startup Claude update failed'))
    }, 2 * 60 * 1000)
    t.unref?.()
  }
}
