import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneEmptyStorageDirs, pruneEmptyStorageDirsThrottled, resetPruneThrottleForTests, settleWithin } from '../storage-prune.js'
import { DEPOT_DRIVE, DEPOT_MEGA, DEPOT_PROJECTS } from '../depot.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'prune970-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const mk = (rel: string, file?: string) => { mkdirSync(join(root, rel), { recursive: true }); if (file) writeFileSync(join(root, rel, file), 'x') }

describe('#970 empty storage account folders disappear', () => {
  it('removes an account folder holding only empty subfolders and desktop.ini/Thumbs.db', async () => {
    mk(`${DEPOT_MEGA}/acc1/sub/deeper`, undefined)
    writeFileSync(join(root, DEPOT_MEGA, 'acc1', 'desktop.ini'), 'x')
    writeFileSync(join(root, DEPOT_MEGA, 'acc1', 'sub', 'Thumbs.db'), 'x')
    const r = await pruneEmptyStorageDirs(root)
    expect(existsSync(join(root, DEPOT_MEGA, 'acc1'))).toBe(false)
    expect(r.removed).toContain(`${DEPOT_MEGA}/acc1`)
    expect(existsSync(join(root, DEPOT_MEGA))).toBe(true) // the kind root stays
  })
  it('never touches a folder that has a real file anywhere inside', async () => {
    mk(`${DEPOT_DRIVE}/acc2/a/b`, 'keep.txt')
    mk(`${DEPOT_DRIVE}/acc3`)
    await pruneEmptyStorageDirs(root)
    expect(existsSync(join(root, DEPOT_DRIVE, 'acc2', 'a', 'b', 'keep.txt'))).toBe(true)
    expect(existsSync(join(root, DEPOT_DRIVE, 'acc3'))).toBe(false)
  })
  it('leaves Git account folders alone (an added Git account is a deliberate empty folder)', async () => {
    mk(`${DEPOT_PROJECTS}/gitacc`)
    await pruneEmptyStorageDirs(root)
    expect(existsSync(join(root, DEPOT_PROJECTS, 'gitacc'))).toBe(true)
  })
  it('is a no-op without a root', async () => {
    expect((await pruneEmptyStorageDirs(null)).removed).toEqual([])
  })
})

describe('#970 follow-up: cheap on a non-empty account, usable from every view', () => {
  afterEach(() => { vi.restoreAllMocks(); resetPruneThrottleForTests() })

  it('stops at the first real file: a non-empty account is not walked whole (slow-disk law)', async () => {
    mk(`${DEPOT_DRIVE}/big`, 'top.txt')
    for (let i = 0; i < 40; i++) mk(`${DEPOT_DRIVE}/big/dir${i}/inner`, 'f.txt')
    const spy = vi.spyOn(fsp, 'readdir')
    await pruneEmptyStorageDirs(root)
    // the 3 kind folders + the one account folder; the 40 sub-folders are never entered
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6)
    expect(existsSync(join(root, DEPOT_DRIVE, 'big', 'dir39', 'inner', 'f.txt'))).toBe(true)
  })

  it('the throttled sweep removes the emptied folder before the awaited call returns, and spaces repeats out', async () => {
    mk(`${DEPOT_MEGA}/gone`)
    await settleWithin(pruneEmptyStorageDirsThrottled(root), 1500)
    expect(existsSync(join(root, DEPOT_MEGA, 'gone'))).toBe(false)
    mk(`${DEPOT_MEGA}/again`)
    await pruneEmptyStorageDirsThrottled(root) // inside the gap: no second scan
    expect(existsSync(join(root, DEPOT_MEGA, 'again'))).toBe(true)
    await pruneEmptyStorageDirsThrottled(root, 0) // gap over: swept
    expect(existsSync(join(root, DEPOT_MEGA, 'again'))).toBe(false)
  })

  it('settleWithin gives up on a slow sweep after the limit and never rejects', async () => {
    const t0 = Date.now()
    await settleWithin(new Promise(() => {}), 50)
    expect(Date.now() - t0).toBeLessThan(1000)
    await expect(settleWithin(Promise.reject(new Error('x')), 50)).resolves.toBeUndefined()
  })
})

describe('#970 wiring', () => {
  it('the Storages list route and the Life tree listing under System both trigger the sweep', async () => {
    const { readFileSync } = await import('node:fs')
    const dir = join(__dirname, '..', 'web', 'routes')
    expect(readFileSync(join(dir, 'storages.ts'), 'utf8')).toContain('pruneEmptyStorageDirsThrottled(root)')
    expect(readFileSync(join(dir, 'life.ts'), 'utf8')).toContain('pruneEmptyStorageDirsThrottled(depotRoot())')
  })
})
