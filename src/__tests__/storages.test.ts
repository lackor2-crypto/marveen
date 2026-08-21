// A tarolo-nyilvantartas tesztjei (specifikacio 33. pont).
//
// A hangsuly a KIOSZTASON van: az azonosito (`DRIVE_01`) a fajlok fizikai
// hivatkozasaba kerul, ezert ha egyszer elcsuszik, a regi hivatkozasok mas
// tarolora mutatnanak. Ezt itt konnyu bizonyitani, elesben nem.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assignStorageId,
  storageId,
  listStorages,
  addGitAccount,
  renameStorage,
  setStorageActive,
  activeAccounts,
  readStorageRegistry,
  storageKindRoot,
  type StorageRegistryFile,
} from '../storages.js'
import { DEPOT_DRIVE, DEPOT_PHOTOS, DEPOT_PROJECTS } from '../depot.js'

const EMPTY: StorageRegistryFile = { ids: {}, names: {}, disabled: {}, gitAccounts: [] }

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stor-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function mk(rel: string): void {
  mkdirSync(join(root, rel), { recursive: true })
}

describe('azonosito-kiosztas', () => {
  it('DRIVE_01-tol szamoz, ketjegyuen', () => {
    expect(storageId('drive', 1)).toBe('DRIVE_01')
    expect(storageId('photos', 7)).toBe('PHOTOS_07')
    expect(storageId('git', 10)).toBe('GIT_10')
  })

  it('ugyanannak a fioknak MINDIG ugyanaz az azonositoja', () => {
    let reg = EMPTY
    const a = assignStorageId(reg, 'drive', 'lackor2')
    reg = a.reg
    const b = assignStorageId(reg, 'drive', 'lackor2')
    expect(b.id).toBe(a.id)
    expect(b.reg.ids).toEqual(a.reg.ids)
  })

  it('fajtankent kulon szamsor fut', () => {
    let reg = EMPTY
    reg = assignStorageId(reg, 'drive', 'a').reg
    const p = assignStorageId(reg, 'photos', 'a')
    // Ugyanaz a fioknev, de mas fajta -> a fotok szamsora is 01-rol indul.
    expect(p.id).toBe('PHOTOS_01')
  })

  it('torolt fiok szamat NEM osztja ki ujra', () => {
    // Ket fiok volt, a masodikat levettuk: a regiszterben a 2-es benne marad.
    const reg: StorageRegistryFile = { ...EMPTY, ids: { 'drive:egy': 1, 'drive:ketto': 2 } }
    const uj = assignStorageId({ ...reg, ids: { 'drive:egy': 1, 'drive:ketto': 2 } }, 'drive', 'harom')
    expect(uj.id, 'a kovetkezo szabad szam, nem a felszabadult 02').toBe('DRIVE_03')
  })
})

describe('listazas', () => {
  it('a bekotott fiok es a lemezen talalt mappa is megjelenik', () => {
    mk(`${DEPOT_DRIVE}/regi_fiok`)
    const { rows } = listStorages({
      driveAccounts: ['elo_fiok'],
      photosAccounts: [],
      root,
      registry: EMPTY,
    })
    const drive = rows.filter((r) => r.kind === 'drive')
    expect(drive.map((r) => r.account).sort()).toEqual(['elo_fiok', 'regi_fiok'])
  })

  it('a lejart tokenu, de lemezen levo fiok NEM tunik el -- csak connected:false', () => {
    mk(`${DEPOT_DRIVE}/regi_fiok`)
    const { rows } = listStorages({ driveAccounts: [], photosAccounts: [], root, registry: EMPTY })
    const r = rows.find((x) => x.account === 'regi_fiok')!
    expect(r.present, 'a mappa ott van').toBe(true)
    expect(r.connected, 'de nincs mogotte hitelesites').toBe(false)
  })

  it('a bekotott, de meg le nem toltott fiok is latszik (present:false)', () => {
    const { rows } = listStorages({ driveAccounts: ['uj'], photosAccounts: [], root, registry: EMPTY })
    const r = rows.find((x) => x.account === 'uj')!
    expect(r.present).toBe(false)
    expect(r.connected).toBe(true)
  })

  it('egy fiok nem duplazodik, ha be is van kotve ES a lemezen is all', () => {
    mk(`${DEPOT_DRIVE}/lackor2`)
    const { rows } = listStorages({ driveAccounts: ['lackor2'], photosAccounts: [], root, registry: EMPTY })
    expect(rows.filter((r) => r.kind === 'drive' && r.account === 'lackor2')).toHaveLength(1)
  })

  it('mind a HAROM fajta szerepel: drive, fotok ES git', () => {
    mk(`${DEPOT_DRIVE}/d`)
    mk(`${DEPOT_PHOTOS}/f`)
    mk(`${DEPOT_PROJECTS}/g`)
    const { rows } = listStorages({ driveAccounts: [], photosAccounts: [], root, registry: EMPTY })
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['drive', 'photos', 'git']))
  })

  it('a git fiokjai a regiszterbol jonnek, nem a Google-tokenekbol', () => {
    const reg = { ...EMPTY, gitAccounts: ['ceges'] }
    const { rows } = listStorages({ driveAccounts: [], photosAccounts: [], root, registry: reg })
    const git = rows.filter((r) => r.kind === 'git')
    expect(git).toHaveLength(1)
    expect(git[0].connected).toBe(true)
  })

  it('a rel utvonal a Tarolok ala mutat', () => {
    const { rows } = listStorages({ driveAccounts: ['x'], photosAccounts: [], root, registry: EMPTY })
    expect(rows[0].rel).toBe(`${storageKindRoot('drive')}/x`)
    expect(rows[0].rel.startsWith('Rendszer/')).toBe(true)
  })

  it('depo nelkul sem dol el: a bekotott fiokok akkor is latszanak', () => {
    const { rows } = listStorages({ driveAccounts: ['x'], photosAccounts: [], root: null, registry: EMPTY })
    expect(rows).toHaveLength(1)
    expect(rows[0].abs).toBeNull()
    expect(rows[0].present).toBe(false)
  })
})

describe('szerkesztes', () => {
  it('atnevezes csak a megjelenitett nevet valtoztatja', () => {
    const reg = renameStorage(EMPTY, 'drive', 'lackor2', 'Privát Drive')
    const { rows } = listStorages({ driveAccounts: ['lackor2'], photosAccounts: [], root, registry: reg })
    expect(rows[0].name).toBe('Privát Drive')
    expect(rows[0].account, 'a fiok kulcsa valtozatlan -- a szinkron ezzel hiv').toBe('lackor2')
    expect(rows[0].rel.endsWith('/lackor2'), 'a mappa nem mozdul').toBe(true)
  })

  it('ures nevre visszaall az alapertelmezes', () => {
    let reg = renameStorage(EMPTY, 'drive', 'a', 'Valami')
    reg = renameStorage(reg, 'drive', 'a', '  ')
    expect(reg.names['drive:a']).toBeUndefined()
  })

  it('kikapcsolas utan a fiok LATSZIK, de nem aktiv', () => {
    const reg = setStorageActive(EMPTY, 'drive', 'a', false)
    const { rows } = listStorages({ driveAccounts: ['a'], photosAccounts: [], root, registry: reg })
    expect(rows[0].active).toBe(false)
    expect(activeAccounts(rows, 'drive'), 'a szinkron nem kapja meg').toEqual([])
  })

  it('a nem hitelesitett tarolo sosem kerul a szinkron listajaba', () => {
    mk(`${DEPOT_DRIVE}/arva`)
    const { rows } = listStorages({ driveAccounts: [], photosAccounts: [], root, registry: EMPTY })
    expect(activeAccounts(rows, 'drive')).toEqual([])
  })

  it('git-fiok felvetele, es a rossz nev elutasitasa', () => {
    const ok = addGitAccount(EMPTY, 'ceges')
    expect(ok.error).toBeUndefined()
    expect(ok.reg.gitAccounts).toEqual(['ceges'])
    expect(addGitAccount(ok.reg, 'ceges').error, 'ketszer nem').toBeTruthy()
    expect(addGitAccount(EMPTY, '../szokes').error, 'utvonal nem lehet').toBeTruthy()
    expect(addGitAccount(EMPTY, '   ').error).toBeTruthy()
  })
})

describe('regiszter beolvasasa', () => {
  it('hianyzo fajl = ures regiszter, nem hiba', () => {
    expect(readStorageRegistry(join(root, 'nincs.json'))).toEqual(EMPTY)
  })

  it('romlott fajl = ures regiszter, nem dobas', () => {
    const p = join(root, 'rossz.json')
    writeFileSync(p, '{ ez nem json')
    expect(readStorageRegistry(p)).toEqual(EMPTY)
  })

  it('a hibas mezoket kiszurni, a jokat megtartani', () => {
    const p = join(root, 'vegyes.json')
    writeFileSync(p, JSON.stringify({ ids: { 'drive:a': 1, 'drive:b': 'ketto' }, gitAccounts: ['jo', 42] }))
    const reg = readStorageRegistry(p)
    expect(reg.ids).toEqual({ 'drive:a': 1 })
    expect(reg.gitAccounts).toEqual(['jo'])
  })
})
