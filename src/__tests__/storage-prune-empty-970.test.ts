import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneEmptyStorageDirs } from '../storage-prune.js'
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

describe('#970 wiring', () => {
  it('the Storages list route triggers the prune', async () => {
    const { readFileSync } = await import('node:fs')
    const s = readFileSync(join(__dirname, '..', 'web', 'routes', 'storages.ts'), 'utf8')
    expect(s).toContain('pruneEmptyStorageDirs(root)')
  })
})
