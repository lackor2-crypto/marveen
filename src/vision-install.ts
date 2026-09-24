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
 * The dlib build takes 10-20 minutes: that is expected, not a hang.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from './config.js'
import { logger } from './logger.js'
import { detectPkgManager, type PkgManager } from './system-deps.js'
import { faceInstalled, initVisionAdapters } from './life-vision-adapter.js'

export const VISION_INSTALL_LOG = join(STORE_DIR, 'vision-install.log')

/** The build tools `install-vision.sh` checks for in its step 1. */
const BUILD_TOOLS: Array<{ id: string; check: string[] }> = [
  { id: 'tesseract', check: ['tesseract', '--version'] },
  { id: 'cmake', check: ['cmake', '--version'] },
  { id: 'gcc', check: ['gcc', '--version'] },
  { id: 'pdftoppm', check: ['pdftoppm', '-v'] },
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

/** Only for tests. */
export function _resetVisionInstall(): void { running = false; lastExit = null; finishedAt = null }

