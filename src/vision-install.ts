/**
 * LOCAL FACE RECOGNIZER -- INSTALL FROM THE DASHBOARD (kanban f97acc32, audit C).
 *
 * The audit found that the face recognizer (Iroda / Inbox: "whose photo is
 * this?") was never installed on a fresh machine: `scripts/install-vision.sh`
 * existed, but no installer ran it and there was no button for it. A user who
 * is not a programmer had no way to get it.
 *
 * This module is that button's backend. Two steps, like the voice installer:
 *   1. the build tools (cmake, a C compiler, tesseract, poppler, python venv)
 *      need admin rights, so we only DETECT them and hand back the one line to
 *      paste -- per package manager, so it is the line that works on this box;
 *   2. everything else (venv + pip + the helper scripts) needs no root, so we
 *      run `install-vision.sh` ourselves, in the background, with its output in
 *      `store/vision-install.log`. A failure is shown from that log, never
 *      guessed.
 *
 * dlib comes as a prebuilt wheel (a few minutes); only a machine without one
 * compiles it, which takes 10-20 minutes: expected, not a hang.
 *
 * #514 (owner, 2026-10-09: "az elso telepitessel telepuljon onmagatol"): the
 * installers run the script on every fresh install, and `autoInstallVision()`
 * runs it on dashboard start when it is still missing -- an older install or
 * one whose installer step failed gets it without anyone pressing a button.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from './config.js'
import { logger } from './logger.js'
import { detectPkgManager, type PkgManager } from './system-deps.js'
import { VISION_DIR, faceInstalled, initVisionAdapters } from './life-vision-adapter.js'

export const VISION_INSTALL_LOG = join(STORE_DIR, 'vision-install.log')

/**
 * What `install-vision.sh` cannot do without. Since #514 dlib comes as a
 * prebuilt wheel, so cmake + a C compiler are needed only on a machine with no
 * matching wheel -- the script checks that itself and names the line in its
 * log. tesseract / pdftoppm only feed the OCR helper at run time: the script
 * warns about them, it does not stop.
 */
const BUILD_TOOLS: Array<{ id: string; check: string[] }> = [
  { id: 'python3-venv', check: ['python3', '-m', 'venv', '--help'] },
]

/** Which build tools are missing. Each is asked directly -- no guessing. */
export function missingBuildTools(
  run: (cmd: string, args: string[]) => boolean = (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 10_000 })
    return !r.error && r.status === 0
  },
): string[] {
  return BUILD_TOOLS.filter(t => !run(t.check[0], t.check.slice(1))).map(t => t.id)
}

/** The one line to paste, for THIS machine's package manager. `null`: we do
 *  not know the package manager, the dashboard shows the download page then. */
export function buildToolsCommand(pm: PkgManager): string | null {
  if (pm === 'apt') return 'sudo apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-hun cmake build-essential poppler-utils python3-venv python3-dev'
  if (pm === 'dnf') return 'sudo dnf install -y tesseract tesseract-langpack-hun cmake gcc-c++ make poppler-utils python3-devel'
  if (pm === 'brew') return 'brew install tesseract tesseract-lang cmake poppler'
  return null
}

let running = false
let lastExit: number | null = null
let finishedAt: number | null = null

export interface VisionInstallStatus {
  installed: boolean
  running: boolean
  /** Exit code of the last run started from here; null = none finished yet. */
  exit_code: number | null
  finished_at: number | null
  /** The end of the real log, so a failure is shown, not guessed. */
  log_tail: string | null
}

function readLogTail(maxBytes = 2000): string | null {
  try {
    const size = statSync(VISION_INSTALL_LOG).size
    const text = readFileSync(VISION_INSTALL_LOG, 'utf8')
    return size > maxBytes ? text.slice(-maxBytes) : text
  } catch { return null }
}

export function visionInstallStatus(): VisionInstallStatus {
  return {
    installed: faceInstalled(),
    running,
    exit_code: lastExit,
    finished_at: finishedAt,
    log_tail: lastExit !== null && lastExit !== 0 ? readLogTail() : null,
  }
}

export type StartResult =
  | { ok: true; alreadyInstalled: true }
  | { ok: true; started: true; alreadyRunning?: boolean }
  | { ok: false; needsSudo: true; missing: string[]; command: string | null }

/**
 * Start the install. Build tools missing -> hand back the line to paste (no
 * root from here, ever). Otherwise run `install-vision.sh` detached, so a
 * dashboard restart in the middle does not kill a 15-minute build.
 */
export function startVisionInstall(opts: { missing?: string[]; pm?: PkgManager } = {}): StartResult {
  if (faceInstalled()) return { ok: true, alreadyInstalled: true }
  if (running) return { ok: true, started: true, alreadyRunning: true }
  const missing = opts.missing ?? missingBuildTools()
  if (missing.length) {
    return { ok: false, needsSudo: true, missing, command: buildToolsCommand(opts.pm !== undefined ? opts.pm : detectPkgManager()) }
  }
  running = true
  lastExit = null
  const out = openSync(VISION_INSTALL_LOG, 'w')
  try {
    const child = spawn('bash', [join(PROJECT_ROOT, 'scripts', 'install-vision.sh')], {
      detached: true, stdio: ['ignore', out, out], env: process.env,
    })
    child.unref()
    child.on('error', (err) => {
      running = false; lastExit = -1; finishedAt = Date.now()
      logger.warn({ err }, 'arcfelismero telepites: nem indult el')
    })
    child.on('close', (code) => {
      running = false; lastExit = code ?? -1; finishedAt = Date.now()
      if (code === 0) {
        // Wire it in now, so it works without a dashboard restart.
        initVisionAdapters(true)
        logger.info('arcfelismero telepitve es bekotve')
      } else {
        logger.warn({ code, log: VISION_INSTALL_LOG }, 'arcfelismero telepites sikertelen')
      }
    })
  } finally {
    closeSync(out)
  }
  return { ok: true, started: true }
}

/** When the last automatic attempt ran: a failing install is retried once a
 *  day, not on every dashboard restart. */
export const VISION_AUTO_MARKER = join(VISION_DIR, 'autoinstall.json')
const AUTO_RETRY_MS = 24 * 60 * 60 * 1000

export type AutoInstallResult = 'installed' | 'started' | 'missing_tools' | 'recently_tried'

/**
 * Dashboard start: install the face recognizer by itself when it is missing.
 * Nothing to ask -- it needs no root (a missing python3-venv is only logged,
 * the wizard shows the paste line for it), and it runs detached, so the
 * dashboard is usable meanwhile.
 */
export function autoInstallVision(opts: { now?: number; missing?: string[] } = {}): AutoInstallResult {
  if (faceInstalled()) return 'installed'
  const now = opts.now ?? Date.now()
  try {
    const last = JSON.parse(readFileSync(VISION_AUTO_MARKER, 'utf8')) as { at?: number }
    if (typeof last.at === 'number' && now - last.at < AUTO_RETRY_MS) return 'recently_tried'
  } catch { /* no marker yet: first attempt */ }
  const r = startVisionInstall({ missing: opts.missing })
  if (!r.ok) {
    logger.warn({ missing: r.missing, command: r.command }, 'arcfelismero auto-telepites: hianyzo rendszereszkoz')
    return 'missing_tools'
  }
  try {
    mkdirSync(VISION_DIR, { recursive: true })
    writeFileSync(VISION_AUTO_MARKER, JSON.stringify({ at: now }))
  } catch { /* best effort */ }
  logger.info('arcfelismero auto-telepites elindult (store/vision-install.log)')
  return 'started'
}

/** Only for tests. */
export function _resetVisionInstall(): void { running = false; lastExit = null; finishedAt = null }

