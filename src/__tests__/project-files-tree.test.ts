// A projekt Fajlok fule mapparendszerkent + kereso (kanban #359).
//
// Amit ez a teszt orzi:
//   - a mappa szintenkent jon: elol a mappak (darabszammal), utana a fajlok;
//     rejtett, node_modules, desktop.ini / Thumbs.db nem latszik;
//   - lenyitaskor az almappa szintje jon, projekten kivulre nem vezet ut;
//   - a kereso CSAK a projekt mappajaban keres, ekezet- es kisbetu-fuggetlenul,
//     mappat es fajlt is talal;
//   - az ures projektmappa nem hiba, a raktar nelkuli allapot kulon kod
//     (a "0 elem" es a "nem lattam oda" nem keveredik).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_LANG: 'hu' }))
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { listProjectDir, findProjectFiles, _resetProjectNameIndexes, writeProjectNote } from '../project-files.js'
import { tryHandleProjects } from '../web/routes/projects.js'
import type { RouteContext } from '../web/routes/types.js'

describe('projekt Fajlok ful: mapparendszer + kereso', () => {
  let depot: string
  let saved: string | undefined
  beforeEach(() => {
    initDatabase(':memory:')
    _resetProjectNameIndexes()
    saved = process.env.MARVEEN_DEPOT
    depot = mkdtempSync(join(tmpdir(), 'marveen-prjtree-'))
    process.env.MARVEEN_DEPOT = depot
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.MARVEEN_DEPOT
    else process.env.MARVEEN_DEPOT = saved
    rmSync(depot, { recursive: true, force: true })
  })
  function project() {
    const w = join(depot, 'Projektek', 'Tozsde')
    mkdirSync(w, { recursive: true })
    const r = createProject({ name: 'Tozsde', folder_path: 'Projektek/Tozsde' })
    if (!r.ok) throw new Error(r.code)
    return { p: r.project, w }
  }
  function put(base: string, rel: string, body = 'x') {
    const parts = rel.split('/')
    mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true })
    writeFileSync(join(base, ...parts), body)
  }
  function call(path: string) {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
    const req: any = { headers: {}, on() { return req }, destroy() {} }
    const url = new URL('http://localhost:3420' + path)
    return tryHandleProjects({ req, res, path: url.pathname, method: 'GET', url } as RouteContext).then(() => out)
  }

  it('egy szint: mappak elol darabszammal, fajlok utana; a szemet nem latszik', () => {
    const { p, w } = project()
    put(w, 'mt4/tester/EURUSD.set')
    put(w, 'mt4/tester/GBPUSD.set')
    put(w, 'mt4/history/EURUSD60.hst', 'xxxx')
    put(w, 'jegyzet.md', 'hello')
    put(w, '.rejtett/a.txt')
    put(w, 'node_modules/x/a.js')
    put(w, 'desktop.ini')
    const root = listProjectDir(p, '')
    expect(root.ok).toBe(true)
    if (!root.ok) return
    expect(root.entries.map((e) => [e.kind, e.name])).toEqual([['dir', 'mt4'], ['file', 'jegyzet.md']])
    expect(root.entries[0]).toMatchObject({ sub: 'mt4', children: 2 })
    expect(root.entries[1]).toMatchObject({ sub: 'jegyzet.md', size: 5 })
    const tester = listProjectDir(p, 'mt4/tester')
    expect(tester.ok && tester.entries.map((e) => e.sub)).toEqual(['mt4/tester/EURUSD.set', 'mt4/tester/GBPUSD.set'])
    // Projekten kivulre nem vezet ut.
    expect(listProjectDir(p, '../..')).toEqual({ ok: false, code: 'bad_folder' })
    expect(listProjectDir(p, 'nincs-ilyen')).toEqual({ ok: false, code: 'bad_folder' })
  })

  it('ures projektmappa: ok + ures lista; raktar nelkul kulon kod', () => {
    const { p } = project()
    expect(listProjectDir(p, '')).toEqual({ ok: true, sub: '', entries: [], truncated: false })
    delete process.env.MARVEEN_DEPOT
    const r = listProjectDir(p, '')
    expect(r.ok).toBe(false)
  })

  it('a kereso csak a projektben, ekezet- es kisbetu-fuggetlenul, mappat is talal', async () => {
    const { p, w } = project()
    put(w, 'mt4/tester/EURUSD.set')
    put(w, 'Háttér/Árfolyam-elemzés.pdf')
    put(join(depot, 'Masik'), 'eurusd-idegen.set')
    const r = await findProjectFiles(p, 'eurusd')
    expect(r.ok && r.hits.map((h) => h.sub)).toEqual(['mt4/tester/EURUSD.set'])
    const acc = await findProjectFiles(p, 'arfolyam')
    expect(acc.ok && acc.hits.map((h) => h.sub)).toEqual(['Háttér/Árfolyam-elemzés.pdf'])
    const dir = await findProjectFiles(p, 'TESTER')
    expect(dir.ok && dir.hits).toEqual([expect.objectContaining({ kind: 'dir', sub: 'mt4/tester' })])
    expect(await findProjectFiles(p, 'nincs-ilyen')).toMatchObject({ ok: true, hits: [], truncated: false })
    expect(await findProjectFiles(p, 'e')).toEqual({ ok: false, code: 'query_short' })
  })

  it('az idokorlat utan truncated jelzessel all meg (a 0 nem "nincs")', async () => {
    const { p, w } = project()
    for (let i = 0; i < 30; i++) put(w, `d${i}/x${i}.txt`)
    const r = await findProjectFiles(p, 'nincs-ilyen', -1)
    expect(r).toMatchObject({ ok: true, hits: [], truncated: true, indexing: true, more: false })
    // Az index a hatterben kesz lesz; a kovetkezo kereses mar a teljes mappabol.
    const again = await findProjectFiles(p, 'nincs-ilyen')
    expect(again).toMatchObject({ ok: true, hits: [], truncated: false, indexing: false, capped: false })
    expect(await findProjectFiles(p, 'x29')).toMatchObject({ hits: [expect.objectContaining({ sub: 'd29/x29.txt' })], truncated: false })
  })

  it('uj jegyzet utan a kereso azonnal latja (a gyorsitotar urul)', async () => {
    const { p } = project()
    expect(await findProjectFiles(p, 'friss')).toMatchObject({ hits: [] })
    expect(writeProjectNote(p, '', 'friss-jegyzet', 'x', 'md')).toMatchObject({ ok: true })
    // Kozvetlen hivas: a gyorsitotar meg a regi -- ezert uriti a route.
    const { forgetProjectNameIndex } = await import('../project-files.js')
    forgetProjectNameIndex(p)
    expect((await findProjectFiles(p, 'friss')).ok && (await findProjectFiles(p, 'friss') as any).hits.map((h: any) => h.name)).toEqual(['friss-jegyzet.md'])
  })

  it('HTTP: /tree es /find, emberi hibauzenettel', async () => {
    const { p, w } = project()
    put(w, 'mt4/tester/EURUSD.set')
    const t = await call(`/api/projects/${p.id}/tree?lang=hu`)
    expect(t.body).toMatchObject({ state: 'ok', dir: '', entries: [expect.objectContaining({ name: 'mt4', kind: 'dir' })] })
    const sub = await call(`/api/projects/${p.id}/tree?dir=${encodeURIComponent('mt4/tester')}`)
    expect(sub.body.entries.map((e: any) => e.name)).toEqual(['EURUSD.set'])
    const bad = await call(`/api/projects/${p.id}/tree?dir=..%2F..&lang=hu`)
    expect(bad.status).toBe(400)
    expect(typeof bad.body.message).toBe('string')
    const f = await call(`/api/projects/${p.id}/find?q=eur`)
    expect(f.body.hits.map((h: any) => h.name)).toEqual(['EURUSD.set'])
    const short = await call(`/api/projects/${p.id}/find?q=e&lang=en`)
    expect(short.status).toBe(400)
    expect(short.body.message).toMatch(/two letters/)
  })
})
