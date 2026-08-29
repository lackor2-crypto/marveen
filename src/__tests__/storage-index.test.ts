// EGY UTVONAL -> MELYIK TAROLO? (specifikacio 9. es 20. pont)
//
// A merese annak, hogy a forrasjelveny mostantol MEGNEVEZI a tarolot
// (`DRIVE_02`), es hogy a HIANYZO azonosito harom KULONBOZO oka kulon
// megkulonboztetheto -- a nulla ket dolgot jelenthet.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageAt, storageMissText, clearStorageIndexCache } from '../storage-index.js'
import { DEPOT_DRIVE, DEPOT_PHOTOS } from '../depot.js'

const dir = mkdtempSync(join(tmpdir(), 'stidx-'))
const regFile = join(dir, 'storages.json')

function reg(ids: Record<string, number>, names: Record<string, string> = {}): void {
  writeFileSync(regFile, JSON.stringify({ ids, names, disabled: {}, gitAccounts: [] }), 'utf-8')
}

function at(rel: string) {
  return storageAt(join(dir, ...rel.split('/')), { root: dir, registryFile: regFile })
}

beforeEach(() => clearStorageIndexCache())
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('storageAt – melyik tárolóból jön', () => {
  it('a kiosztott sorszámot adja vissza, és megkülönbözteti a két Drive-fiókot', () => {
    mkdirSync(join(dir, ...DEPOT_DRIVE.split('/'), 'lackor2'), { recursive: true })
    mkdirSync(join(dir, ...DEPOT_DRIVE.split('/'), 'ceges'), { recursive: true })
    reg({ 'drive:lackor2': 2, 'drive:ceges': 7 }, { 'drive:ceges': 'Céges fiók' })

    const a = at(DEPOT_DRIVE + '/lackor2/Szamlak/2026.pdf')
    expect(a.id).toBe('DRIVE_02')
    expect(a.kind).toBe('drive')
    expect(a.reason).toBe(null)

    const b = at(DEPOT_DRIVE + '/ceges/Szamlak/2026.pdf')
    expect(b.id).toBe('DRIVE_07')
    expect(b.name).toBe('Céges fiók')
  })

  it('a fajtánként külön számozás nem keveredik', () => {
    mkdirSync(join(dir, ...DEPOT_PHOTOS.split('/'), 'lackor2'), { recursive: true })
    reg({ 'drive:lackor2': 2, 'photos:lackor2': 1 })
    expect(at(DEPOT_PHOTOS + '/lackor2/IMG_1.jpg').id).toBe('PHOTOS_01')
    expect(at(DEPOT_DRIVE + '/lackor2/x.pdf').id).toBe('DRIVE_02')
  })

  it('NEM tároló alatti fájlnál ez a helyes válasz, nem hiányzó adat', () => {
    reg({ 'drive:lackor2': 2 })
    const m = at('Munka/jegyzet.txt')
    expect(m.id).toBe(null)
    expect(m.reason).toBe('not-storage')
    expect(storageMissText('not-storage')).toContain('gépeden')
  })

  it('raktár nélkül nem talál ki azonosítót, és a Depó oldalra küld', () => {
    const m = storageAt('/barmi/utvonal', { root: null })
    expect(m.reason).toBe('no-depot')
    expect(storageMissText('no-depot')).toContain('Raktár')
    expect(storageMissText('no-depot', 'en')).toContain('Depot')
  })

  it('sorszám nélküli fióknál MEGMONDJA, hogy nincs kiosztva – nem tippel', () => {
    reg({})
    const m = at(DEPOT_DRIVE + '/lackor2/x.pdf')
    expect(m.id).toBe(null)
    expect(m.kind).toBe('drive')
    expect(m.account).toBe('lackor2')
    expect(m.reason).toBe('unregistered')
    expect(storageMissText('unregistered')).toContain('Tárolók')
  })

  it('sérült regiszternél sem hasal el, és sorszámot akkor sem talál ki', () => {
    writeFileSync(regFile, '{ ez nem json', 'utf-8')
    const m = at(DEPOT_DRIVE + '/lackor2/x.pdf')
    expect(m.id).toBe(null)
    expect(m.reason).toBe('unregistered')
  })

  it('a `/a/bc` nem esik a `/a/b` tárolóba', () => {
    reg({ 'drive:lackor2': 2 })
    // A fajta-gyoker melletti hasonlo nevu mappa NEM tarolo alatt van.
    const m = at(DEPOT_DRIVE + 'X/lackor2/x.pdf')
    expect(m.reason).toBe('not-storage')
  })

  it('a fajta-gyökér maga (fiók nélkül) nem EGY tároló', () => {
    reg({ 'drive:lackor2': 2 })
    const m = at(DEPOT_DRIVE)
    expect(m.kind).toBe('drive')
    expect(m.id).toBe(null)
    expect(m.reason).toBe('unregistered')
  })
})
