// #406, otlet 21bcb1f4 -- KITUZOTT MUNKADARABOK: csillaggal a lista tetejere,
// a kituzes nem szerkesztes (updated_at marad), vegpont, felulet.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import { createWorkItem, listWorkItems, setWorkItemPinned, getWorkItem } from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

let pid = ''
const ids: Record<string, string> = {}

function setup() {
  initDatabase(':memory:')
  const p = createProject({ name: 'Kovács weboldal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  // Harom munkadarab, jol elvalo updated_at-tel: C a legfrissebb.
  let t = 1_000
  for (const name of ['A', 'B', 'C']) {
    const it = createWorkItem({ project_id: pid, title: name, type: 'document' })
    if (!it.ok) throw new Error('munkadarab')
    ids[name] = it.item.id
    getDb().prepare('UPDATE work_items SET updated_at = ?, created_at = ? WHERE id = ?').run(t, t, it.item.id)
    t += 1_000
  }
}
const order = () => listWorkItems(pid).map((i) => i.title).join('')

describe('kituzes: sorrend', () => {
  beforeEach(setup)

  it('kituzes nelkul a legutobb valtozott elol', () => {
    expect(order()).toBe('CBA')
  })

  it('a kituzott a lista tetejen, a legutobb kituzott legelol', () => {
    setWorkItemPinned(ids.A, true, 5_000)
    expect(order()).toBe('ACB')
    setWorkItemPinned(ids.B, true, 6_000)
    expect(order()).toBe('BAC')
  })

  it('szerkesztes nem ugraltatja a kituzotteket', () => {
    setWorkItemPinned(ids.A, true, 5_000)
    setWorkItemPinned(ids.B, true, 6_000)
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(99_000, ids.A)
    expect(order()).toBe('BAC')
  })

  it('a csillag nem szerkesztes: updated_at nem valtozik, es levetel utan a helyere kerul', () => {
    const before = getWorkItem(ids.A)!.updated_at
    setWorkItemPinned(ids.A, true, 5_000)
    expect(getWorkItem(ids.A)!.updated_at).toBe(before)
    setWorkItemPinned(ids.A, false)
    expect(getWorkItem(ids.A)!.updated_at).toBe(before)
    expect(getWorkItem(ids.A)!.pinned_at).toBeNull()
    expect(order()).toBe('CBA')
  })

  it('ismetelt kituzes megtartja az eredeti idopontot (stabil sorrend)', () => {
    setWorkItemPinned(ids.A, true, 5_000)
    setWorkItemPinned(ids.A, true, 9_000)
    expect(getWorkItem(ids.A)!.pinned_at).toBe(5_000)
  })

  it('ismeretlen munkadarab: undefined, nem dob', () => {
    expect(setWorkItemPinned('nincs-ilyen', true)).toBeUndefined()
  })
})

describe('kituzes: vegpont', () => {
  beforeEach(setup)

  it('kituz, a friss listat adja vissza, levesz', async () => {
    const r = await callWorkbench(`/api/workbench/items/${ids.A}/pin`, 'POST', { pinned: true })
    expect(r.status).toBe(200)
    const body = r.body as { item: { pinned_at: number | null }; items: { title: string }[] }
    expect(body.item.pinned_at).not.toBeNull()
    expect(body.items.map((i) => i.title).join('')).toBe('ACB')
    const off = await callWorkbench(`/api/workbench/items/${ids.A}/pin`, 'POST', { pinned: false })
    expect((off.body as { items: { title: string }[] }).items.map((i) => i.title).join('')).toBe('CBA')
  })

  it('hibas ertek: 400 emberi mondattal', async () => {
    const r = await callWorkbench(`/api/workbench/items/${ids.A}/pin`, 'POST', { pinned: 'igen' })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'pin_bad_value' })
    expect(typeof (r.body as { message: string }).message).toBe('string')
  })

  it('archivalt projektben nem modosithato', async () => {
    setProjectArchived(pid, true)
    const r = await callWorkbench(`/api/workbench/items/${ids.A}/pin`, 'POST', { pinned: true })
    expect(r.status).toBe(409)
    expect(getWorkItem(ids.A)!.pinned_at).toBeNull()
  })

  it('ismeretlen munkadarab: 404', async () => {
    const r = await callWorkbench('/api/workbench/items/nincs-ilyen/pin', 'POST', { pinned: true })
    expect(r.status).toBe(404)
  })
})

describe('kituzes: a felulet', () => {
  const item = (id: string, title: string, pinned_at: number | null) => ({
    id, project_id: 'p1', type: 'document', title, status: 'draft', source_path: null, editor_type: 'text',
    current_version_id: null, created_at: 1, updated_at: 1, created_by: null, pinned_at,
  })

  function open(pinResponse: { status: number; body: unknown }) {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/pin')) return pinResponse
      if (url.includes('/api/workbench/items?')) return { status: 200, body: itemsBody([item('w1', 'Ajánlat', null), item('w2', 'Logó', 5)]) }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos: [] } }
      return { status: 200, body: {} }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    return h
  }

  it('csillag minden soron, a kituzott lenyomva; forditva', async () => {
    const h = open({ status: 200, body: {} })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="item-pin"'))
    const html = h.html()
    expect(html).toMatch(/data-wb-pin="w1" aria-pressed="false"/)
    expect(html).toMatch(/data-wb-pin="w2" aria-pressed="true"/)
    expect(html).toContain('workbench.pin.add')
    expect(html).toContain('workbench.pin.remove')
    // A csillag nem a munkadarab-gomb belsejeben van (gombba gomb nem agyazhato).
    const rows = html.match(/<li class="wb-item-row[^"]*">[^]*?<\/li>/g) || []
    expect(rows.length).toBe(2)
    for (const row of rows) expect(row).toMatch(/^<li[^>]*><button[^>]*data-wb-act="item-pin"[^>]*>[^<]*<\/button><button[^>]*data-wb-item=/)
    expect(untranslatedHungarian(html, ['Kovács weboldal', 'Ajánlat', 'Logó'])).toBe('')
  })

  it('kattintas: POST a jo ertekkel, a szerver listaja kerul ki', async () => {
    const h = open({ status: 200, body: { item: item('w1', 'Ajánlat', 9), items: [item('w1', 'Ajánlat', 9), item('w2', 'Logó', 5)] } })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-pin="w1"'))
    h.click({ 'data-wb-act': 'item-pin', 'data-wb-pin': 'w1' })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.pin.added⟧'))
    const call = h.fetchCalls.find((c) => c.url.includes('/api/workbench/items/w1/pin'))
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ pinned: true })
    expect(h.html()).toMatch(/data-wb-pin="w1" aria-pressed="true"/)
    // A csillag nem nyitotta meg a munkadarabot.
    expect(h.fetchCalls.some((c) => /\/api\/workbench\/items\/w1(\?|$)/.test(c.url))).toBe(false)
  })

  it('hiba: a szerver mondata a toastban, a lista valtozatlan', async () => {
    const h = open({ status: 409, body: { error: 'project_archived', message: 'Archivalt projekt' } })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-pin="w1"'))
    h.click({ 'data-wb-act': 'item-pin', 'data-wb-pin': 'w1' })
    await vi.waitFor(() => expect(h.toasts).toContain('Archivalt projekt'))
    expect(h.html()).toMatch(/data-wb-pin="w1" aria-pressed="false"/)
  })
})
