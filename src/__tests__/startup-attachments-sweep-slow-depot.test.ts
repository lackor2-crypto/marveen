// #887: the startup attachments sweep (ensureAllAttachmentsFoldersAsync) must not hold the event loop for one work item's
// whole provisioning, on a slow (9p-like) depot. The earlier fix yielded between the ~20 note probes, but
// provisionStandardFolders (7+ once-folders, each several stat calls, plus the letter/sub-document checks) still ran in ONE step.
// This test SIMULATES the slow drive (every sync file call busy-waits) and measures the longest hold of the loop.
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
  ;(patched['realpathSync'] as any).native = wrap((real.realpathSync as any).native)
  return { ...patched, default: patched }
})

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { attachAsset, ensureAllAttachmentsFoldersAsync } from '../workbench-assets.js'

/** Most file calls made without the loop being given back. Counted in calls (each costs 5 ms here), not wall time, so a
 *  loaded CI machine cannot make the test flaky. */
async function longestHold<T>(run: () => Promise<T>): Promise<{ calls: number; value: T }> {
  let lastCalls = slow.calls
  let worst = 0
  let stop = false
  const tick = (): void => {
    worst = Math.max(worst, slow.calls - lastCalls)
    lastCalls = slow.calls
    if (!stop) setImmediate(tick)
  }
  setImmediate(tick)
  const value = await run()
  stop = true
  await new Promise<void>((r) => setImmediate(r))
  worst = Math.max(worst, slow.calls - lastCalls)
  return { calls: worst, value }
}

describe('#887: the startup attachments sweep gives the loop back inside one work item on a slow depot', () => {
  let depot = ''
  beforeAll(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-sweep-887-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Sweep 887' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    for (let i = 0; i < 4; i++) { const w = createWorkItem({ project_id: p.project.id, title: `Munkadarab ${i}`, type: 'note' }); if (!w.ok) throw new Error('munkadarab'); const a = attachAsset(w.item, 'anyag.md', Buffer.from('x')); if (!a.ok) throw new Error('anyag') }
  })
  afterAll(() => { slow.on = false; rmSync(depot, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  it('the sweep never makes more than 24 file calls (120 ms at 5 ms each) without giving the loop back', async () => {
    await ensureAllAttachmentsFoldersAsync() // first pass makes the folders (not measured)
    slow.on = true
    slow.calls = 0
    const r = await longestHold(() => ensureAllAttachmentsFoldersAsync())
    slow.on = false
    expect(r.value.items).toBeGreaterThan(0)
    expect(slow.calls).toBeGreaterThan(50) // the simulation really was in the path
    console.log('most calls in one hold', r.calls, 'of', slow.calls)
    expect(r.calls).toBeLessThanOrEqual(24)
  }, 60_000)
})
