// #794 (Boss TG 3594, 3612): an outgoing letter is suggested into the "Kimenő levelek" folder of the office's case,
// never the office root, when exactly one case folder has one. An incoming file keeps the office folder.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-ctxout-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-ctxout-store-'))
process.env.MARVEEN_DEPOT = depot
vi.mock('../config.js', async () => ({ ...(await vi.importActual<typeof import('../config.js')>('../config.js')), STORE_DIR: store }))

const { contextTarget } = await import('../workbench-life-context.js')
const { ensureExtraFolderOnce, classifyCaseKind } = await import('../workbench-life-case.js')

const person = { id: 'a', name: 'Teszt Elek', role: 'owner', countries: [], mediaGroups: [] }
writeFileSync(join(store, 'life-tree.json'), JSON.stringify({ persons: [person], companies: [], personsGroup: 'Család' }))
const office = join(depot, 'Család', 'Teszt Elek', 'Hatóságok', 'Németország', 'Wohngeldbehörde')
mkdirSync(join(office, '2026_10_uj_kerelem', 'Kimenő levelek'), { recursive: true })
mkdirSync(join(office, '2026_10_uj_kerelem', 'Kérelem'), { recursive: true })
mkdirSync(join(office, '2026_10_uj_kerelem', 'Bejövő levelek'), { recursive: true })
const CASE = 'Család/Teszt Elek/Hatóságok/Németország/Wohngeldbehörde/2026_10_uj_kerelem'

const project = { name: 'Iroda' } as any
const item = { title: 'Antwort Wohngeldbehörde Teszt Elek', folder: 'Munkadarabok/Wohngeld', container_folder: null } as any

describe('#794: a kimenő levél a Kimenő levelek mappába kerül', () => {
  it('kimenő levélnél az ügy Kimenő levelek mappája a javaslat', () => {
    const t = contextTarget(project, item, 'Antwort.pdf', 'hu', true)
    expect(t?.target).toBe('Család/Teszt Elek/Hatóságok/Németország/Wohngeldbehörde/2026_10_uj_kerelem/Kimenő levelek')
  })
  it('a hivatal levele a Bejövő levelek mappába megy, a kérelem a Kérelembe', () => {
    expect(contextTarget(project, item, 'Bescheid Wohngeld.pdf', 'hu', false)?.target).toBe(`${CASE}/Bejövő levelek`)
    expect(contextTarget(project, item, 'Wohngeldantrag_FINAL.pdf', 'hu', false)?.target).toBe(`${CASE}/Kérelem`)
  })
  it('a tartalom dönt, ha a név semmit nem mond', () => {
    expect(contextTarget(project, item, 'scan0001.pdf', 'hu', { text: 'Sehr geehrte Frau Korpas, Ihr Antrag auf Wohngeld: Bescheid' })?.target).toBe(`${CASE}/Bejövő levelek`)
  })
  it('a hatóság ügymappája nyer: az ügy fájlja soha nem a Jogi mappába megy', () => {
    const t = contextTarget(project, item, 'valami.docx', 'hu', { text: 'Wohngeld Antrag' })
    expect(t?.target.startsWith(CASE)).toBe(true)
  })
  it('ami egyik sem, az Egyéb-be kerül; az Egyéb-et egyszer hozzuk létre, és nem hozzuk vissza', () => {
    const egy = join(office, '2026_10_uj_kerelem', 'Egyéb')
    expect(classifyCaseKind('GPT_wohngeld_valasz_attekintes.md', '', false)).toBe('other')
    const t = contextTarget(project, item, 'GPT_wohngeld_valasz_attekintes.md', 'hu', false)
    expect(t?.target).toBe(`${CASE}/Egyéb`)
    expect(existsSync(egy)).toBe(false) // a javaslat nem hoz létre semmit
    ensureExtraFolderOnce(`${CASE}/Egyéb`)
    expect(existsSync(egy)).toBe(true)
    rmSync(egy, { recursive: true }) // a tulajdonos törölte
    ensureExtraFolderOnce(`${CASE}/Egyéb`)
    expect(existsSync(egy)).toBe(false) // nem hozzuk vissza
    expect(contextTarget(project, item, 'jegyzet.md', 'hu', false)?.target).toBe(CASE) // az ügymappába megy
  })
})
