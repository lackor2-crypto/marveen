// Amit a Google SZABALYBOL nem ad ki: egyszer megjegyezve, tobbet nem probalva.
//
// Boss, 2026-09-23: "azt nem engedi a Google letolteni, oke, az nem problema,
// akkor ne jelentsen hibat ... Es innentol kezdve azt nem is probalja meg
// leszinkronizalni."
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearDriveSkiplist, driveSkiplistItems, isDriveSkipped, loadDriveSkiplist,
  recordDriveSkip, removeDriveSkip, skipKey,
} from '../drive-skiplist.js'

let dir = ''
let path = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiplist-'))
  path = join(dir, 'drive-skiplist.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const tetel = (over: Partial<Parameters<typeof recordDriveSkip>[0]> = {}) => ({
  account: 'nyalomapuncidma',
  driveId: '1AbC',
  driveName: 'ex4_to_mq4_224.1build.rar',
  localPath: '/mnt/f/Marveen/drive/nyalomapuncidma/ex4_to_mq4_224.1build.rar',
  pair: 'a teljes Drive',
  reason: 'This file has been identified as malware or spam and cannot be downloaded.',
  at: '2026-09-23T01:44:40.363Z',
  ...over,
})

describe('kihagyando-lista', () => {
  it('friss telepitesen URES -- es ez nem hiba, hanem helyes csend', () => {
    expect(loadDriveSkiplist(path)).toEqual({})
    expect(existsSync(path)).toBe(false)
    expect(isDriveSkipped('barki', 'barmi', loadDriveSkiplist(path))).toBe(false)
  })

  it('felveszi, es a kovetkezo futas atugorja', () => {
    recordDriveSkip(tetel(), path)
    const lista = loadDriveSkiplist(path)
    expect(isDriveSkipped('nyalomapuncidma', '1AbC', lista)).toBe(true)
    // MAS fiok ugyanazzal az azonositoval NEM ugyanaz a tetel.
    expect(isDriveSkipped('lackor2', '1AbC', lista)).toBe(false)
  })

  it('a Google SAJAT mondatat orzi meg, nem a mi atfogalmazasunkat', () => {
    recordDriveSkip(tetel(), path)
    expect(loadDriveSkiplist(path)[skipKey('nyalomapuncidma', '1AbC')].reason)
      .toContain('identified as malware or spam')
  })

  it('ismetelt felvetelnel az ELSO idopont marad -- abbol latszik, mennyi ideje all a listan', () => {
    recordDriveSkip(tetel(), path)
    recordDriveSkip(tetel({ at: '2026-10-01T00:00:00.000Z', driveName: 'uj-nev.rar' }), path)
    const e = loadDriveSkiplist(path)[skipKey('nyalomapuncidma', '1AbC')]
    expect(e.at).toBe('2026-09-23T01:44:40.363Z')
    expect(e.driveName).toBe('uj-nev.rar')      // a nev viszont frissul
  })

  it('kulcs nelkuli tetelt nem vesz fel -- azt ugysem tudnank atugrani', () => {
    recordDriveSkip(tetel({ driveId: '' }), path)
    expect(loadDriveSkiplist(path)).toEqual({})
  })

  it('egy tetel levehető, a tobbi marad', () => {
    recordDriveSkip(tetel(), path)
    recordDriveSkip(tetel({ driveId: '2DeF', driveName: 'AutoGraf_en.zip' }), path)
    expect(removeDriveSkip(skipKey('nyalomapuncidma', '1AbC'), path)).toBe(true)
    expect(Object.keys(loadDriveSkiplist(path))).toEqual([skipKey('nyalomapuncidma', '2DeF')])
    expect(removeDriveSkip('nincs-ilyen', path)).toBe(false)
  })

  it('az egesz lista uritheto -- a kovetkezo futas mindennek ujra nekifut', () => {
    recordDriveSkip(tetel(), path)
    clearDriveSkiplist(path)
    expect(loadDriveSkiplist(path)).toEqual({})
    // A fajl MEGMARAD uresen: ebbol tudja a felulet, hogy mar volt szinkron.
    expect(existsSync(path)).toBe(true)
  })

  // Egy serult fajl SOSE vezethet oda, hogy csendben tobb fajlt hagyunk ki,
  // mint amit a felhasznalo lat. Ures lista = mindent megprobalunk.
  it('olvashatatlan fajlbol URES lista lesz, nem kitalalt tartalom', () => {
    writeFileSync(path, '{ ez nem json')
    expect(loadDriveSkiplist(path)).toEqual({})
  })

  it('tomb-formatumot sem fogad el ertekes tartalomnak', () => {
    writeFileSync(path, '[1,2,3]')
    expect(loadDriveSkiplist(path)).toEqual({})
  })

  it('a kepernyore LEGUJABB ELOL kerul', () => {
    recordDriveSkip(tetel({ driveId: 'regi', at: '2026-09-01T00:00:00.000Z' }), path)
    recordDriveSkip(tetel({ driveId: 'uj', at: '2026-09-23T00:00:00.000Z' }), path)
    expect(driveSkiplistItems(loadDriveSkiplist(path)).map((x) => x.driveId)).toEqual(['uj', 'regi'])
  })

  it('a lemezre irt alak visszaolvasva ugyanaz', () => {
    recordDriveSkip(tetel(), path)
    const nyers = JSON.parse(readFileSync(path, 'utf8'))
    expect(nyers[skipKey('nyalomapuncidma', '1AbC')].localPath).toContain('ex4_to_mq4')
  })
})
