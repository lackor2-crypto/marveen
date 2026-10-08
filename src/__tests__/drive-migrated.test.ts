import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEPOT_DRIVE, DEPOT_MEGA } from '../depot.js'
import { dropMigrated, isMigratedPath, loadMigrated, noteMovedOutOfMirror } from '../drive-migrated.js'
import { planMegaDownload } from '../mega-download.js'

describe('drive-migrated (#513 one copy)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migr-'))
  const path = join(dir, 'm.json')
  it('records only moves from the mirror to outside', () => {
    const from = `${DEPOT_DRIVE}/acc/Mappa/a.pdf`
    expect(noteMovedOutOfMirror(from, 'Korpás László/media/a.pdf', path)).toBe(true)
    expect(noteMovedOutOfMirror(from, `${DEPOT_DRIVE}/acc/Masik/a.pdf`, path)).toBe(false)
    expect(noteMovedOutOfMirror('Elet/x.pdf', 'Elet/y/x.pdf', path)).toBe(false)
    expect(loadMigrated(path)).toHaveLength(1)
  })
  it('a moved folder covers the files below it', () => {
    noteMovedOutOfMirror(`${DEPOT_MEGA}/acc/Fotok`, 'Korpás László/Fotok', path)
    const l = loadMigrated(path)
    expect(isMigratedPath(`${DEPOT_MEGA}/acc/Fotok/2020/b.jpg`, l)).toBe(true)
    expect(isMigratedPath(`${DEPOT_MEGA}/acc/Fotok2/b.jpg`, l)).toBe(false)
  })
  it('drops entries on request', () => {
    expect(dropMigrated((e) => e.from.endsWith('a.pdf'), path)).toBe(1)
    expect(loadMigrated(path)).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })
  it('MEGA plan skips migrated files', () => {
    const plan = planMegaDownload(
      [{ rel: 'Fotok/b.jpg', size: 5 }, { rel: 'Egyeb/c.txt', size: 3 }],
      { files: [], truncated: false, unreachable: false } as any,
      ['Fotok'],
    )
    expect(plan.download.map((f) => f.rel)).toEqual(['Egyeb/c.txt'])
    expect(plan.skippedMigrated).toBe(1)
  })
})
