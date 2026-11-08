// Boss, 2026-11-08 (#876): the temporary folder for an online upload -- clean names, marker-guarded removal, gone when "sent".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { safeName, packageNames, removeUploadPackage, uploadPackageInfo, sweepOldUploadPackages, PACKAGE_MARKER } from '../workbench-upload-package.js'
import { markSentManually } from '../workbench-docsent.js'

describe('clean names', () => {
  it('keeps German letters, drops characters Windows refuses', () => {
    expect(safeName('Abgabenbescheid der Minijob-Zentrale vom 04.07.2026')).toBe('Abgabenbescheid_der_Minijob-Zentrale_vom_04.07.2026')
    expect(safeName('a/b:c*d?"e<f>g|h')).toBe('a_b_c_d_e_f_g_h')
    expect(safeName('Prüfung über Straße')).toBe('Prüfung_über_Straße')
    expect(safeName('   ')).toBe('Dokument')
  })
  it('the letter is 00_..., every annex is <label>_<title>.pdf, names are unique', () => {
    const n = packageNames(
      [{ name: '01_2026-11-08_Bitte_um_Auskunft_v1.pdf', kind: 'document' }, { name: 'x.pdf', kind: 'annex' }, { name: 'y.pdf', kind: 'annex' }],
      [{ label: 'K1', title: 'Abgabenbescheid vom 04.07.2026' }, { label: 'K1', title: 'Abgabenbescheid vom 04.07.2026' }],
    )
    expect(n[0]).toBe('00_2026-11-08_Bitte_um_Auskunft_v1.pdf')
    expect(n[1]).toBe('K1_Abgabenbescheid_vom_04.07.2026.pdf')
    expect(n[2]).toBe('K1_Abgabenbescheid_vom_04.07.2026_2.pdf')
  })
})

describe('the folder lives and dies with the sending', () => {
  let root = ''
  beforeEach(() => { initDatabase(':memory:'); root = mkdtempSync(join(tmpdir(), 'wb-up-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  const make = (itemId: string, marker: boolean, ageSec = 0): string => {
    const dir = join(root, 'Upload_' + itemId)
    mkdirSync(dir)
    writeFileSync(join(dir, '00_Brief.pdf'), 'x')
    if (marker) writeFileSync(join(dir, PACKAGE_MARKER), JSON.stringify({ item_id: itemId }))
    uploadPackageInfo(itemId) // makes the table
    getDb().prepare('INSERT OR REPLACE INTO wb_upload_package (item_id, dir, created_at) VALUES (?, ?, ?)').run(itemId, dir, Math.floor(Date.now() / 1000) - ageSec)
    return dir
  }
  it('lists the files without the marker', () => {
    make('a1', true)
    const v = uploadPackageInfo('a1')!
    expect(v.exists).toBe(true)
    expect(v.files.map((f) => f.name)).toEqual(['00_Brief.pdf'])
  })
  it('marking the item sent removes the folder in the same step', () => {
    const dir = make('a2', true)
    markSentManually('a2', 'owner', { method: 'portal' })
    expect(existsSync(dir)).toBe(false)
    expect(uploadPackageInfo('a2')).toBeNull()
  })
  it('a folder without our marker (or for another item) is NEVER deleted', () => {
    const dir = make('a3', false)
    expect(removeUploadPackage('a3')).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })
  it('a folder nobody cleaned up is removed after a week, a fresh one stays', () => {
    const old = make('old1', true, 8 * 86400)
    const fresh = make('new1', true, 3600)
    expect(sweepOldUploadPackages()).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})
