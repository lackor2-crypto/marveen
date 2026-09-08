// Kartya #246: a Beerkezo "hova kerulne" mappavalasztoja teljes melysegu fat
// jarjon be (ne csak a rogzitett ket szintet), es a felhasznalo egy
// kattintassal, HELYBEN letrehozhassa a meg nem letezo celmappat -- de
// KIZAROLAG kifejezett kattintasra, sose automatikusan. Boss (2026-09-08):
// "a hova kerulne ott a legmelyebb pontig lehessen kivalasztani a legalso
// mappat is" + "ha kifejezetten rakattintok akkor hozza letre a mappat igen".
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InboxItem } from '../life-inbox.js'

const depot = mkdtempSync(join(tmpdir(), 'marveen-inboxfolder-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-inboxfolder-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { mkdirLifePath, explorerRoot } = await import('../life-explorer.js')
const { buildKnownFolders, buildLearnedIndex, analyzeInboxItem } = await import('../life-inbox-analyze.js')
const { loadLifeConfig, saveLifeConfig } = await import('../life-tree.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) {
  throw new Error('A teszt nem az ideiglenes depon all — nem indulok el.')
}

const PERSON = 'Korpás László'

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Beérkező'), { recursive: true })
  saveLifeConfig({
    persons: [{ id: 'p1', name: PERSON, role: 'owner', countries: [], mediaGroups: [] }],
    companies: [],
  } as any)
})

describe('buildKnownFolders -- teljes melysegu fabejaras', () => {
  it('egy tobbszintu, kezzel letrehozott alagat is talal, nem csak a ket felso szintet', () => {
    mkdirSync(join(root, PERSON, 'Hatóságok', 'Németország', 'Jobcenter'), { recursive: true })
    const known = buildKnownFolders(loadLifeConfig())
    const rels = known.map((f) => f.rel)
    expect(rels).toContain(`${PERSON}/Hatóságok`)
    expect(rels).toContain(`${PERSON}/Hatóságok/Németország`)
    expect(rels).toContain(`${PERSON}/Hatóságok/Németország/Jobcenter`)
  })

  it('nem letezo szemely-mappara nem dob hibat, csendben kihagyja', () => {
    const known = buildKnownFolders(loadLifeConfig())
    expect(known).toEqual([])
  })
})

describe('analyzeInboxItem -- meg nem letezo celmappa megtartva, elonezetre', () => {
  it('targetRel es targetDisplay AKKOR IS all, ha a javasolt celmappa kozben eltunt, targetExists false', () => {
    // Elobb "tanulunk" egy mar besorolt mintafajlbol -- ez adja az owner- es
    // kategoria-tippet magabiztosan --, majd a CELMAPPAT toroljuk, mielott
    // egy UJ, hasonlo nevu tetelt elemeznenk. Ez pontosan azt az esetet
    // szimulalja, amire a kartya #246 keszult: a javaslat MAGABIZTOS, a cel
    // megis hianyzik -- korabban ilyenkor a targetRel csendben elveszett,
    // most viszont vegig kell erjen a valaszig, hogy a felulet fel tudja
    // ajanlani a helyszini letrehozast.
    const config = loadLifeConfig()
    const categoryDir = join(root, PERSON, 'Hatóságok')
    mkdirSync(categoryDir, { recursive: true })
    writeFileSync(join(categoryDir, 'hatosag_level_regi.pdf'), 'x')
    const index = buildLearnedIndex(config)
    rmSync(categoryDir, { recursive: true, force: true })

    const item: InboxItem = {
      name: 'hatosag_level_uj.pdf', rel: 'hatosag_level_uj.pdf',
      isDir: false, size: 1, sizeHuman: '1 B', mtime: '', credentialWarning: '',
    }
    const sug = analyzeInboxItem(item, config, index, 'hu')

    expect(sug.owner.personId).toBe('p1')
    expect(sug.owner.uncertain).toBe(false)
    expect(sug.category.key).toBe('authorities')
    expect(sug.targetRel).toBe(`${PERSON}/Hatóságok`)
    expect(sug.targetDisplay).toBe(`${PERSON} / Hatóságok`)
    expect(sug.targetExists).toBe(false)
    expect(sug.notes.some((n) => n.includes('Mappa létrehozása'))).toBe(true)
  })

  it('targetExists true, ha a javasolt celmappa tenyleg ott van', () => {
    const config = loadLifeConfig()
    const categoryDir = join(root, PERSON, 'Hatóságok')
    mkdirSync(categoryDir, { recursive: true })
    writeFileSync(join(categoryDir, 'hatosag_level_regi.pdf'), 'x')
    const index = buildLearnedIndex(config)
    // Ezuttal a mappa a helyen marad.
    const item: InboxItem = {
      name: 'hatosag_level_uj.pdf', rel: 'hatosag_level_uj.pdf',
      isDir: false, size: 1, sizeHuman: '1 B', mtime: '', credentialWarning: '',
    }
    const sug = analyzeInboxItem(item, config, index, 'hu')
    expect(sug.targetRel).toBe(`${PERSON}/Hatóságok`)
    expect(sug.targetExists).toBe(true)
  })
})

describe('mkdirLifePath -- tobbszintes celutvonal egyben', () => {
  it('letrehozza a HIANYZO koztes szinteket is, egy hivasban', () => {
    const r = mkdirLifePath(`${PERSON}/Hatóságok/Németország/Jobcenter`)
    expect(r.ok).toBe(true)
    expect(existsSync(join(root, PERSON, 'Hatóságok'))).toBe(true)
    expect(existsSync(join(root, PERSON, 'Hatóságok', 'Németország'))).toBe(true)
    expect(existsSync(join(root, PERSON, 'Hatóságok', 'Németország', 'Jobcenter'))).toBe(true)
  })

  it('idempotens: ha egy koztes szint mar letezik, azt csendben kihagyja', () => {
    mkdirSync(join(root, PERSON, 'Hatóságok'), { recursive: true })
    const r = mkdirLifePath(`${PERSON}/Hatóságok/Németország/Jobcenter`)
    expect(r.ok).toBe(true)
    expect(existsSync(join(root, PERSON, 'Hatóságok', 'Németország', 'Jobcenter'))).toBe(true)
  })

  it('a fabol kivezeto utvonalat elutasitja', () => {
    const r = mkdirLifePath('../../kiszoktem')
    expect(r.ok).toBe(false)
  })

  it('utana a buildKnownFolders mar latja az uj mappat', () => {
    mkdirLifePath(`${PERSON}/Hatóságok/Németország/Jobcenter`)
    const known = buildKnownFolders(loadLifeConfig())
    expect(known.map((f) => f.rel)).toContain(`${PERSON}/Hatóságok/Németország/Jobcenter`)
  })
})
