// #406, 8. pont -- KERESES A PROJEKT EGESZEBEN a Munkapadon: a szerver merese
// (mit talal, mit NEM lat) ES a felulet (mit lat a felhasznalo).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'

const files = vi.hoisted(() => ({ fn: null as null | ((p: unknown, q: string) => Promise<unknown>) }))
vi.mock('../project-files.js', async (orig) => {
  const real = await orig<typeof import('../project-files.js')>()
  return { ...real, findProjectFiles: (p: any, q: string) => (files.fn ? files.fn(p, q) : real.findProjectFiles(p, q)) }
})

import { initDatabase, createKanbanCard, createIdea, getDb } from '../db.js'
import { createProject, getProject, linkObject } from '../projects.js'
import { createWorkItem, addWorkItemPart } from '../workbench.js'
import { createAgentSession, addAgentMessage } from '../workbench-agent/sessions.js'
import { searchProject, matchSnippet, SEARCH_MAX_PER_SOURCE } from '../workbench-search.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import type { RouteContext } from '../web/routes/types.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

async function get(path: string): Promise<{ status: number; body: any }> {
  const chunks: Buffer[] = []
  const out = { status: 200 }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const done = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (s: number) => { out.status = s; return res }
  res.setHeader = () => res
  const req: any = Readable.from([Buffer.alloc(0)])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method: 'GET', url, auth: { kind: 'session', user: 'teszt' } } as unknown as RouteContext
  if (await tryHandleWorkbench(ctx)) await done
  const s = Buffer.concat(chunks).toString('utf-8')
  return { status: out.status, body: s ? JSON.parse(s) : null }
}

let pid = ''
let other = ''

function item(title: string, projectId = pid) {
  const r = createWorkItem({ project_id: projectId, title, type: 'note' })
  if (!r.ok) throw new Error('nem jott letre')
  return r.item
}

async function search(q: string, projectId = pid) {
  const r = await searchProject(getProject(projectId)!, q)
  if (!r.ok) throw new Error(r.code)
  return r.result
}

const state = (r: Awaited<ReturnType<typeof search>>, s: string) => r.sources.find((x) => x.source === s)

describe('kereses: a szerver merese', () => {
  beforeEach(() => {
    files.fn = null
    initDatabase(':memory:')
    const a = createProject({ name: 'Kovács weboldal' })
    const b = createProject({ name: 'Másik' })
    if (!a.ok || !b.ok) throw new Error('projekt')
    pid = a.project.id
    other = b.project.id
  })

  it('kivonat: ekezet- es kisbetu-fuggetlen, a kiemeles az EREDETI szovegben all', () => {
    const m = matchSnippet('Az új LOGÓ színei', 'logo')!
    expect(m.snippet.slice(m.mark_start, m.mark_end)).toBe('LOGÓ')
    expect(matchSnippet('semmi', 'logo')).toBeNull()
    const long = 'a'.repeat(200) + ' Logó ' + 'b'.repeat(200)
    const l = matchSnippet(long, 'logo')!
    expect(l.snippet.startsWith('…')).toBe(true)
    expect(l.snippet.endsWith('…')).toBe(true)
    expect(l.snippet.slice(l.mark_start, l.mark_end)).toBe('Logó')
  })

  it('tul rovid / tul hosszu kereses: kod, nem ures talalat', async () => {
    expect(await searchProject(getProject(pid)!, ' a ')).toEqual({ ok: false, code: 'query_short' })
    expect(await searchProject(getProject(pid)!, 'x'.repeat(201))).toEqual({ ok: false, code: 'query_long' })
  })

  it('cim, szoveg, kepalairas, beszelgetes, kartya, otlet -- es CSAK ebbol a projektbol', async () => {
    const w = item('Logó terv')
    addWorkItemPart({ work_item_id: w.id, kind: 'text', text: 'A logo legyen kék.' })
    addWorkItemPart({ work_item_id: w.id, kind: 'image', asset_path: 'Projektek/kovacs/a.png', caption: 'Régi logó' })
    const s = createAgentSession({ project_id: pid, work_item_id: w.id })
    addAgentMessage(s.id, 'user', 'Csinálj egy új logót')
    addAgentMessage(s.id, 'assistant', 'Kész a logó vázlat')
    createKanbanCard({ id: 'aaaa1111', title: 'Logó véglegesítése', project: pid })
    createIdea({ id: 'i1', title: 'Animált logó', description: null, category: 'x', status: 'new', source: 'teszt', kanban_id: null, impact: null, effort: null })
    linkObject(pid, 'idea', 'i1')
    // Idegen projekt: ugyanaz a szo, NEM johet elo.
    const x = item('Idegen logó', other)
    addWorkItemPart({ work_item_id: x.id, kind: 'text', text: 'logo' })
    createKanbanCard({ id: 'bbbb2222', title: 'Idegen logó kártya', project: other })
    const so = createAgentSession({ project_id: other, work_item_id: x.id })
    addAgentMessage(so.id, 'user', 'idegen logo')

    const r = await search('LOGO')
    const by = (src: string) => r.hits.filter((h) => h.source === src)
    expect(by('items').map((h) => h.item_id)).toEqual([w.id])
    expect(by('texts')).toHaveLength(1)
    expect(by('captions')[0].snippet).toBe('Régi logó')
    expect(by('messages').map((h) => h.role).sort()).toEqual(['assistant', 'user'])
    expect(by('messages')[0].item_id).toBe(w.id)
    expect(by('cards').map((h) => h.card_id)).toEqual(['aaaa1111'])
    expect(typeof by('cards')[0].card_seq).toBe('number')
    expect(by('ideas').map((h) => h.idea_id)).toEqual(['i1'])
    expect(JSON.stringify(r.hits)).not.toContain('Idegen')
    expect(r.sources.every((s) => s.state === 'ok' || (s.source === 'files' && s.state === 'none'))).toBe(true)
  })

  it('mappa nelkuli projekt: a fajlok forrasa "none", NEM nulla talalat', async () => {
    const r = await search('logo')
    expect(state(r, 'files')).toMatchObject({ state: 'none', total: 0 })
  })

  it('fajlnevek: a nev-indexbol, a reszleges valasz kimondva', async () => {
    getDb().prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run('Projektek/kovacs', pid)
    files.fn = async () => ({
      ok: true, truncated: false, indexing: true, more: false, capped: false,
      hits: [{ name: 'logo_v2.png', sub: 'kepek/logo_v2.png', kind: 'file', at: 5000, size: 1 }],
    })
    const r = await search('logo')
    expect(state(r, 'files')).toMatchObject({ state: 'ok', total: 1, partial: true })
    const h = r.hits.find((x) => x.source === 'files')!
    expect(h.path).toBe('kepek/logo_v2.png')
    expect(h.at).toBe(5)
  })

  it('olvashatatlan forras: "error" allapot, a tobbi forras tovabb megy', async () => {
    getDb().prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run('Projektek/kovacs', pid)
    files.fn = async () => { throw new Error('halozati meghajto nem elerheto') }
    item('Logó')
    const r = await search('logo')
    expect(state(r, 'files')).toMatchObject({ state: 'error', detail: 'halozati meghajto nem elerheto' })
    expect(state(r, 'items')).toMatchObject({ state: 'ok', total: 1 })
  })

  it('forrasonkent legfeljebb SEARCH_MAX_PER_SOURCE talalat, de a total a valodi szam', async () => {
    for (let i = 0; i < SEARCH_MAX_PER_SOURCE + 5; i++) item(`Logó ${i}`)
    const r = await search('logo')
    expect(r.hits.filter((h) => h.source === 'items')).toHaveLength(SEARCH_MAX_PER_SOURCE)
    expect(state(r, 'items')!.total).toBe(SEARCH_MAX_PER_SOURCE + 5)
  })

  it('route: projekt nelkul 400, ismeretlen projekt 404, rovid kereses 400 ket nyelvu mondattal', async () => {
    expect((await get('/api/workbench/search?q=logo')).status).toBe(400)
    expect((await get('/api/workbench/search?project=nincs&q=logo')).status).toBe(404)
    const short = await get(`/api/workbench/search?project=${pid}&q=a&lang=en`)
    expect(short.status).toBe(400)
    expect(short.body.message).toContain('at least 2')
    const hu = await get(`/api/workbench/search?project=${pid}&q=a`)
    expect(hu.body.message).toContain('legalább 2')
    item('Logó')
    const ok = await get(`/api/workbench/search?project=${pid}&q=logo`)
    expect(ok.status).toBe(200)
    expect(ok.body.search.hits[0].title).toBe('Logó')
  })
})

describe('kereses: a felulet', () => {
  const SRC = (source: string, state = 'ok', total = 0, extra: Record<string, unknown> = {}) => ({ source, state, total, detail: null, ...extra })
  const HIT = (source: string, extra: Record<string, unknown> = {}) => ({
    source, item_id: null, item_title: null, card_id: null, card_seq: null, idea_id: null, path: null,
    title: '', snippet: 'az új logó', mark_start: 6, mark_end: 10, role: null, at: null, ...extra,
  })

  function open(h: ReturnType<typeof workbenchHarness>, reply: unknown) {
    h.respond((url) => {
      if (url.includes('/api/workbench/search')) {
        if (reply && typeof reply === 'object' && 'status' in (reply as any)) return reply as any
        return { status: 200, body: { search: reply } }
      }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: { id: 'w1', title: 'Ajánlat', type: 'note', status: 'draft' }, versions: [], parts: [] } }
      return { status: 200, body: itemsBody([{ id: 'w1', title: 'Ajánlat', type: 'note', status: 'draft' }]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'search-open' })
  }

  function submit(h: ReturnType<typeof workbenchHarness>, q: string) {
    h.inputs.wbSearchInput = { value: q, focus() {} }
    h.fire('submit', { target: { id: 'wbSearchForm' }, preventDefault() {} })
  }

  it('talalatok forrasonkent, kiemelve; a munkadarab talalata megnyitja a munkadarabot', async () => {
    const h = workbenchHarness()
    open(h, {
      q: 'logo',
      hits: [HIT('items', { item_id: 'w1', title: 'Ajánlat' }), HIT('cards', { card_seq: 12, title: 'Logó kártya' })],
      sources: [SRC('items', 'ok', 1), SRC('texts'), SRC('captions'), SRC('messages'), SRC('cards', 'ok', 1), SRC('ideas'), SRC('files', 'none')],
    })
    expect(h.html()).toContain('workbench.search.title')
    submit(h, 'logo')
    await vi.waitFor(() => expect(h.html()).toContain('wb-search-hit'))
    const html = h.html()
    expect(html).toContain('<mark>logó</mark>')
    expect(html).toContain('workbench.search.source.items')
    expect(html).toContain('#12 Logó kártya')
    expect(html).not.toContain('workbench.search.source.texts')
    expect(html).toContain('workbench.search.no_folder')
    expect(untranslatedHungarian(html, ['Kovács weboldal', 'Ajánlat', 'Logó kártya', 'az új ', 'logó'])).toBe('')
    expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/search?project=p1&q=logo'))).toBe(true)
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/w1'))).toBe(true))
  })

  it('egy betu: helyben szol, nem kerdezi a szervert', async () => {
    const h = workbenchHarness()
    open(h, { q: '', hits: [], sources: [] })
    submit(h, 'a')
    await vi.waitFor(() => expect(h.html()).toContain('workbench.search.too_short'))
    expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/search'))).toBe(false)
  })

  it('nincs talalat: mondat -- de ha egy forras olvashatatlan, AZT mondja, nem a "nincs"-et', async () => {
    const h = workbenchHarness()
    open(h, { q: 'xy', hits: [], sources: [SRC('items'), SRC('files', 'error')] })
    submit(h, 'xy')
    await vi.waitFor(() => expect(h.html()).toContain('workbench.search.partial'))
    expect(h.html()).toContain('workbench.search.source.files')
    expect(h.html()).not.toContain('workbench.search.none')

    const h2 = workbenchHarness()
    open(h2, { q: 'xy', hits: [], sources: [SRC('items'), SRC('files')] })
    submit(h2, 'xy')
    await vi.waitFor(() => expect(h2.html()).toContain('workbench.search.none'))
  })

  it('szerverhiba: a szerver mondata latszik', async () => {
    const h = workbenchHarness()
    open(h, { status: 500, body: { error: 'x', message: 'Belső hiba' } })
    submit(h, 'logo')
    await vi.waitFor(() => expect(h.html()).toContain('Belső hiba'))
    expect(h.html()).not.toContain('workbench.search.none')
  })
})
