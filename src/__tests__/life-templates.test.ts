// A KESZ SABLONOK es a lapos depo ATKOLTOZTETESE.
//
// Ket olyan dolog van itt, amit a feluleten nezve keso volna eszrevenni:
//
//  1. Ha egy sablonba valodi nev keveredik (`Korpás László`, `Magyarország`),
//     azt csak az veszi eszre, aki mas gepre telepiti a Marveent -- es akkor
//     mar a lemezen all a hibas mappa. Ezert a helyorzo-nevekre TESZT van.
//  2. Az atkoltoztetes `renameSync`-kel dolgozik. Ha elrontja, nem hibauzenet
//     lesz belole, hanem eltunt mappa. Ezert vizsgaljuk kulon a ket veszelyes
//     esetet: a mar letezo celt es a kis-nagybetu-utkozest.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-tpl-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-tplstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { LIFE_TEMPLATES, findLifeTemplate, listLifeTemplates } = await import('../life-templates.js')
const { planLifeTree, PERSON_CATEGORIES, lifeConfigExists, saveLifeConfig } = await import('../life-tree.js')
const {
  migrateFlatDepotDirs, DEPOT_SYSTEM, DEPOT_PROJECTS, DEPOT_WORK, DEPOT_DRIVE, DEPOT_PHOTOS,
} = await import('../depot.js')

describe('a sablonok', () => {
  it('mind felepitheto, es egyik sem ures', () => {
    for (const t of LIFE_TEMPLATES) {
      const cfg = t.build('hu')
      expect(cfg.persons.length, t.id).toBeGreaterThan(0)
      expect(planLifeTree(cfg, 'hu').length, t.id).toBeGreaterThan(10)
    }
  })

  it('CSAK helyorzo nevet hasznalnak -- soha valodit', () => {
    // Ez a specifikacio 29-30. pontja: ami ide fixen be van irva, az minden mas
    // felhasznalo gepen rossz. A tiltolista azokat a neveket tartalmazza,
    // amiket a fejlesztes kozben a legkonnyebb veletlenul bemasolni.
    const tilos = ['korpás', 'lászló', 'bakos', 'éva', 'magyarország', 'németország', 'usa', 'marveen']
    for (const t of LIFE_TEMPLATES) {
      const cfg = t.build('hu')
      const nevek = [
        ...cfg.persons.flatMap((p) => [p.name, ...p.countries, ...p.mediaGroups, ...p.projects.map((x) => x.name)]),
        ...cfg.companies.flatMap((c) => [c.name, ...c.countries]),
      ].map((n) => n.toLowerCase())
      for (const n of nevek) {
        for (const bad of tilos) expect(n.includes(bad), `${t.id}: ${n}`).toBe(false)
      }
      expect(nevek.some((n) => n.includes('példa') || n.includes('ország'))).toBe(true)
    }
  })

  it('MINDEN szemely a teljes szerkezetet kapja, a masodik is', () => {
    // A Boss kikotese: "ne csak nalam, hanem a bakos evanal is... ugyanugy".
    const cfg = findLifeTemplate('family-multi-country')!.build('hu')
    const rels = planLifeTree(cfg, 'hu').map((n) => n.rel)
    for (const p of cfg.persons) {
      expect(rels.filter((r) => r.startsWith(`${p.name}/`)).length).toBeGreaterThanOrEqual(PERSON_CATEGORIES.length)
    }
  })

  it('a tobb-orszagos sablonban a MEDIA is orszagra bomlik', () => {
    const cfg = findLifeTemplate('multi-country')!.build('hu')
    const rels = planLifeTree(cfg, 'hu').map((n) => n.rel)
    const p = cfg.persons[0].name
    expect(rels).toContain(`MÉDIA/${p}/FOTÓK/${cfg.persons[0].countries[2]}`)
    expect(rels).toContain(`MÉDIA/${p}/VIDEÓK/${cfg.persons[0].countries[2]}`)
  })

  it('a teljes sablonban a szemelyes es a ceges repo KULON all', () => {
    // 31. pont: ezek soha nem keverednek.
    const cfg = findLifeTemplate('full')!.build('hu')
    const rels = planLifeTree(cfg, 'hu').map((n) => n.rel)
    const person = cfg.persons[0].name
    const company = cfg.companies[0].name
    expect(rels).toContain(`${person}/PROJEKTEK/${cfg.persons[0].projects[0].name}/FEJLESZTÉS/GIT_REPOS`)
    expect(rels).toContain(`CÉGEK/${company}/FEJLESZTÉS/GIT_REPOS`)
  })

  it('ismeretlen azonositora nem talal ki semmit', () => {
    expect(findLifeTemplate('nincs-ilyen')).toBeNull()
    expect(findLifeTemplate('')).toBeNull()
  })

  it('a lista a feluletnek eloneztet is ad', () => {
    const l = listLifeTemplates('hu')
    expect(l.length).toBe(LIFE_TEMPLATES.length)
    for (const t of l) {
      expect(t.title).toBeTruthy()
      expect(t.highlights.length).toBeGreaterThan(0)
      expect(t.config.persons.length).toBeGreaterThan(0)
    }
  })
})

describe('migrateFlatDepotDirs -- a lapos depo a RENDSZER ala kerul', () => {
  beforeEach(() => {
    for (const n of ['rendszer', 'projektek', 'munka', 'mentesek', 'RENDSZER', 'drive', 'fotok']) {
      rmSync(join(depot, n), { recursive: true, force: true })
    }
  })

  it('atviszi a mappat a tartalmaval egyutt', () => {
    mkdirSync(join(depot, 'projektek', 'valami'), { recursive: true })
    writeFileSync(join(depot, 'projektek', 'valami', 'a.txt'), 'tartalom', 'utf8')
    const moved = migrateFlatDepotDirs()
    expect(moved.map((m) => m.from)).toContain('projektek')
    expect(existsSync(join(depot, 'projektek'))).toBe(false)
    expect(readFileSync(join(depot, DEPOT_PROJECTS, 'valami', 'a.txt'), 'utf8')).toBe('tartalom')
  })

  it('a `rendszer` -> `RENDSZER/MARVIN` utkozest is megoldja', () => {
    // EZ A VESZELYES ESET. Windowson a `rendszer` es a `RENDSZER` UGYANAZ a
    // mappa, tehat a naiv atnevezes a mappat sajat magaba tenne (es elveszne a
    // Boss adatbazisa). Linuxon a ket nev kulon all, de a lepesnek ott is
    // ugyanoda kell erkeznie -- ezert megy a teszt mindket rendszeren.
    mkdirSync(join(depot, 'rendszer'), { recursive: true })
    writeFileSync(join(depot, 'rendszer', 'naplo.db'), 'adat', 'utf8')
    migrateFlatDepotDirs()
    expect(readFileSync(join(depot, DEPOT_SYSTEM, 'naplo.db'), 'utf8')).toBe('adat')
    // Es nem hagyott maga utan ideiglenes mappat.
    expect(existsSync(join(depot, 'rendszer.koltozes'))).toBe(false)
  })

  it('SOHA nem ir felul mar letezo celt', () => {
    mkdirSync(join(depot, 'munka'), { recursive: true })
    writeFileSync(join(depot, 'munka', 'uj.txt'), 'uj', 'utf8')
    mkdirSync(join(depot, DEPOT_WORK), { recursive: true })
    writeFileSync(join(depot, DEPOT_WORK, 'regi.txt'), 'REGI ES FONTOS', 'utf8')

    migrateFlatDepotDirs()
    // Mindketto megvan: inkabb maradjon ket helyen, mint hogy egy elvesszen.
    expect(readFileSync(join(depot, DEPOT_WORK, 'regi.txt'), 'utf8')).toBe('REGI ES FONTOS')
    expect(existsSync(join(depot, 'munka', 'uj.txt'))).toBe(true)
  })

  it('a `drive` es a `fotok` a TAROLOK ala kerul, nem marad a gyokerben', () => {
    // Boss, 2026-08-21: az Intezo gyokereben ezek nem elet-teruletek, hanem
    // kulso szolgaltatasok helyi masolatai. (A korabbi "hagyd meg" keres az
    // IRODA MENU Drive/Fotok oldalaira vonatkozott, nem a mappakra.)
    mkdirSync(join(depot, 'drive', 'fiok'), { recursive: true })
    writeFileSync(join(depot, 'drive', 'fiok', 'a.txt'), 'drive', 'utf8')
    mkdirSync(join(depot, 'fotok', 'fiok'), { recursive: true })
    writeFileSync(join(depot, 'fotok', 'fiok', 'k.jpg'), 'kep', 'utf8')

    migrateFlatDepotDirs()

    expect(existsSync(join(depot, 'drive'))).toBe(false)
    expect(existsSync(join(depot, 'fotok'))).toBe(false)
    expect(readFileSync(join(depot, DEPOT_DRIVE, 'fiok', 'a.txt'), 'utf8')).toBe('drive')
    expect(readFileSync(join(depot, DEPOT_PHOTOS, 'fiok', 'k.jpg'), 'utf8')).toBe('kep')
    // A fiok NEVE megmarad -- nem DRIVE_01 lesz belole.
    expect(DEPOT_DRIVE.endsWith('/DRIVE')).toBe(true)
    expect(DEPOT_PHOTOS.endsWith('/GOOGLE_PHOTOS')).toBe(true)
  })

  it('ures regi mappat nem koltoztet, hanem eltakarit', () => {
    mkdirSync(join(depot, 'mentesek'), { recursive: true })
    migrateFlatDepotDirs()
    expect(existsSync(join(depot, 'mentesek'))).toBe(false)
  })
})

describe('friss telepites felismerese', () => {
  const cfgPath = join(store, 'life-tree.json')
  beforeEach(() => { rmSync(cfgPath, { force: true }) })

  it('uj gepen FRISS -- meg akkor is, hogy a betoltes ad egy helyorzo gazdat', async () => {
    // EZ A LENYEG. A `loadLifeConfig()` sose ad ures szemelylistat, ezert aki a
    // szemelyek szamabol probalna kitalalni a "friss"-et, minden uj telepitest
    // regi felhasznalonak nezne -- es a Boss kikotesevel ellentetben az elso
    // inditas "ez FELULIRJA a neveidet" figyelmeztetessel fogadna a usert.
    const { loadLifeConfig } = await import('../life-tree.js')
    expect(loadLifeConfig().persons.length).toBeGreaterThan(0)
    expect(lifeConfigExists()).toBe(false)
  })

  it('mentes utan mar nem friss', () => {
    saveLifeConfig(findLifeTemplate('solo')!.build('hu'))
    expect(lifeConfigExists()).toBe(true)
  })
})
