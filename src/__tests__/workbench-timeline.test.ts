// #406, 7. pont -- PROJEKT-IDOVONAL a Munkapadon: a szerver merese (mert adat)
// ES a felulet (mit lat a felhasznalo).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { initDatabase, createKanbanCard, createApproval, resolveApproval, moveKanbanCard, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, createWorkItemVersion, restoreWorkItemVersion, addWorkItemPart } from '../workbench.js'
import { buildProjectTimeline, TIMELINE_MAX_LIMIT, clampTimelineLimit } from '../workbench-timeline.js'
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

/** Minden sor idobelyeget a megadott ertekre allit (a tesztek egy masodperc
 *  alatt futnak le -- a sorrendet igy tudjuk merni). */
function stamp(table: string, where: string, at: number, ...args: unknown[]) {
  getDb().prepare(`UPDATE ${table} SET created_at = ? WHERE ${where}`).run(at, ...args)
}

describe('idovonal: a szerver merese', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const a = createProject({ name: 'Kovács weboldal' })
    const b = createProject({ name: 'Másik' })
    if (!a.ok || !b.ok) throw new Error('projekt')
    pid = a.project.id
    other = b.project.id
  })

  it('FRISS projekt: ures lista, nincs hiba, nincs tobb', () => {
    const tl = buildProjectTimeline(pid)
    expect(tl.events).toEqual([])
    expect(tl.errors).toEqual([])
    expect(tl.more).toBe(false)
    expect(tl.next_before).toBeNull()
  })

  it('munkadarab, verzio, visszaallitas, kep -- a legfrissebb elol, a v1 nem duplikalt', () => {
    const w = item('Ajánlat')
    stamp('work_items', 'id = ?', 100, w.id)
    stamp('work_item_versions', 'work_item_id = ?', 100, w.id)
    const v2 = createWorkItemVersion(w.id)
    if (!v2.ok) throw new Error('v2')
    stamp('work_item_versions', 'id = ?', 200, v2.version.id)
    const first = getDb().prepare('SELECT id FROM work_item_versions WHERE work_item_id = ? AND version_no = 1').get(w.id) as { id: string }
    const r = restoreWorkItemVersion(first.id)
    if (!r.ok) throw new Error('restore')
    stamp('work_item_versions', 'id = ?', 300, r.version.id)
    addWorkItemPart({ work_item_id: w.id, kind: 'image', asset_path: 'Projektek/kovacs/logo.png' })
    stamp('work_item_parts', "kind = 'image'", 400)

    const tl = buildProjectTimeline(pid)
    expect(tl.events.map((e) => e.kind)).toEqual(['file_added', 'version_restored', 'version', 'item_created'])
    expect(tl.events[0].file_name).toBe('logo.png')
    expect(tl.events[1].version_no).toBe(3)
    expect(tl.events[1].from_version_no).toBe(1)
    expect(tl.events[2].version_no).toBe(2)
    expect(tl.events.every((e) => e.item_id === w.id && e.item_title === 'Ajánlat')).toBe(true)
  })

  it('egy kep egyszer kerult fel: az uj verzio masolata nem uj esemeny', () => {
    const w = item('Poszt')
    addWorkItemPart({ work_item_id: w.id, kind: 'image', asset_path: 'P/foto.jpg' })
    createWorkItemVersion(w.id)
    createWorkItemVersion(w.id)
    const files = buildProjectTimeline(pid).events.filter((e) => e.kind === 'file_added')
    expect(files).toHaveLength(1)
  })

  it('kartya: letrejott es lezarva; jovahagyas: kerve es elfogadva/visszadobva -- a masik projekte nem', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'Projekt kártya', project: pid, status: 'waiting' })
    createKanbanCard({ id: 'bbbb2222', title: 'Idegen kártya', project: other })
    moveKanbanCard('aaaa1111', 'done', 0, 'teszt')
    createApproval({ id: 'ap1', agent_id: 'main', category: 'workbench_file_write', action_description: 'Fájl írása: logo.png', action_payload: JSON.stringify({ source: 'workbench', project: pid }) })
    createApproval({ id: 'ap2', agent_id: 'main', category: 'kanban_done', action_description: 'Kész', action_payload: JSON.stringify({ kanban_card_id: 'aaaa1111' }) })
    createApproval({ id: 'ap3', agent_id: 'main', category: 'kanban_done', action_description: 'Idegen', action_payload: JSON.stringify({ kanban_card_id: 'bbbb2222' }) })
    createApproval({ id: 'ap4', agent_id: 'main', category: 'workbench_file_write', action_description: 'Idegen fájl', action_payload: JSON.stringify({ source: 'workbench', project: other }) })
    resolveApproval('ap1', 'approved', 'teszt')
    resolveApproval('ap2', 'rejected', 'teszt')

    const tl = buildProjectTimeline(pid)
    const kinds = tl.events.map((e) => e.kind).sort()
    expect(kinds).toEqual([
      'approval_approved', 'approval_rejected', 'approval_requested', 'approval_requested', 'card_created', 'card_done',
    ])
    expect(tl.events.some((e) => e.approval_id === 'ap3' || e.approval_id === 'ap4')).toBe(false)
    const done = tl.events.find((e) => e.kind === 'card_done')!
    expect(done.card_title).toBe('Projekt kártya')
    expect(typeof done.card_seq).toBe('number')
    const rej = tl.events.find((e) => e.kind === 'approval_rejected')!
    expect(rej.card_id).toBe('aaaa1111')
  })

  it('azonos masodpercben a kovetkezmeny a kiindulas ELE kerul', () => {
    createApproval({ id: 'ap1', agent_id: 'main', category: 'x', action_description: 'Egy', action_payload: JSON.stringify({ project: pid }) })
    resolveApproval('ap1', 'approved', 'teszt')
    getDb().prepare('UPDATE approvals SET requested_at = 500, resolved_at = 500').run()
    expect(buildProjectTimeline(pid).events.map((e) => e.kind)).toEqual(['approval_approved', 'approval_requested'])
  })

  it('lapozas: `before` a regebbieket adja, egy masodpercet nem vag ketté, semmi nem vesz el', () => {
    for (let i = 0; i < 7; i++) {
      const w = item('W' + i)
      stamp('work_items', 'id = ?', 1000 + i, w.id)
    }
    // Ket munkadarab UGYANABBAN a masodpercben, pont a lap szelen.
    const a = item('Twin A')
    const b = item('Twin B')
    stamp('work_items', 'id IN (?, ?)', 1003, a.id, b.id)

    const seen: string[] = []
    let before: number | null = null
    for (let guard = 0; guard < 10; guard++) {
      const page = buildProjectTimeline(pid, { limit: 3, before })
      seen.push(...page.events.map((e) => e.item_title!))
      if (!page.more) break
      expect(page.next_before).not.toBeNull()
      before = page.next_before
    }
    expect(seen.sort()).toEqual(['Twin A', 'Twin B', 'W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6'])
  })

  it('egy olvashatatlan forras NEM nulla: a neve bekerul az errors-ba, a tobbi latszik', () => {
    item('Ajánlat')
    getDb().exec('DROP TABLE kanban_card_events')
    getDb().exec('ALTER TABLE kanban_cards RENAME TO kanban_cards_x')
    getDb().exec("CREATE TABLE kanban_cards (id TEXT)")
    const tl = buildProjectTimeline(pid)
    expect(tl.errors.map((e) => e.source)).toEqual(['cards'])
    expect(tl.events.map((e) => e.kind)).toEqual(['item_created'])
  })

  it('a limit korlatos', () => {
    expect(clampTimelineLimit('abc')).toBe(50)
    expect(clampTimelineLimit(-1)).toBe(50)
    expect(clampTimelineLimit(99999)).toBe(TIMELINE_MAX_LIMIT)
  })

  it('a vegpont: 400 projekt nelkul, 404 ismeretlen projektre (emberi mondattal), kulonben az idovonal', async () => {
    expect((await get('/api/workbench/timeline')).status).toBe(400)
    const miss = await get('/api/workbench/timeline?project=nincs&lang=en')
    expect(miss.status).toBe(404)
    expect(miss.body.message).toMatch(/not found/i)
    item('Ajánlat')
    const ok = await get(`/api/workbench/timeline?project=${pid}&limit=5`)
    expect(ok.status).toBe(200)
    expect(ok.body.timeline.events).toHaveLength(1)
    expect(ok.body.timeline.errors).toEqual([])
  })
})

describe('idovonal: a felulet', () => {
  const EV = (kind: string, at: number, extra: Record<string, unknown> = {}) => ({
    kind, at, item_id: null, item_title: null, version_no: null, from_version_no: null, file_name: null,
    card_id: null, card_seq: null, card_title: null, approval_id: null, approval_description: null, ...extra,
  })

  function open(h: ReturnType<typeof workbenchHarness>, pages: unknown[] | { status: number; body: unknown }) {
    let n = 0
    h.respond((url) => {
      if (url.includes('/api/workbench/timeline')) {
        if (!Array.isArray(pages)) return pages
        return { status: 200, body: { timeline: pages[Math.min(n++, pages.length - 1)] } }
      }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: { id: 'w1', title: 'Ajánlat', type: 'note', status: 'draft' }, versions: [], parts: [] } }
      return { status: 200, body: itemsBody([{ id: 'w1', title: 'Ajánlat', type: 'note', status: 'draft' }]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'tl-open' })
  }

  it('a fejlec gombja nyitja; a sorok ket nyelvu kulcsbol, a munkadarab sora kattinthato', async () => {
    const h = workbenchHarness()
    open(h, [{ events: [
      EV('version', 200, { item_id: 'w1', item_title: 'Ajánlat', version_no: 2 }),
      EV('card_done', 100, { card_seq: 12, card_title: 'Logó' }),
    ], more: false, next_before: null, errors: [] }])
    await vi.waitFor(() => expect(h.html()).toContain('wb-tl-row'))
    const html = h.html()
    expect(html).toContain('workbench.tl.title')
    expect(html).toContain('workbench.tl.kind.version')
    expect(html).toContain('data-wb-item="w1"')
    expect(html).toContain('"card":"#12"')
    expect(html).not.toContain('workbench.tl.more')
    expect(untranslatedHungarian(html, ['Kovács weboldal', 'Ajánlat', 'Logó'])).toBe('')
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/w1'))).toBe(true))
  })

  it('ures projekt: mondat, nem ures doboz', async () => {
    const h = workbenchHarness()
    open(h, [{ events: [], more: false, next_before: null, errors: [] }])
    await vi.waitFor(() => expect(h.html()).toContain('workbench.tl.empty'))
  })

  it('"Regebbiek": a before-t kuldi, es a regi sorok ALA fuz', async () => {
    const h = workbenchHarness()
    open(h, [
      { events: [EV('item_created', 300, { item_id: 'w1', item_title: 'Első' })], more: true, next_before: 300, errors: [] },
      { events: [EV('item_created', 100, { item_id: 'w1', item_title: 'Második' })], more: false, next_before: null, errors: [] },
    ])
    await vi.waitFor(() => expect(h.html()).toContain('workbench.tl.more'))
    h.click({ 'data-wb-act': 'tl-more' })
    await vi.waitFor(() => expect(h.html()).toContain('Második'))
    const html = h.html()
    expect(html.indexOf('Első')).toBeLessThan(html.indexOf('Második'))
    expect(h.fetchCalls.some((c) => c.url.includes('before=300'))).toBe(true)
    expect(html).not.toContain('workbench.tl.more')
  })

  it('olvashatatlan forras: kimondja, melyikbol nem latszik semmi', async () => {
    const h = workbenchHarness()
    open(h, [{ events: [], more: false, next_before: null, errors: [{ source: 'cards', detail: 'x' }] }])
    await vi.waitFor(() => expect(h.html()).toContain('workbench.tl.partial'))
    expect(h.html()).toContain('workbench.tl.source.cards')
  })

  it('szerverhiba: a szerver mondata latszik, nem "ures"', async () => {
    const h = workbenchHarness()
    open(h, { status: 500, body: { error: 'x', message: 'Belső hiba' } })
    await vi.waitFor(() => expect(h.html()).toContain('Belső hiba'))
    expect(h.html()).not.toContain('workbench.tl.empty')
  })
})
