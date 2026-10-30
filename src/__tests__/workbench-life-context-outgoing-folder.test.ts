// #794 (Boss TG 3594, 3612): an outgoing letter is suggested into the "Kimenő levelek" folder of the office's case,
// never the office root, when exactly one case folder has one. An incoming file keeps the office folder.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-ctxout-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-ctxout-store-'))
process.env.MARVEEN_DEPOT = depot
vi.mock('../config.js', async () => ({ ...(await vi.importActual<typeof import('../config.js')>('../config.js')), STORE_DIR: store }))

const { contextTarget } = await import('../workbench-life-context.js')

const person = { id: 'a', name: 'Teszt Elek', role: 'owner', countries: [], mediaGroups: [] }
writeFileSync(join(store, 'life-tree.json'), JSON.stringify({ persons: [person], companies: [], personsGroup: 'Család' }))
const office = join(depot, 'Család', 'Teszt Elek', 'Hatóságok', 'Németország', 'Wohngeldbehörde')
mkdirSync(join(office, '2026_10_uj_kerelem', 'Kimenő levelek'), { recursive: true })
mkdirSync(join(office, '2026_10_uj_kerelem', 'Kérelem'), { recursive: true })

const project = { name: 'Iroda' } as any
const item = { title: 'Antwort Wohngeldbehörde Teszt Elek', folder: 'Munkadarabok/Wohngeld', container_folder: null } as any

describe('#794: a kimenő levél a Kimenő levelek mappába kerül', () => {
  it('kimenő levélnél az ügy Kimenő levelek mappája a javaslat', () => {
    const t = contextTarget(project, item, 'Antwort.pdf', 'hu', true)
    expect(t?.target).toBe('Család/Teszt Elek/Hatóságok/Németország/Wohngeldbehörde/2026_10_uj_kerelem/Kimenő levelek')
  })
  it('bejövő fájlnál marad a hivatal mappa', () => {
    const t = contextTarget(project, item, 'Antwort.pdf', 'hu', false)
    expect(t?.target).toBe('Család/Teszt Elek/Hatóságok/Németország/Wohngeldbehörde')
  })
})
