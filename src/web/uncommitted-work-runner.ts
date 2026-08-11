// The I/O half of the uncommitted-work guard (see src/uncommitted-work.ts).
//
// Reads `git status --porcelain` on a slow timer, and tells the owner when work
// has been sitting uncommitted long enough to be at risk. Never commits, never
// stashes, never touches a file: an automatic commit of somebody's half-finished
// edit would create a broken state that LOOKS deliberate, which is worse than
// the mess it tidies.
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { sendAlert } from './channel-monitor.js'
import {
  INITIAL_UNCOMMITTED_STATE,
  describeUncommitted,
  dirtySignature,
  shouldAlertUncommitted,
  staleDirtyFiles,
  type DirtyFile,
  type UncommittedAlertState,
} from '../uncommitted-work.js'

// Hourly is plenty for a three-hour threshold, and the offset keeps it off the
// same tick as every other watcher.
export const UNCOMMITTED_INITIAL_DELAY_MS = 6 * 60_000
export const UNCOMMITTED_INTERVAL_MS = 60 * 60_000

let state: UncommittedAlertState = { ...INITIAL_UNCOMMITTED_STATE }

/** Test seam. */
export function _resetUncommittedForTest(): void {
  state = { ...INITIAL_UNCOMMITTED_STATE }
}

function gitStatusPorcelain(): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', ['-C', PROJECT_ROOT, 'status', '--porcelain'], { timeout: 20_000 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

/** Parse porcelain output into paths, dropping untracked files: a scratch file
 *  nobody has staged is not "work at risk", and untracked noise would keep the
 *  signature churning. */
export function parseDirtyPaths(porcelain: string): string[] {
  const out: string[] = []
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    if (code === '??') continue
    // Rename lines read "R  old -> new"; the new path is the one that exists.
    const raw = line.slice(3)
    const path = raw.includes(' -> ') ? raw.split(' -> ')[1] : raw
    out.push(path.trim().replace(/^"|"$/g, ''))
  }
  return out
}

async function tick(): Promise<void> {
  try {
    const porcelain = await gitStatusPorcelain()
    if (porcelain === null) return
    const now = Date.now()
    const files: DirtyFile[] = []
    for (const path of parseDirtyPaths(porcelain)) {
      try {
        files.push({ path, modifiedAt: statSync(join(PROJECT_ROOT, path)).mtimeMs })
      } catch { /* deleted file: nothing to lose, skip */ }
    }
    const stale = staleDirtyFiles(files, now)
    if (!shouldAlertUncommitted(stale, state)) {
      // Remember a clean tree so the NEXT mess is reported as news.
      if (stale.length === 0 && state.lastSignature) state = { ...state, lastSignature: '' }
      return
    }
    state = { lastSignature: dirtySignature(stale), lastAlertAt: now }
    logger.info({ uncommitted: stale.map(f => f.path) }, 'uncommitted work has been sitting in the working tree')
    sendAlert(describeUncommitted(stale, now))
  } catch (err) {
    logger.warn({ err }, 'uncommitted-work watcher: tick error')
  }
}

export function startUncommittedWorkWatcher(): NodeJS.Timeout {
  setTimeout(() => { void tick() }, UNCOMMITTED_INITIAL_DELAY_MS).unref()
  return setInterval(() => { void tick() }, UNCOMMITTED_INTERVAL_MS)
}
