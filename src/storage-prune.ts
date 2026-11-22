// #970: an account folder under Rendszer/Tárolók/{Drive,GOOGLE_PHOTOS,MEGA} that holds no file any more (its contents were
// moved into the Life tree) disappears, so the tree shows only what has something in it (Boss TG 7390/7401).
//
// Safe by construction: only directories are ever removed (rmdir, which refuses a non-empty one), and only when the whole
// subtree holds no regular file except Windows folder junk (desktop.ini, Thumbs.db). Git account folders are skipped: adding
// a Git account makes its folder on purpose. Async fs only: the dashboard thread must not wait on a slow disk.
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { DEPOT_DRIVE, DEPOT_MEGA, DEPOT_PHOTOS } from './depot.js'

const JUNK = new Set(['desktop.ini', 'thumbs.db'])

/** True when the folder tree holds no real file. Collects the junk files and folders (deepest first) to delete. */
async function scan(dir: string, junk: string[], dirs: string[]): Promise<boolean> {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return false }
  let empty = true
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!(await scan(p, junk, dirs))) empty = false }
    else if (e.isFile() && JUNK.has(e.name.toLowerCase())) junk.push(p)
    else empty = false
  }
  if (empty) dirs.push(dir)
  return empty
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
