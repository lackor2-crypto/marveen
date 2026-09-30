/**
 * KEEPS THE WINDOWS CLAUDE CODE OF THE VS CODE CODE BRIDGE CURRENT (#446).
 *
 * The Workbench code bridge runs in the owner's VS Code on WINDOWS, a program
 * separate from the Claude install on this (WSL) machine that
 * `claude-cli-updater.ts` keeps current. Measured 2026-09-30: Windows ran
 * Claude Code 2.1.226, so every bridge task died with "API Error: 400 Claude
 * Code 2.1.226 does not support this model; version 2.1.280 or newer is
 * required".
 *
 * When the bridge reports exactly that, this module updates the Windows
 * program from WSL (`powershell.exe ... claude update`) so the caller can
 * retry the task. Guard rails:
 *
 *   - at most ONE update attempt per hour, whatever the outcome (no loops);
 *   - it only runs when the Windows program is really older than the version
 *     the error asks for (measured, not guessed);
 *   - it installs a program on the owner's machine, so it follows the
 *     `package_install` autonomy level: level 3 acts alone, below that an
 *     approval ticket is opened and the update waits for the answer;
 *   - on a machine without WSL / Windows PowerShell it stays silent
 *     (`not_applicable`), so a fresh Linux or macOS install is unaffected.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { MAIN_AGENT_ID, STORE_DIR } from './config.js'
import { AUTONOMY_CONFIG_PATH, effectiveLevel, loadAutonomyConfig } from './autonomy.js'
import { createApproval, getDb } from './db.js'
import type { Approval } from './db.js'
import { logger } from './logger.js'

const execFileAsync = promisify(execFile)

/** Windows PowerShell as WSL sees it; it is not on the PATH, so the full path is needed. */
export const WINDOWS_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
export const WINDOWS_UPDATE_STATE_PATH = join(STORE_DIR, 'windows-claude-update.json')
/** No second attempt within this time, successful or not. */
export const WINDOWS_UPDATE_MIN_GAP_MS = 60 * 60 * 1000
export const WINDOWS_UPDATE_CATEGORY = 'package_install'
export const WINDOWS_UPDATE_KIND = 'windows_claude_update'
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000

export type WindowsUpdateStatus =
  | 'not_applicable' // no Windows here, or the Windows program is not the problem
  | 'updated'        // version grew: retry the task
  | 'no_change'      // the update ran, the version did not grow
  | 'failed'         // the update command failed
  | 'too_soon'       // one attempt per hour
  | 'needs_approval' // package_install is below level 3: waiting for the owner

export interface WindowsUpdateOutcome {
  status: WindowsUpdateStatus
  before: string
  after: string
  /** Human sentences for the chat (HU / EN). Empty for `not_applicable`. */
  message: string
  messageEn: string
  checkedAt: string
}

interface UpdateState extends Omit<WindowsUpdateOutcome, 'status'> {
  status: WindowsUpdateStatus
  attemptedAt: number
  usedApprovalId?: string
}

export interface WindowsUpdateDeps {
  now(): number
  powershellPath: string
  exists(path: string): boolean
  /** Run a PowerShell command; resolves with stdout, rejects with the failure. */
  runPowershell(command: string, timeoutMs: number): Promise<string>
  /** The package_install level of the acting agent (1..3). */
  level(): number
  loadState(): UpdateState | null
  saveState(s: UpdateState): void
  /** Latest ticket of this kind, and a way to open a new one. */
  latestApproval(): Approval | undefined
  openApproval(description: string, payload: string): void
  statePath?: string
}

/** `2.1.226` and `2.1.280` from "Claude Code 2.1.226 does not support this model; version 2.1.280 or newer is required". */
export function parseOutdatedVersions(text: string): { have: string; need: string } {
  const have = /Claude Code\s+v?(\d+\.\d+\.\d+)/i.exec(text)?.[1] ?? ''
  const need = /(?:version\s+)?v?(\d+\.\d+\.\d+)\s+or newer/i.exec(text)?.[1] ?? ''
  return { have, need }
}

export function parseCliVersion(out: string): string {
  const m = /(\d+\.\d+\.\d+)/.exec(String(out || ''))
  return m ? m[1] : ''
}

/** <0, 0, >0 like a comparator; a missing version sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/** Is there a Windows to update from here at all (WSL with Windows PowerShell)? */
export function windowsUpdatePossible(exists: (p: string) => boolean = existsSync, path: string = WINDOWS_POWERSHELL): boolean {
  return process.platform === 'linux' && exists(path)
}

function realDeps(): WindowsUpdateDeps {
  return {
    now: () => Date.now(),
    powershellPath: WINDOWS_POWERSHELL,
    exists: existsSync,
    runPowershell: async (command, timeoutMs) => {
      const { stdout } = await execFileAsync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], {
        timeout: timeoutMs,
        cwd: '/mnt/c',
        windowsHide: true,
      })
      return String(stdout || '')
    },
    level: () => {
      try {
        const cfg = loadAutonomyConfig(AUTONOMY_CONFIG_PATH)
        const cat = cfg.categories.find((c) => c.key === WINDOWS_UPDATE_CATEGORY)
        return cat ? effectiveLevel(cat, MAIN_AGENT_ID, cfg) : 2
      } catch {
        return 2
      }
    },
    loadState: () => {
      try {
        if (!existsSync(WINDOWS_UPDATE_STATE_PATH)) return null
        const o = JSON.parse(readFileSync(WINDOWS_UPDATE_STATE_PATH, 'utf-8'))
        return o && typeof o === 'object' && !Array.isArray(o) ? (o as UpdateState) : null
      } catch { return null }
    },
    saveState: (s) => {
      try { writeFileSync(WINDOWS_UPDATE_STATE_PATH, JSON.stringify(s, null, 2) + '\n') } catch { /* convenience only */ }
    },
    latestApproval: () => {
      try {
        return getDb().prepare(
          'SELECT * FROM approvals WHERE category = ? AND action_payload LIKE ? ORDER BY requested_at DESC, rowid DESC LIMIT 1',
        ).get(WINDOWS_UPDATE_CATEGORY, `%${WINDOWS_UPDATE_KIND}%`) as Approval | undefined
      } catch { return undefined }
    },
    openApproval: (description, payload) => {
      createApproval({ id: randomUUID(), agent_id: MAIN_AGENT_ID, category: WINDOWS_UPDATE_CATEGORY, action_description: description, action_payload: payload })
    },
  }
}

function outcome(status: WindowsUpdateStatus, before: string, after: string, hu: string, en: string, now: number): WindowsUpdateOutcome {
  return { status, before, after, message: hu, messageEn: en, checkedAt: new Date(now).toISOString() }
}

const NOT_APPLICABLE = (now: number): WindowsUpdateOutcome => outcome('not_applicable', '', '', '', '', now)

let inFlight: Promise<WindowsUpdateOutcome> | null = null

/**
 * Update the Windows Claude Code because the bridge said it is too old.
 * `errorText` is the bridge's own error sentence. Concurrent callers share one run.
 */
export function updateWindowsClaudeForBridge(errorText: string, deps: WindowsUpdateDeps = realDeps()): Promise<WindowsUpdateOutcome> {
  if (inFlight) return inFlight
  inFlight = run(errorText, deps).finally(() => { inFlight = null })
  return inFlight
}

async function run(errorText: string, deps: WindowsUpdateDeps): Promise<WindowsUpdateOutcome> {
  const now = deps.now()
  if (process.platform !== 'linux' || !deps.exists(deps.powershellPath)) return NOT_APPLICABLE(now)

  // Measure the Windows program itself: if it is not older than the error
  // asks for, the failing worker is some other install and this is no cure.
  const { need } = parseOutdatedVersions(errorText)
  let before = ''
  try { before = parseCliVersion(await deps.runPowershell('claude --version', 30_000)) } catch { /* no claude on the Windows PATH */ }
  if (!before) return NOT_APPLICABLE(now)
  if (need && compareVersions(before, need) >= 0) return NOT_APPLICABLE(now)

  const state = deps.loadState()
  if (state && now - state.attemptedAt < WINDOWS_UPDATE_MIN_GAP_MS) {
    const wait = Math.max(1, Math.ceil((WINDOWS_UPDATE_MIN_GAP_MS - (now - state.attemptedAt)) / 60_000))
    return outcome(
      'too_soon', before, state.after || before,
      `A Windowsos Claude Code (${before}) még elavult, de a frissítést az elmúlt órában már megpróbáltam, ezért legkorábban ${wait} perc múlva próbálom újra.`,
      `The Windows Claude Code (${before}) is still out of date, but I already tried updating it in the last hour, so I will try again in ${wait} minutes at the earliest.`,
      now,
    )
  }

  let usedApprovalId: string | undefined
  if (deps.level() < 3) {
    const last = deps.latestApproval()
    if (last && last.status === 'approved' && last.id !== state?.usedApprovalId) {
      usedApprovalId = last.id
    } else {
      const recentlyAsked = last && now - last.requested_at * 1000 < WINDOWS_UPDATE_MIN_GAP_MS
      if (!(last && last.status === 'pending') && !recentlyAsked) {
        deps.openApproval(
          `A Munkapad kódhíd Windowsos Claude Code programja elavult (${before}${need ? `, ${need} vagy újabb kell` : ''}). Engedélyed kell, hogy a Marveen frissítse a Windows gépen (claude update).`,
          JSON.stringify({ kind: WINDOWS_UPDATE_KIND, before, need }),
        )
      }
      return outcome(
        'needs_approval', before, before,
        `A Windowsos Claude Code (${before}) elavult. A frissítéshez a Jóváhagyások oldalon kell engedélyt adnod (Csomag telepítés); utána azonnal magától frissül.`,
        `The Windows Claude Code (${before}) is out of date. Updating it needs your approval on the Approvals page (Package install); after that it updates by itself right away.`,
        now,
      )
    }
  }

  let ok = true
  let detail = ''
  try {
    await deps.runPowershell('claude update', UPDATE_TIMEOUT_MS)
  } catch (err) {
    ok = false
    detail = String((err as { stderr?: string; message?: string })?.stderr || (err as Error)?.message || err).trim().split('\n').slice(-2).join(' ')
  }
  let after = before
  try { after = parseCliVersion(await deps.runPowershell('claude --version', 30_000)) || before } catch { /* keep before */ }
  const grew = compareVersions(after, before) > 0
  const status: WindowsUpdateStatus = grew ? 'updated' : ok ? 'no_change' : 'failed'
  const result = status === 'updated'
    ? outcome(status, before, after,
      `A Windowsos Claude Code frissült: ${before} -> ${after}. A feladatot újra elindítom.`,
      `The Windows Claude Code was updated: ${before} -> ${after}. I am starting the task again.`, now)
    : status === 'no_change'
      ? outcome(status, before, after,
        `A Windowsos Claude Code frissítése lefutott, de a verzió nem nőtt (${before}). Kézzel kell megnézni a Windows gépen (claude update).`,
        `The Windows Claude Code update ran but the version did not grow (${before}). Please check it by hand on the Windows machine (claude update).`, now)
      : outcome(status, before, after,
        `A Windowsos Claude Code frissítése nem sikerült (${before} maradt). Hibaüzenet: ${detail}`,
        `Updating the Windows Claude Code failed (${before} kept). Error: ${detail}`, now)
  deps.saveState({ ...result, attemptedAt: now, usedApprovalId: usedApprovalId ?? state?.usedApprovalId })
  logger.info({ status, before, after }, 'Windows Claude Code update for the code bridge')
  return result
}

/**
 * The owner just approved the update ticket this module opened: run it NOW.
 * Without this the approval only took effect on the NEXT bridge message, so an
 * approved update sat idle (Boss 2026-09-29: "erre mar adtam jovahagyast!").
 * Returns null when the approval is not this module's ticket, so the approvals
 * route can call it for every approved package_install without checking.
 */
export function windowsUpdateFromApproval(
  approval: Pick<Approval, 'category' | 'status' | 'action_payload'>,
  deps?: WindowsUpdateDeps,
): Promise<WindowsUpdateOutcome> | null {
  if (approval.category !== WINDOWS_UPDATE_CATEGORY || approval.status !== 'approved') return null
  let payload: { kind?: string; before?: string; need?: string } = {}
  try { payload = JSON.parse(approval.action_payload || '{}') } catch { return null }
  if (payload.kind !== WINDOWS_UPDATE_KIND) return null
  // Rebuild the bridge's own sentence so the version guard inside run() sees
  // exactly what it would have seen on a failing task.
  const errorText = `Claude Code ${payload.before || '0.0.0'} does not support this model; version ${payload.need || ''} or newer is required`
  return updateWindowsClaudeForBridge(errorText, deps)
}
