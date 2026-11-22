// #970: an account folder under Rendszer/Tárolók/{Drive,GOOGLE_PHOTOS,MEGA} that holds no file any more (its contents were
// moved into the Life tree) disappears, so the tree shows only what has something in it (Boss TG 7390/7401).
//
// Safe by construction: only directories are ever removed (rmdir, which refuses a non-empty one), and only when the whole
// subtree holds no regular file except Windows folder junk (desktop.ini, Thumbs.db). Git account folders are skipped: adding
// a Git account makes its folder on purpose. Async fs only: the dashboard thread must not wait on a slow disk.
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.js'
import { DEPOT_DRIVE, DEPOT_MEGA, DEPOT_PHOTOS } from './depot.js'

const JUNK = new Set(['desktop.ini', 'thumbs.db'])

/**
 * True when the folder tree holds no real file. Collects the junk files and folders (deepest first) to delete.
 * It stops at the FIRST real file: a non-empty account (the normal case, maybe a million files) is never walked whole,
 * because nothing is removed from it anyway. Files of a folder are checked before its sub-folders are entered.
 */
async function scan(dir: string, junk: string[], dirs: string[]): Promise<boolean> {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return false }
  const subdirs: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) subdirs.push(p)
    else if (e.isFile() && JUNK.has(e.name.toLowerCase())) junk.push(p)
    else return false
  }
  for (const p of subdirs) if (!(await scan(p, junk, dirs))) return false
  dirs.push(dir)
  return true
}

export async function pruneEmptyStorageDirs(root: string | null): Promise<{ removed: string[] }> {
  const removed: string[] = []
  if (!root) return { removed }
  for (const kindRel of [DEPOT_DRIVE, DEPOT_PHOTOS, DEPOT_MEGA]) {
    const kindAbs = join(root, kindRel)
    let accounts
    try { accounts = await fsp.readdir(kindAbs, { withFileTypes: true }) } catch { continue }
    for (const a of accounts) {
      if (!a.isDirectory()) continue
      const abs = join(kindAbs, a.name)
      const junk: string[] = []
      const dirs: string[] = []
      if (!(await scan(abs, junk, dirs))) continue
      try {
        for (const j of junk) await fsp.unlink(j)
        for (const d of dirs) await fsp.rmdir(d) // deepest first; rmdir refuses a non-empty folder
        removed.push(`${kindRel}/${a.name}`)
      } catch { /* a folder that filled up meanwhile simply stays */ }
    }
  }
  return { removed }
}

// A prune is asked for by every view of the tree (Storages page, Life tree under System), so it is shared and spaced out:
// one run at a time, and a new run only when the last one is older than the gap. A view waits for it only briefly.
let lastAt = 0
let inflight: Promise<void> | null = null

export function pruneEmptyStorageDirsThrottled(root: string | null, gapMs = 15_000): Promise<void> {
  if (!root) return Promise.resolve()
  if (inflight) return inflight
  if (Date.now() - lastAt < gapMs) return Promise.resolve()
  lastAt = Date.now()
  inflight = pruneEmptyStorageDirs(root)
    .then(() => undefined, (e) => { logger.warn({ err: String(e) }, '[storages] empty account folder sweep failed') })
    .finally(() => { inflight = null })
  return inflight
}

/** Waits for `p` at most `ms`; never rejects. A slow disk therefore delays the listing by `ms` at the very most. */
export async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([p.catch(() => undefined), new Promise((r) => { timer = setTimeout(r, ms) })])
  } finally { if (timer) clearTimeout(timer) }
}

/** Test hook: forget the spacing so the next call runs at once. */
export function resetPruneThrottleForTests(): void { lastAt = 0 }
