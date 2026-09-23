// A SZALLITOTT autonomy-katalogus potlasa (kanban #336, 6. fazis).
//
// Miert van ra szukseg: egy Munkapad-tool a MEGLEVO autonomy-kategoriara
// kepzodik. Ha a kategoria hianyzik a telepites configjabol, a `decideTool`
// helyesen nem ad jogot -- DE a tulajdonos a Beallitasok / Onallosag lapon sem
// latja, tehat a feluletrol nem is tudna megadni. Ez a "friss telepitesen is
// mukodjon" szabaly csendes bukasa lenne.
//
// Amit oriz: a potlas csak HOZZAAD, sosem ir felul egy mar meghozott dontest,
// es ahol nem tud dolgozni, ott MEGMONDJA az okot (a nulla ket dolgot jelent).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAutonomyCategories, AUTONOMY_SEED_PATH, type AutonomyConfig } from '../autonomy.js'

let dir = ''
const storePath = () => join(dir, 'autonomy-config.json')
const seedPath = () => join(dir, 'seed.json')

function write(path: string, cfg: Partial<AutonomyConfig>): void {
  writeFileSync(path, JSON.stringify({ version: 1, updated_at: 0, categories: [], ...cfg }, null, 2), 'utf-8')
}
function read(path: string): AutonomyConfig {
  return JSON.parse(readFileSync(path, 'utf-8')) as AutonomyConfig
}
const cat = (key: string, level: number) => ({ key, label: key, level, locked: false, maxLevel: 3 })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'marveen-autonomy-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('ensureAutonomyCategories', () => {
  it('a hianyzo kategoriat a szallitott alapertekkel potolja', () => {
    write(storePath(), { categories: [cat('email_send', 2)] })
    write(seedPath(), { categories: [cat('email_send', 2), cat('workbench_file_write', 2)] })
    const r = ensureAutonomyCategories(storePath(), seedPath())
    expect(r.reason).toBe('ok')
    expect(r.added).toEqual(['workbench_file_write'])
    expect(read(storePath()).categories.map((c) => c.key)).toEqual(['email_send', 'workbench_file_write'])
  })

  it('a MEGLEVO dontest nem irja felul -- se szintet, se zarat', () => {
    // A tulajdonos levitte a sajatjat 1-re, a szallitott katalogus 3-at mond.
    write(storePath(), { categories: [{ key: 'email_send', label: 'sajat', level: 1, locked: true, maxLevel: 1 }] })
    write(seedPath(), { categories: [cat('email_send', 3)] })
    const r = ensureAutonomyCategories(storePath(), seedPath())
    expect(r.reason).toBe('nothing_missing')
    const after = read(storePath()).categories[0]
    expect(after.level).toBe(1)
    expect(after.locked).toBe(true)
    expect(after.label).toBe('sajat')
  })

  it('ha nincs mit potolni, nem is ir a fajlba', () => {
    write(storePath(), { categories: [cat('email_send', 2)] })
    write(seedPath(), { categories: [cat('email_send', 2)] })
    const before = readFileSync(storePath(), 'utf-8')
    expect(ensureAutonomyCategories(storePath(), seedPath()).reason).toBe('nothing_missing')
    expect(readFileSync(storePath(), 'utf-8')).toBe(before)
  })

  it('hianyzo fajlnal MEGMONDJA, melyik hianyzik -- nem csendes nulla', () => {
    write(seedPath(), { categories: [cat('email_send', 2)] })
    expect(ensureAutonomyCategories(join(dir, 'nincs.json'), seedPath()).reason).toBe('no_store_config')
    write(storePath(), { categories: [] })
    expect(ensureAutonomyCategories(storePath(), join(dir, 'nincs.json')).reason).toBe('no_seed_config')
  })

  it('olvashatatlan fajlnal a TENYLEGES hibauzenet megy tovabb, nem talalgatas', () => {
    writeFileSync(storePath(), '{ ez nem json', 'utf-8')
    write(seedPath(), { categories: [cat('email_send', 2)] })
    const r = ensureAutonomyCategories(storePath(), seedPath())
    expect(r.reason).toBe('unreadable')
    expect((r.detail || '').length).toBeGreaterThan(0)
  })

  it('a szallitott katalogus ismeri a Munkapad fajl-iro kategoriajat', () => {
    // Enelkul egy FRISS telepitesen a file.write se jogot, se lathato
    // kapcsolot nem kapna.
    const seed = read(AUTONOMY_SEED_PATH)
    const c = seed.categories.find((x) => x.key === 'workbench_file_write')
    expect(c).toBeTruthy()
    expect(c!.level).toBe(2)
    expect(c!.maxLevel).toBeGreaterThanOrEqual(3)
  })
})
