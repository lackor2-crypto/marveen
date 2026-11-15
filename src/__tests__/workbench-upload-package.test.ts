// Boss, 2026-11-08 (#876): the temporary folder for an online upload -- clean names, marker-guarded removal, gone when "sent".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { safeName, packageNames, removeUploadPackage, uploadPackageInfo, sweepOldUploadPackages, PACKAGE_MARKER, pickWindowsDownloads, windowsExe, largeFiles, UPLOAD_SIZE_WARN_BYTES, warnExpiringUploadPackages } from '../workbench-upload-package.js'
import { readFileSync } from 'node:fs'
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


// Owner, 2026-11-08: the folder landed in the Linux home, out of sight of Windows Explorer. cmd.exe was "not found" from a service
// (no Windows PATH) and, when found, wrote "László" in the OEM code page, so the profile path was garbage and the code fell back to the Linux home.
describe('the folder is made in the WINDOWS Downloads folder, not in the Linux home', () => {
  it('system profiles are never chosen; of the real ones the most recently used Downloads wins', () => {
    const c = [
      { dir: '/mnt/c/Users/Default/Downloads', user: 'Default', mtimeMs: 9e12 },
      { dir: '/mnt/c/Users/Public/Downloads', user: 'Public', mtimeMs: 9e12 },
      { dir: '/mnt/c/Users/Default User/Downloads', user: 'Default User', mtimeMs: 9e12 },
      { dir: '/mnt/c/Users/Régi/Downloads', user: 'Régi', mtimeMs: 100 },
      { dir: '/mnt/c/Users/László/Downloads', user: 'László', mtimeMs: 500 },
    ]
    expect(pickWindowsDownloads(c)).toBe('/mnt/c/Users/László/Downloads')
    expect(pickWindowsDownloads(c.slice(0, 3))).toBeNull()
    expect(pickWindowsDownloads([])).toBeNull()
  })
  it('cmd.exe is asked by its full path, with a UTF-8 console, and the Users folders are scanned when it gives nothing', () => {
    const src = readFileSync(join(__dirname, '..', 'workbench-upload-package.ts'), 'utf8')
    expect(src).toContain('/mnt/c/Windows/System32/')
    expect(src).toContain('chcp 65001>nul&&echo %USERPROFILE%')
    expect(src).toContain("encoding: 'utf8'")
    expect(src.indexOf('pickWindowsDownloads(scanWindowsDownloads())')).toBeLessThan(src.indexOf("join(homedir(), 'Downloads')"))
    expect(windowsExe('cmd.exe')).toMatch(/cmd\.exe$/)
  })
  it('the "In person" tab has the same button (and the same open / delete), for printing', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const tabs = js.slice(js.indexOf('function sendTabsHtml('), js.indexOf('function receiptSave('))
    expect(tabs).toContain("uploadPackageHtml(it, 'print')")
    expect(tabs).toContain("uploadPackageHtml(it) ")
    const fn = js.slice(js.indexOf('function uploadPackageHtml('), js.indexOf('function sentBannerHtml('))
    expect(fn).toContain("data-wb-purpose=\"print\"")
    expect(fn).toContain("'item-upload-package-remove'")
    expect(js).toContain("act.getAttribute('data-wb-purpose') === 'print' ? { purpose: 'print' }")
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf8')
    expect(route).toContain("body['purpose'] === 'print' ? 'print' : 'upload'")
    for (const lang of ['hu', 'en']) {
      const dict = readFileSync(join(__dirname, '..', '..', 'web', 'lang', lang + '.js'), 'utf8')
      for (const k of ['workbench.upload.make_print', 'workbench.upload.ready_print', 'workbench.upload.pkg_hint', 'workbench.upload.pkg_hint_print', 'workbench.send.person_pkg_hint']) expect(dict).toContain('"' + k + '"')
    }
  })
})


// Card #876 text: "the K3 is over 10 MB, a file-size warning is needed" and "uncleaned folders are removed after some days, a notice comes first".
// The code did neither: the owner saw no warning for the big annex and an unwarned folder simply vanished after a week.
describe('size warning and notice before the automatic clean-up', () => {
  let root = ''
  beforeEach(() => { initDatabase(':memory:'); root = mkdtempSync(join(tmpdir(), 'wb-up2-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  const make = (itemId: string, ageSec: number, bytes = 1): string => {
    const dir = join(root, 'Upload_' + itemId)
    mkdirSync(dir)
    writeFileSync(join(dir, '00_Brief.pdf'), Buffer.alloc(bytes))
    writeFileSync(join(dir, PACKAGE_MARKER), JSON.stringify({ item_id: itemId }))
    uploadPackageInfo(itemId)
    getDb().prepare('INSERT OR REPLACE INTO wb_upload_package (item_id, dir, created_at) VALUES (?, ?, ?)').run(itemId, dir, Math.floor(Date.now() / 1000) - ageSec)
    return dir
  }
  it('largeFiles lists only the files over the limit (a warning, nothing is blocked or changed)', () => {
    const f = [{ name: 'a.pdf', bytes: 5 * 1024 * 1024 }, { name: 'K3.pdf', bytes: 10 * 1024 * 1024 + 1 }]
    expect(UPLOAD_SIZE_WARN_BYTES).toBe(10 * 1024 * 1024)
    expect(largeFiles(f).map((x) => x.name)).toEqual(['K3.pdf'])
    expect(largeFiles(f, 1).length).toBe(2)
    expect(largeFiles([])).toEqual([])
  })
  it('the package view carries the big files and the day it will be removed', () => {
    make('big1', 0, 11 * 1024 * 1024)
    const v = uploadPackageInfo('big1')!
    expect(v.large.map((x) => x.name)).toEqual(['00_Brief.pdf'])
    expect(v.size_warn_bytes).toBe(UPLOAD_SIZE_WARN_BYTES)
    expect(v.expires_at).toBe(v.created_at + 7 * 86400)
  })
  it('a package close to the clean-up gets ONE notice, a fresh one none, and the notice never deletes anything', async () => {
    const near = make('near1', 6.5 * 86400)
    make('fresh1', 3600)
    const sent: string[] = []
    expect(await warnExpiringUploadPackages(Date.now(), async (t) => { sent.push(t) })).toBe(1)
    expect(sent.length).toBe(1)
    expect(existsSync(near)).toBe(true)
    expect(await warnExpiringUploadPackages(Date.now(), async (t) => { sent.push(t) })).toBe(0)
    expect(sent.length).toBe(1)
  })
  it('the page shows the warning and the removal day, in both languages', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const fn = js.slice(js.indexOf('function uploadPackageHtml('), js.indexOf('function sentBannerHtml('))
    expect(fn).toContain('workbench.upload.large_warn')
    expect(fn).toContain('workbench.upload.expires')
    for (const lang of ['hu', 'en']) {
      const dict = readFileSync(join(__dirname, '..', '..', 'web', 'lang', lang + '.js'), 'utf8')
      for (const k of ['workbench.upload.large_warn', 'workbench.upload.expires']) expect(dict).toContain('"' + k + '"')
    }
  })
})
