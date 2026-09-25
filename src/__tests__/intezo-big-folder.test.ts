/**
 * Card #389 -- Boss (TG 1509): "Mind kijelolese ... 2000 elem kijelolve, ez
 * igaz lenne? Itt valami bug van." The Vegyes photo folder holds 3615 files;
 * the listing silently stopped at 2000 and "select all" presented that part as
 * the whole folder. A folder of a few thousand photos must list completely, and
 * if a listing is ever cut, the screen must say "n of total".
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-bigfolder-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-bfstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { listLife, explorerRoot, MAX_ENTRIES } = await import('../life-explorer.js')
const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) throw new Error('A teszt nem az ideiglenes depon all.')

describe('Intezo nagy mappa (#389)', () => {
  it('a 3615 fajlos mappa teljesen listazodik, nincs levagas', () => {
    mkdirSync(join(root, 'Vegyes'), { recursive: true })
    for (let i = 0; i < 3615; i++) writeFileSync(join(root, 'Vegyes', `${i}.jpg`), '')
    const l = listLife('Vegyes', { lang: 'hu', content: false })
    expect(l.files.length).toBe(3615)
    expect(l.truncated).toBe(false)
    expect(l.total ?? null).toBeNull()
  })

  it('a korlat joval a valodi fotomappak folott van', () => {
    expect(MAX_ENTRIES).toBeGreaterThanOrEqual(10000)
  })

  it('levagasnal a teljes elemszam kimegy (forras-szerzodes)', () => {
    const src = readFileSync(join(__dirname, '..', 'life-explorer.ts'), 'utf8')
    expect(src).toMatch(/base\.truncated = true\s*\n\s*base\.total = names\.filter/)
  })

  it('a kijeloles-szamlalo levagott mappanal "n / total"-t mond, ket nyelven', () => {
    const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
    expect(app).toContain("t('intezo.multi_count_partial', { n, total: L.total })")
    expect(app).toContain("t('intezo.truncated_n', { n: shown, total: L.total })")
    for (const f of ['hu.js', 'en.js']) {
      const lang = readFileSync(join(__dirname, '..', '..', 'web', 'lang', f), 'utf8')
      expect(lang).toContain("'intezo.multi_count_partial'")
      expect(lang).toContain("'intezo.truncated_n'")
    }
  })

  it('a levagas-jelzes a lista FOLOTT all, nem 2000 csempe alatt', () => {
    const html = readFileSync(join(__dirname, '..', '..', 'web', 'index.html'), 'utf8')
    expect(html.indexOf('id="intezoTruncated"')).toBeLessThan(html.indexOf('id="intezoList"'))
  })
})
