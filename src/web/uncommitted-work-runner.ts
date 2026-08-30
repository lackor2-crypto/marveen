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
  describeMess,
  messSignature,
  shouldAlertMess,
  staleDirtyFiles,
  type DirtyFile,
  type TreeMess,
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
    // --untracked-files=all: a szemet gyakran egy alkonyvtarban ul, es az
    // alapertelmezett `normal` mod ilyenkor csak a KONYVTARAT irja ki egy
    // sorban. Egy sor "scratch/" nem mondja meg, hany fajl van benne.
    execFile('git', ['-C', PROJECT_ROOT, 'status', '--porcelain', '--untracked-files=all'], { timeout: 20_000 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

/** Hany commit all felpusholatlanul. null = NEM tudtam megkerdezni (nincs
 *  upstream, vagy a git nem valaszolt) -- ez nem ugyanaz, mint a nulla, es a
 *  hivo nem is mondja ki nullakent. */
function gitUnpushedCount(): Promise<number | null> {
  return new Promise(resolve => {
    execFile('git', ['-C', PROJECT_ROOT, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve(null)
      const n = Number.parseInt(stdout.trim(), 10)
      resolve(Number.isFinite(n) ? n : null)
    })
  })
}

function gitBranch(): Promise<string> {
  return new Promise(resolve => {
    execFile('git', ['-C', PROJECT_ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 20_000 }, (err, stdout) => {
      resolve(err ? '' : stdout.trim())
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

function withMtime(paths: string[]): DirtyFile[] {
  const out: DirtyFile[] = []
  for (const path of paths) {
    try {
      out.push({ path, modifiedAt: statSync(join(PROJECT_ROOT, path)).mtimeMs })
    } catch { /* deleted file: nothing to lose, skip */ }
  }
  return out
}

/** A NEM-kovetett (`??`) utak. Ezeket a parseDirtyPaths szandekosan eldobja --
 *  es pontosan ezert allt 2026-08-29-en nyolc probaszkript egy napig a repo
 *  gyokereben anelkul, hogy barmi szolt volna miatta. */
export function parseStrayPaths(porcelain: string): string[] {
  const out: string[] = []
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue
    if (line.slice(0, 2) !== '??') continue
    out.push(line.slice(3).trim().replace(/^"|"$/g, ''))
  }
  return out
}

async function tick(): Promise<void> {
  try {
    const porcelain = await gitStatusPorcelain()
    if (porcelain === null) return
    const now = Date.now()
    const [unpushed, branch] = await Promise.all([gitUnpushedCount(), gitBranch()])
    const mess: TreeMess = {
      dirty: staleDirtyFiles(withMtime(parseDirtyPaths(porcelain)), now),
      stray: staleDirtyFiles(withMtime(parseStrayPaths(porcelain)), now),
      unpushed,
      branch,
    }
    if (!shouldAlertMess(mess, state)) {
      // Remember a clean tree so the NEXT mess is reported as news.
      const sig = messSignature(mess)
      if (sig !== state.lastSignature && state.lastSignature) state = { ...state, lastSignature: '' }
      return
    }
    state = { lastSignature: messSignature(mess), lastAlertAt: now }
    logger.info({
      uncommitted: mess.dirty.map(f => f.path),
      stray: mess.stray.map(f => f.path),
      unpushed: mess.unpushed,
    }, 'work left behind in the working tree')
    const szoveg = describeMess(mess, now)
    if (szoveg) sendAlert(szoveg)
  } catch (err) {
    logger.warn({ err }, 'uncommitted-work watcher: tick error')
  }
}

export function startUncommittedWorkWatcher(): NodeJS.Timeout {
  setTimeout(() => { void tick() }, UNCOMMITTED_INITIAL_DELAY_MS).unref()
  return setInterval(() => { void tick() }, UNCOMMITTED_INTERVAL_MS)
}
