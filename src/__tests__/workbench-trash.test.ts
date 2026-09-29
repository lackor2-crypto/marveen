// #443 -- MUNKADARAB TORLESE: lomtarba kerul (eltunik a listabol, visszaallithato),
// a verziok megmaradnak, nincs megerosito ablak.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import {
  createWorkItem, listWorkItems, listDeletedWorkItems, setWorkItemDeleted, getWorkItem,
  countWorkItems, createWorkItemVersion, listWorkItemVersions,
} from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

let pid = ''
const ids: Record<string, string> = {}

function setup() {
  initDatabase(':memory:')
  const p = createProject({ name: 'Kovács weboldal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
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

describe('lomtar: adat', () => {
  beforeEach(setup)

  it('a torolt eltunik a listabol es a szamlalobol, a lomtarban megjelenik', () => {
    setWorkItemDeleted(ids.B, true, 7_000)
    expect(order()).toBe('CA')
    expect(countWorkItems(pid)).toBe(2)
    expect(listDeletedWorkItems(pid).map((i) => i.title)).toEqual(['B'])
  })

  it('visszaallitas: a regi helyere kerul, updated_at valtozatlan', () => {
    const before = getWorkItem(ids.B)!.updated_at
    setWorkItemDeleted(ids.B, true, 7_000)
    setWorkItemDeleted(ids.B, false)
    expect(order()).toBe('CBA')
    expect(getWorkItem(ids.B)!.updated_at).toBe(before)
    expect(getWorkItem(ids.B)!.deleted_at).toBeNull()
    expect(listDeletedWorkItems(pid)).toEqual([])
  })

  it('a verziok megmaradnak torles es visszaallitas utan is', () => {
    const v = createWorkItemVersion(ids.A, {})
    expect(v.ok).toBe(true)
    const n = listWorkItemVersions(ids.A).length
    setWorkItemDeleted(ids.A, true)
    expect(listWorkItemVersions(ids.A).length).toBe(n)
    setWorkItemDeleted(ids.A, false)
    expect(listWorkItemVersions(ids.A).length).toBe(n)
  })

  it('a lomtar a legutobb torolttel kezdodik; ismetelt torles nem mozdit', () => {
    setWorkItemDeleted(ids.A, true, 5_000)
    setWorkItemDeleted(ids.C, true, 6_000)
    setWorkItemDeleted(ids.A, true, 9_000)
    expect(listDeletedWorkItems(pid).map((i) => i.title)).toEqual(['C', 'A'])
  })

  it('ismeretlen munkadarab: undefined, nem dob', () => {
    expect(setWorkItemDeleted('nincs-ilyen', true)).toBeUndefined()
  })
})

describe('lomtar: vegpont', () => {
  beforeEach(setup)

  it('torol, mindket friss listat visszaadja, visszaallit', async () => {
    const r = await callWorkbench(`/api/workbench/items/${ids.A}/trash`, 'POST', { deleted: true })
    expect(r.status).toBe(200)
    const body = r.body as { items: { title: string }[]; deleted: { title: string }[] }
    expect(body.items.map((i) => i.title).join('')).toBe('CB')
    expect(body.deleted.map((i) => i.title)).toEqual(['A'])
    const list = await callWorkbench(`/api/workbench/items?project=${pid}`, 'GET')
    expect((list.body as { deleted: { title: string }[] }).deleted.map((i) => i.title)).toEqual(['A'])
    const back = await callWorkbench(`/api/workbench/items/${ids.A}/trash`, 'POST', { deleted: false })
    expect((back.body as { items: { title: string }[] }).items.map((i) => i.title).join('')).toBe('CBA')
  })

  it('hibas ertek: 400 emberi mondattal', async () => {
    const r = await callWorkbench(`/api/workbench/items/${ids.A}/trash`, 'POST', { deleted: 'igen' })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'trash_bad_value' })
    expect(typeof (r.body as { message: string }).message).toBe('string')
  })

  it('archivalt projektben nem torolheto', async () => {
    setProjectArchived(pid, true)
    const r = await callWorkbench(`/api/workbench/items/${ids.A}/trash`, 'POST', { deleted: true })
    expect(r.status).toBe(409)
    expect(getWorkItem(ids.A)!.deleted_at).toBeNull()
  })
})

describe('lomtar: a felulet', () => {
  const item = (id: string, title: string) => ({
    id, project_id: 'p1', type: 'document', title, status: 'draft', source_path: null, editor_type: 'text',
    current_version_id: null, created_at: 1, updated_at: 1, created_by: null, pinned_at: null,
  })

  function open(trashResponse: { status: number; body: unknown }) {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/trash')) return trashResponse
      if (url.includes('/api/workbench/items?')) return { status: 200, body: itemsBody([item('w1', 'Ajánlat'), item('w2', 'Logó')]) }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos: [] } }
      return { status: 200, body: {} }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    return h
  }

  it('Torles gomb minden sor vegen, forditva', async () => {
    const h = open({ status: 200, body: {} })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="item-trash"'))
    const html = h.html()
    const rows = html.match(/<li class="wb-item-row[^"]*">[^]*?<\/li>/g) || []
    expect(rows.length).toBe(2)
    for (const row of rows) expect(row).toMatch(/data-wb-act="item-trash"[^>]*>[^<]*<\/button><\/li>$/)
    expect(untranslatedHungarian(html, ['Kovács weboldal', 'Ajánlat', 'Logó'])).toBe('')
  })

  it('kattintas: rakerdezes nelkul POST, eltunik, a Lomtarbol visszaallithato', async () => {
    const h = open({ status: 200, body: { item: item('w1', 'Ajánlat'), items: [item('w2', 'Logó')], deleted: [item('w1', 'Ajánlat')] } })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-id="w1"'))
    h.click({ 'data-wb-act': 'item-trash', 'data-wb-id': 'w1' })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.trash.done⟧'))
    const call = h.fetchCalls.find((c) => c.url.includes('/api/workbench/items/w1/trash'))
    expect(JSON.parse(String(call?.init?.body))).toEqual({ deleted: true })
    expect(h.html()).not.toContain('data-wb-item="w1"')
    expect(h.html()).toContain('data-wb-act="trash-toggle"')
    h.click({ 'data-wb-act': 'trash-toggle' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="item-restore"'))
  })

  it('hiba: a szerver mondata a toastban, a lista valtozatlan', async () => {
    const h = open({ status: 409, body: { error: 'project_archived', message: 'Archivalt projekt' } })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-id="w1"'))
    h.click({ 'data-wb-act': 'item-trash', 'data-wb-id': 'w1' })
    await vi.waitFor(() => expect(h.toasts).toContain('Archivalt projekt'))
    expect(h.html()).toContain('data-wb-item="w1"')
  })
})
