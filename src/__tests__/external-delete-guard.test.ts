// A KULSO TORLES ELLENI VEDELEM (specifikacio 6.) meresei.
//
// A legfontosabb allitas nem az, hogy "felismeri a torlest", hanem hogy CSONKA
// bejarasbol NEM kovetkeztet. Ez az a hiba, amit a szabaly nevesit: nulla
// talalat jelentheti azt is, hogy nem lattunk oda.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setExternalStoreDir, externalPath, externalGuardEnabled, setExternalGuardEnabled,
  loadExternalChanges, clearExternalChanges, noteExternalScan, externalSummaryText,
} from '../external-delete-guard.js'

let dir = ''
let base = ''

beforeEach(() => {
  // SAJAT, eldobhato mappa. Az eles `store/`-hoz egyetlen teszt sem nyulhat.
  dir = mkdtempSync(join(tmpdir(), 'guard-'))
  setExternalStoreDir(join(dir, 'store'))
  base = join(dir, 'depo')
  mkdirSync(base, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('külső törlés elleni védelem', () => {
  it('friss telepítésen BE van kapcsolva, beállításfájl nélkül is', () => {
    expect(externalGuardEnabled()).toBe(true)
  })

  it('az üres napló megmondja, hogy MÉG NEM FUTOTT — nem azt, hogy nem történt semmi', () => {
    const load = loadExternalChanges()
    expect(load.list).toEqual([])
    expect(load.fileExists).toBe(false)
    expect(externalSummaryText(load, 'hu')).toContain('Még nem futott')
    expect(externalSummaryText(load, 'en')).toContain('No sync run')
  })

  it('felismeri a Drive-on törölt fájlt, és a helyi példányhoz NEM nyúl', () => {
    const abs = join(base, 'jelentes.docx')
    writeFileSync(abs, 'tartalom')
    const r = noteExternalScan({
      runId: 'r1', account: 'lackor2', pair: 'a teljes Drive', pairId: 'p1', base,
      tracked: new Map([['ID1', 'jelentes.docx']]),
      seen: new Set<string>(),
      complete: true, incompleteReason: '',
    })
    expect(r.deleted).toBe(1)
    expect(r.skipped).toBe(false)
    // A LENYEG: a fajl a helyen maradt.
    expect(existsSync(abs)).toBe(true)
    const load = loadExternalChanges()
    expect(load.list[0].kind).toBe('törlés')
    expect(load.list[0].localPath).toBe(abs)
    expect(externalSummaryText(load, 'hu')).toContain('a gépeden mind megvan')
  })

  it('CSONKA bejárásnál nem következtet törlésre, hanem kimondja, hogy nem nézte meg', () => {
    writeFileSync(join(base, 'a.txt'), 'x')
    const r = noteExternalScan({
      runId: 'r2', account: 'lackor2', pair: 'a teljes Drive', pairId: 'p1', base,
      tracked: new Map([['ID1', 'a.txt']]),
      seen: new Set<string>(),
      complete: false, incompleteReason: 'olvasási hiba',
    })
    expect(r.deleted).toBe(0)
    expect(r.skipped).toBe(true)
    const load = loadExternalChanges()
    expect(load.list[0].kind).toBe('kihagyva')
    expect(load.list[0].note).toContain('olvasási hiba')
    // A csend magyarazata is kimondando: nulla torles, de NEM neztuk meg.
    expect(externalSummaryText(load, 'hu')).toContain('nem is tudtam megnézni')
  })

  it('a helyben sem létező fájl NEM külső törlés (azt te törölted)', () => {
    const r = noteExternalScan({
      runId: 'r3', account: 'lackor2', pair: 'a teljes Drive', pairId: 'p1', base,
      tracked: new Map([['ID1', 'nincs-ilyen.txt']]),
      seen: new Set<string>(),
      complete: true, incompleteReason: '',
    })
    expect(r.deleted).toBe(0)
    expect(loadExternalChanges().list).toEqual([])
  })

  it('a Drive-on még meglévő fájlra nem ír sort', () => {
    writeFileSync(join(base, 'a.txt'), 'x')
    const r = noteExternalScan({
      runId: 'r3b', account: 'a', pair: 'p', pairId: 'p1', base,
      tracked: new Map([['ID1', 'a.txt']]),
      seen: new Set<string>(['ID1']),
      complete: true, incompleteReason: '',
    })
    expect(r.deleted).toBe(0)
  })

  it('a kapcsoló megmarad, és kikapcsolva nem naplóz', () => {
    setExternalGuardEnabled(false)
    expect(externalGuardEnabled()).toBe(false)
    writeFileSync(join(base, 'a.txt'), 'x')
    const r = noteExternalScan({
      runId: 'r4', account: 'a', pair: 'p', pairId: 'p1', base,
      tracked: new Map([['ID1', 'a.txt']]), seen: new Set<string>(),
      complete: true, incompleteReason: '',
    })
    expect(r.deleted).toBe(0)
    expect(loadExternalChanges().fileExists).toBe(false)
    setExternalGuardEnabled(true)
    expect(externalGuardEnabled()).toBe(true)
  })

  it('sérült beállításfájlnál a védelem BEKAPCSOLVA marad', () => {
    mkdirSync(join(dir, 'store'), { recursive: true })
    writeFileSync(join(dir, 'store', 'external-guard.json'), '{ ez nem json')
    expect(externalGuardEnabled()).toBe(true)
  })

  it('a csonka naplósor nem viszi el a többit', () => {
    writeFileSync(join(base, 'a.txt'), 'x')
    noteExternalScan({
      runId: 'r5', account: 'a', pair: 'p', pairId: 'p1', base,
      tracked: new Map([['ID1', 'a.txt']]), seen: new Set<string>(),
      complete: true, incompleteReason: '',
    })
    appendFileSync(externalPath(), '{"kind":"tör\n{"kind":"törlés","at":"2026-01-01"}\n')
    expect(loadExternalChanges().list.length).toBe(2)
  })

  it('a napló ürítése nem hagy maga után hamis "még nem futott" állapotot… hanem pont azt jelenti', () => {
    writeFileSync(join(base, 'a.txt'), 'x')
    noteExternalScan({
      runId: 'r6', account: 'a', pair: 'p', pairId: 'p1', base,
      tracked: new Map([['ID1', 'a.txt']]), seen: new Set<string>(),
      complete: true, incompleteReason: '',
    })
    expect(loadExternalChanges().list.length).toBe(1)
    clearExternalChanges()
    expect(loadExternalChanges().fileExists).toBe(false)
  })
})
