// Regression test: the Explorer search (GET /api/life/search) must not freeze the dashboard's main thread.
//
// What was measured on the live machine (#944 verification, /api/perf/stalls): typing into the Explorer search
// froze the event loop for 47-70 s -- every stack was searchLife -> statSync, one blocking stat per entry of the
// walk (up to 20000), on a slow (9p/Windows) disk. Other requests (GET /api/workbench/items, /api/life/dirsize,
// agent/status) just sat behind it. Fix: the walk is asynchronous, takes a directory listing with entry types
// (no stat per entry), and gives the loop a turn between steps.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-lsearch-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-lsearch-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { searchLife } = await import('../life-explorer.js')

function bigTree(dirs: number, filesPerDir: number) {
  for (let d = 0; d < dirs; d++) {
    const dir = join(depot, `mappa-${d}`, 'belso')
    mkdirSync(dir, { recursive: true })
    for (let f = 0; f < filesPerDir; f++) writeFileSync(join(dir, `fajl-${f}.txt`), 'x')
  }
}

describe('searchLife does not block the main thread', () => {
  it('the event loop keeps getting turns while a big tree is walked', async () => {
    bigTree(120, 10)
    writeFileSync(join(depot, 'mappa-77', 'belso', 'cel-talalat.pdf'), 'x')
    let ticks = 0
    let stop = false
    const spin = () => { if (stop) return; ticks++; setImmediate(spin) }
    setImmediate(spin)
    const r = await searchLife('', 'cel-talalat')
    stop = true
    expect(r.entries.map((e) => e.name)).toEqual(['cel-talalat.pdf'])
    // A synchronous walk gives the loop ZERO turns until it is done.
    expect(ticks).toBeGreaterThan(5)
  })

  it('the walk does not stat every entry (a stat per entry was the 60 s freeze); the source has no blocking fs call', () => {
    const src = readFileSync(new URL('../life-explorer.ts', import.meta.url), 'utf8')
    const start = src.indexOf('export async function searchLife')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}\n', start))
    expect(body).not.toMatch(/\b(statSync|readdirSync|lstatSync|realpathSync)\(/)
  })

  it('a cancelled search stops walking and returns what it has', async () => {
    bigTree(40, 5)
    let calls = 0
    const r = await searchLife('', 'fajl-', 200, 'hu', { cancelled: () => ++calls > 3 })
    expect(calls).toBeLessThan(50)
    expect(r.truncated).toBe(true)
  })

  it('a symlinked folder is still walked into and a broken link is skipped, like before', async () => {
    mkdirSync(join(depot, 'valodi-mappa'), { recursive: true })
    writeFileSync(join(depot, 'valodi-mappa', 'linkelt-cel.docx'), 'x')
    symlinkSync(join(depot, 'valodi-mappa'), join(depot, 'link-mappa'))
    symlinkSync(join(depot, 'nincs-ilyen'), join(depot, 'torott-link'))
    const r = await searchLife('', 'linkelt-cel')
    expect(r.entries.map((e) => e.rel).sort()).toEqual(['link-mappa/linkelt-cel.docx', 'valodi-mappa/linkelt-cel.docx'])
    const broken = await searchLife('', 'torott-link')
    expect(broken.entries).toEqual([])
  })
})
