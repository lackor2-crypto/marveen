// #894 (Boss, TG 5843): the dashboard froze again and again, two weeks, each time in another place. Root cause: the depot
// lives on a Windows drive (WSL/9p, ~7 ms per file call) and the main thread touches it with synchronous calls. This guard
// SIMULATES that slowness (every sync file call busy-waits) and fails when ONE request (or one timer pass) holds the event
// loop longer than the limit, so every hot path is found at once, not by the next complaint.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const slow = vi.hoisted(() => ({ on: false, ms: 5, calls: 0 }))
function wait(): void {
  if (!slow.on) return
  slow.calls++
  const end = performance.now() + slow.ms
  while (performance.now() < end) { /* a 9p round trip */ }
}
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const wrap = <F extends (...a: any[]) => any>(f: F): F => ((...a: any[]) => { wait(); return f(...a) }) as F
  const patched: Record<string, unknown> = { ...real }
  for (const k of ['statSync', 'lstatSync', 'existsSync', 'realpathSync', 'readdirSync', 'readFileSync', 'accessSync', 'readlinkSync']) {
    patched[k] = wrap((real as any)[k])
  }
  // realpathSync.native is used by some callers
  ;(patched['realpathSync'] as any).native = wrap((real.realpathSync as any).native)
  return { ...patched, default: patched }
})

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { attachAsset } from '../workbench-assets.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { setBackupRule } from '../backup-rules.js'
import { reconcileLifeFolderIds, anchoredFolders } from '../life-folder-ids.js'
import { listWorkFoldersYielding } from '../workbench-assets.js'

/** Longest time the event loop was NOT given back while `run` was going on. */
async function longestHold<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  let last = performance.now()
  let worst = 0
  let stop = false
  const tick = (): void => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
    if (!stop) setImmediate(tick)
  }
  setImmediate(tick)
  const value = await run()
  stop = true
  await new Promise<void>((r) => setImmediate(r))
  worst = Math.max(worst, performance.now() - last)
  return { ms: worst, value }
}

/** The loop may be held at most this long by one pass (Boss saw warnings from 3 s; the watch itself starts at 0.3 s). */
const LIMIT_MS = 300

describe('#894: no request holds the loop on a slow (9p-like) depot', () => {
  let depot = ''
  let itemId = ''
  beforeAll(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-stall-guard-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Sok anyag', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    // an item with many materials (the real one holds 163)
    for (let i = 0; i < 160; i++) { const r = attachAsset(w.item, `anyag-${i}.md`, Buffer.from(String(i))); if (!r.ok) throw new Error('anyag') }
    // ~25 folders some registry knows by path (the real depot has about that many)
    for (let i = 0; i < 25; i++) { mkdirSync(join(depot, 'Cegek', `K${i}`), { recursive: true }); setBackupRule({ path: `Cegek/K${i}`, action: 'none' }) }
    ;(globalThis as any).__guardProject = p.project.id
  })
  afterAll(() => { slow.on = false; rmSync(depot, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  const hot: Array<[string, () => string]> = [
    ['GET the assets of an item with 160 materials', () => `/api/workbench/items/${itemId}/assets`],
    ['GET one work item (with its materials)', () => `/api/workbench/items/${itemId}`],
    ['GET the work item list of a project', () => `/api/workbench/items?project=${(globalThis as any).__guardProject}`],
  ]
  for (const [name, path] of hot) {
    it(`${name} gives the loop back within ${LIMIT_MS} ms`, async () => {
      slow.on = true
      slow.calls = 0
      const r = await longestHold(() => callWorkbench(path(), 'GET'))
      slow.on = false
      expect(r.value.status).toBe(200)
      // the simulation really was in the path (#915: the list walk now asks the drive mostly through async, concurrent
      // reads, so fewer sync calls remain than the 50+ it used to make; the 300 ms hold limit below is unchanged)
      expect(slow.calls).toBeGreaterThan(20)
      expect(r.ms).toBeLessThan(LIMIT_MS)
    }, 60_000)
  }

  // Timer passes (no request in flight): the warnings that said "nem futott kérés".
  const timers: Array<[string, () => Promise<unknown>]> = [
    ['the life folder id pass (anchoredFolders > git check)', () => reconcileLifeFolderIds()],
    ['the anchored folder check', () => anchoredFolders()],
    ['the work folder list of a project', async () => { const { getProject } = await import('../projects.js'); const pr = getProject((globalThis as any).__guardProject); return pr ? listWorkFoldersYielding(pr) : null }],
  ]
  for (const [name, run] of timers) {
    it(`${name} gives the loop back within ${LIMIT_MS} ms`, async () => {
      slow.on = true
      slow.calls = 0
      const r = await longestHold(run)
      slow.on = false
      expect(r.ms).toBeLessThan(LIMIT_MS)
    }, 60_000)
  }
})
