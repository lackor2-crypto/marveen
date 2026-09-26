// #406, 11. pont -- SABLONOK: a szerver (letrehozas egy tranzakcioban, HU/EN),
// az agens (workItem.fromTemplate) ES a felulet (egy kattintas).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import { listWorkItems, listWorkItemParts } from '../workbench.js'
import { WORKBENCH_TEMPLATES, listTemplates, createFromTemplate } from '../workbench-templates.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { toolLabel } from '../workbench-agent/approval-text.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import type { RouteContext } from '../web/routes/types.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const chunks: Buffer[] = []
  const out = { status: 200 }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const done = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (s: number) => { out.status = s; return res }
  res.setHeader = () => res
  const req: any = Readable.from([Buffer.from(body == null ? '' : JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: 'session', user: 'teszt' } } as unknown as RouteContext
  if (await tryHandleWorkbench(ctx)) await done
  const s = Buffer.concat(chunks).toString('utf-8')
  return { status: out.status, body: s ? JSON.parse(s) : null }
}

let pid = ''

describe('sablonok: a szerver', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const a = createProject({ name: 'Kovács weboldal' })
    if (!a.ok) throw new Error('projekt')
    pid = a.project.id
  })

  it('a negy kert sablon megvan, mindegyik szovege KET nyelven, telepitesfuggo nev nelkul', () => {
    expect(WORKBENCH_TEMPLATES.map((t) => t.id)).toEqual(['offer', 'letter', 'social_post', 'invitation'])
    for (const t of WORKBENCH_TEMPLATES) {
      expect(t.parts.length).toBeGreaterThan(1)
      for (const x of [t.name, t.description, ...t.parts]) {
        expect(x.hu.trim()).not.toBe('')
        expect(x.en.trim()).not.toBe('')
        // Az angol valtozatba nem csuszott magyar szoveg.
        expect(x.en).not.toMatch(/[áéíóöőúüű]/i)
      }
    }
    expect(listTemplates('en').map((t) => t.name)).toEqual(['Offer', 'Letter', 'Social post', 'Invitation'])
    expect(listTemplates('hu')[0]).toMatchObject({ id: 'offer', name: 'Ajánlat', part_count: 5 })
  })

  it('friss telepites: ures projektben egy hivas = munkadarab + v1 + minden resz', () => {
    expect(listWorkItems(pid)).toEqual([])
    const r = createFromTemplate({ id: pid }, 'offer', { lang: 'hu', created_by: 'teszt' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.item).toMatchObject({ title: 'Ajánlat', type: 'document', project_id: pid })
    expect(r.parts.map((p) => p.text)).toEqual(WORKBENCH_TEMPLATES[0].parts.map((p) => p.hu))
    expect(r.parts.every((p) => p.version_id === r.version.id)).toBe(true)
    expect(listWorkItemParts(r.item.id)).toHaveLength(5)
  })

  it('a megadott cim felulirja a sablon nevet; a kozossegi poszt vegyes munkadarab', () => {
    const r = createFromTemplate({ id: pid }, 'social_post', { title: '  Nyári akció  ', lang: 'en' })
    expect(r).toMatchObject({ ok: true, item: { title: 'Nyári akció', type: 'composite' } })
  })

  it('ismeretlen sablon / tul hosszu cim: semmi nem jon letre', () => {
    expect(createFromTemplate({ id: pid }, 'nincs', { lang: 'hu' })).toMatchObject({ ok: false, code: 'template_not_found' })
    expect(createFromTemplate({ id: pid }, 'letter', { lang: 'hu', title: 'x'.repeat(201) })).toMatchObject({ ok: false, code: 'title_too_long' })
    expect(listWorkItems(pid)).toEqual([])
  })

  it('vegpontok: lista a felulet nyelven, letrehozas 201, a hibak emberi mondattal', async () => {
    const l = await call('GET', '/api/workbench/templates?lang=en')
    expect(l.status).toBe(200)
    expect(l.body.templates.map((t: any) => t.name)).toContain('Invitation')
    const c = await call('POST', '/api/workbench/templates/use?lang=hu', { project_id: pid, template: 'invitation' })
    expect(c.status).toBe(201)
    expect(c.body).toMatchObject({ ok: true, item: { title: 'Meghívó', created_by: 'teszt' }, template: 'invitation' })
    expect(c.body.parts).toHaveLength(4)
    expect(c.body.versions).toHaveLength(1)
    const bad = await call('POST', '/api/workbench/templates/use?lang=hu', { project_id: pid, template: 'nincs' })
    expect(bad.status).toBe(404)
    expect(bad.body.message).toMatch(/Ilyen sablon nincs/)
    const noProj = await call('POST', '/api/workbench/templates/use?lang=en', { template: 'offer' })
    expect(noProj.status).toBe(400)
    expect(typeof noProj.body.message).toBe('string')
  })

  it('archivalt projektbe nem enged', async () => {
    setProjectArchived(pid, true)
    const r = await call('POST', '/api/workbench/templates/use?lang=hu', { project_id: pid, template: 'offer' })
    expect(r.status).toBe(409)
    expect(listWorkItems(pid)).toEqual([])
  })
})

describe('sablonok: az agens', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const a = createProject({ name: 'Kovács weboldal' })
    if (!a.ok) throw new Error('projekt')
    pid = a.project.id
  })
  const ctx = () => ({ projectId: pid, workItemId: null, lang: 'en' as const })

  it('workItem.fromTemplate: ehhez a projekthez, a nyelven; rossz sablonnal megmondja, mi van', () => {
    expect(getTool('workItem.fromTemplate')?.autonomyCategory).toBe('marveen_selfdev')
    expect(toolLabel('workItem.fromTemplate', 'hu')).toBe('új munkadarab sablonból')
    const r = executeTool('workItem.fromTemplate', { template: 'letter' }, ctx())
    expect(r).toMatchObject({ ok: true, data: { item: { title: 'Letter', project_id: pid, created_by: 'workbench-agent' } } })
    const bad = executeTool('workItem.fromTemplate', { template: 'poem' }, ctx())
    expect(bad).toMatchObject({ ok: false, code: 'template_not_found' })
    expect((bad as any).detail).toContain('offer, letter, social_post, invitation')
  })
})

describe('sablonok: a felulet', () => {
  const TPL = [
    { id: 'offer', type: 'document', name: 'Ajánlat', description: 'Árajánlat egy ügyfélnek.', part_count: 5, first_line: 'x' },
    { id: 'letter', type: 'document', name: 'Levél', description: 'Hivatalos levél.', part_count: 4, first_line: 'y' },
  ]
  const ALLOWED = ['Kovács weboldal', 'Ajánlat', 'Árajánlat egy ügyfélnek.', 'Levél', 'Hivatalos levél.']

  function open(h: ReturnType<typeof workbenchHarness>, list: unknown, use?: (body: any) => { status: number; body: unknown }) {
    h.respond((url, init) => {
      if (url.includes('/api/workbench/templates/use')) return use ? use(JSON.parse(String(init?.body || '{}'))) : { status: 500, body: {} }
      if (url.includes('/api/workbench/templates')) {
        if (list && typeof list === 'object' && 'status' in (list as any)) return list as any
        return { status: 200, body: { templates: list } }
      }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: { id: 'w1', title: 'Ajánlat', type: 'document' }, versions: [], parts: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  }
  const uses = (h: ReturnType<typeof workbenchHarness>) =>
    h.fetchCalls.filter((c) => c.url.includes('/api/workbench/templates/use')).map((c) => JSON.parse(String(c.init!.body)))

  it('friss projekt: a sablongombok ott vannak a lista alatt, forditott szoveggel', async () => {
    const h = workbenchHarness()
    open(h, TPL)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-tpl="offer"'))
    expect(h.html()).toContain('workbench.tpl.title')
    expect(h.html()).toContain('workbench.tpl.hint')
    expect(h.html()).toContain('workbench.empty.title')
    expect(untranslatedHungarian(h.html(), ALLOWED)).toBe('')
  })

  it('egy kattintas: elkuldi a sablont, es megnyitja az uj munkadarabot', async () => {
    const h = workbenchHarness()
    open(h, TPL, () => ({ status: 201, body: { ok: true, item: { id: 'w1', title: 'Ajánlat' }, versions: [], parts: [] } }))
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-tpl="offer"'))
    h.click({ 'data-wb-act': 'tpl-use', 'data-wb-tpl': 'offer' })
    await vi.waitFor(() => expect(h.toasts.some((t) => t.includes('workbench.tpl.created'))).toBe(true))
    expect(uses(h)).toEqual([{ project_id: 'p1', template: 'offer' }])
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/w1'))).toBe(true))
  })

  it('betoltesi hiba: a szerver mondata + ujraproba, NEM a "nincs sablon"', async () => {
    const h = workbenchHarness()
    open(h, { status: 500, body: { error: 'x', message: 'Belső hiba' } })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.tpl.load_failed'))
    expect(h.html()).toContain('Belső hiba')
    expect(h.html()).toContain('data-wb-act="tpl-retry"')
    expect(h.html()).not.toContain('workbench.tpl.none')
  })

  it('letrehozasi hiba: a szerver mondata toastban, nem nyit semmit', async () => {
    const h = workbenchHarness()
    open(h, TPL, () => ({ status: 404, body: { error: 'template_not_found', message: 'Ilyen sablon nincs.' } }))
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-tpl="offer"'))
    h.click({ 'data-wb-act': 'tpl-use', 'data-wb-tpl': 'offer' })
    await vi.waitFor(() => expect(h.toasts).toContain('Ilyen sablon nincs.'))
    expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/'))).toBe(false)
  })
})
