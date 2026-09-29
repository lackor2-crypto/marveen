// #443 -- MUNKADARAB TORLESE: lomtarba kerul (eltunik a listabol, visszaallithato),
// a verziok megmaradnak, nincs megerosito ablak.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import {
  createWorkItem, listWorkItems, listDeletedWorkItems, setWorkItemDeleted, getWorkItem,
  countWorkItems, createWorkItemVersion, purgeWorkItem, listWorkItemVersions, deleteWorkItemVersion, listWorkItemParts, addWorkItemPart,
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

describe('verzio vegleges torlese', () => {
  beforeEach(setup)

  function twoVersions() {
    const p = addWorkItemPart({ work_item_id: ids.A, kind: 'text', text: 'elso' })
    if (!p.ok) throw new Error('resz')
    const v1 = createWorkItemVersion(ids.A, {})
    const v2 = createWorkItemVersion(ids.A, {})
    if (!v1.ok || !v2.ok) throw new Error('verzio')
    return { v1: v1.version, v2: v2.version }
  }

  it('a regi verzio es a reszei torlodnek, a jelenlegi es a munkapeldany marad', () => {
    const { v1, v2 } = twoVersions()
    const working = listWorkItemParts(ids.A).length
    expect(listWorkItemParts(ids.A, v1.id).length).toBeGreaterThan(0)
    const r = deleteWorkItemVersion(v1.id, ids.A)
    expect(r.ok).toBe(true)
    expect(listWorkItemVersions(ids.A).map((v) => v.id)).not.toContain(v1.id)
    expect(listWorkItemVersions(ids.A).map((v) => v.id)).toContain(v2.id)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM work_item_parts WHERE version_id = ?').get(v1.id)).toEqual({ n: 0 })
    expect(listWorkItemParts(ids.A).length).toBe(working)
    expect(getWorkItem(ids.A)!.current_version_id).toBe(v2.id)
  })

  it('a jelenlegi verzio is torolheto: az alatta levo toltodik be (Boss, 2026-09-29)', () => {
    const { v1, v2 } = twoVersions()
    const v1Parts = listWorkItemParts(ids.A, v1.id).map((p) => p.text)
    const r = deleteWorkItemVersion(v2.id, ids.A)
    if (!r.ok) throw new Error(r.code)
    expect(r.loaded?.id).toBe(v1.id)
    expect(listWorkItemVersions(ids.A).map((v) => v.id)).not.toContain(v2.id)
    const item = getWorkItem(ids.A)!
    expect(item.current_version_id).toBe(v1.id)
    expect(item.source_path).toBe(v1.source_path)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM work_item_parts WHERE version_id = ?').get(v2.id)).toEqual({ n: 0 })
    // Az elo reszek most v1 reszei (plusz a verziozas elotti, ha van).
    const live = listWorkItemParts(ids.A)
    expect(live.filter((p) => p.version_id === v1.id).map((p) => p.text)).toEqual(v1Parts)
    expect(live.some((p) => p.version_id === v2.id)).toBe(false)
  })

  it('az egyetlen verzio nem torolheto: version_last, nem torol', () => {
    let vs = listWorkItemVersions(ids.A)
    while (vs.length > 1) {
      const cur = getWorkItem(ids.A)!.current_version_id!
      const r = deleteWorkItemVersion(cur, ids.A)
      if (!r.ok) throw new Error(r.code)
      vs = listWorkItemVersions(ids.A)
    }
    expect(vs.length).toBe(1)
    expect(deleteWorkItemVersion(vs[0].id, ids.A)).toEqual({ ok: false, code: 'version_last' })
    expect(listWorkItemVersions(ids.A).length).toBe(1)
    expect(getWorkItem(ids.A)!.current_version_id).toBe(vs[0].id)
  })

  it('mas munkadarab verzioja: version_mismatch, nem torol', () => {
    const { v1 } = twoVersions()
    const n = listWorkItemVersions(ids.A).length
    expect(deleteWorkItemVersion(v1.id, ids.B)).toEqual({ ok: false, code: 'version_mismatch' })
    expect(listWorkItemVersions(ids.A).length).toBe(n)
  })

  it('vegpont: DELETE torol, a jelenlegit is (loaded + parts), az utolsora 409 emberi mondattal, ismeretlenre 404', async () => {
    const { v1, v2 } = twoVersions()
    const ok = await callWorkbench(`/api/workbench/items/${ids.A}/versions/${v1.id}`, 'DELETE')
    expect(ok.status).toBe(200)
    expect((ok.body as { versions: { id: string }[] }).versions.map((v) => v.id)).not.toContain(v1.id)
    expect(ok.body).toMatchObject({ loaded: null })
    const cur = await callWorkbench(`/api/workbench/items/${ids.A}/versions/${v2.id}`, 'DELETE')
    expect(cur.status).toBe(200)
    const body = cur.body as { loaded: { id: string }; item: { current_version_id: string }; parts: unknown[] }
    expect(body.loaded.id).toBe(body.item.current_version_id)
    expect(Array.isArray(body.parts)).toBe(true)
    const last = await callWorkbench(`/api/workbench/items/${ids.A}/versions/${body.item.current_version_id}`, 'DELETE')
    expect(last.status).toBe(409)
    expect(last.body).toMatchObject({ error: 'version_last' })
    expect(typeof (last.body as { message: string }).message).toBe('string')
    const gone = await callWorkbench(`/api/workbench/items/${ids.A}/versions/${v1.id}`, 'DELETE')
    expect(gone.status).toBe(404)
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

  it('Lomtar: Vegleges torles piros kerettel, Megse nem kuld semmit, megerositesre POST /purge', async () => {
    const h = open({ status: 200, body: { item: item('w1', 'Ajánlat'), items: [item('w2', 'Logó')], deleted: [item('w1', 'Ajánlat')] } })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-id="w1"'))
    h.click({ 'data-wb-act': 'item-trash', 'data-wb-id': 'w1' })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.trash.done⟧'))
    h.click({ 'data-wb-act': 'trash-toggle' })
    expect(h.html()).toMatch(/data-wb-act="item-purge-ask"[^>]*data-wb-id="w1"/)
    const before = h.fetchCalls.length
    h.click({ 'data-wb-act': 'item-purge-ask', 'data-wb-id': 'w1' })
    expect(h.html()).toContain('wb-warn-box')
    h.click({ 'data-wb-act': 'warn-cancel' })
    expect(h.html()).not.toContain('wb-warn-box')
    expect(h.fetchCalls.length).toBe(before)
    h.click({ 'data-wb-act': 'item-purge-ask', 'data-wb-id': 'w1' })
    h.respond(() => ({ status: 200, body: { ok: true, items: [item('w2', 'Logó')], deleted: [] } }))
    h.click({ 'data-wb-act': 'item-purge', 'data-wb-id': 'w1' })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.trash.purged⟧'))
    expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/w1/purge'))).toBe(true)
    expect(h.html()).not.toContain('data-wb-act="trash-toggle"')
  })

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

// Boss, 2026-09-29, "1A": a Lomtarbol veglegesen torolheto -- es szemet nem marad.
describe('lomtar: vegleges torles', () => {
  beforeEach(setup)

  it('csak lomtarban levo darab torolheto veglegesen', () => {
    expect(purgeWorkItem(ids.A)).toEqual({ ok: false, code: 'not_in_trash' })
    expect(getWorkItem(ids.A)).toBeTruthy()
    expect(purgeWorkItem('nincs-ilyen')).toEqual({ ok: false, code: 'item_not_found' })
  })

  it('minden sora megy (verzio, resz, beszelgetes, uzenet), a tobbi munkadarabe marad', async () => {
    const { openSessionForWorkItem, addAgentMessage, ensureAgentTables } = await import('../workbench-agent/sessions.js')
    ensureAgentTables()
    for (const k of ['A', 'B']) {
      expect(createWorkItemVersion(ids[k], {}).ok).toBe(true)
      expect(addWorkItemPart({ work_item_id: ids[k], kind: 'text', text: 'x' }).ok).toBe(true)
      addAgentMessage(openSessionForWorkItem(pid, ids[k], 'hu').id, 'user', 'szia')
    }
    const count = (sql: string, id: string): number => (getDb().prepare(sql).get(id) as { n: number }).n
    const msgs = (id: string) => count('SELECT COUNT(*) AS n FROM workbench_agent_messages WHERE session_id IN (SELECT id FROM workbench_agent_sessions WHERE work_item_id = ?)', id)
    expect(msgs(ids.A)).toBeGreaterThan(0)
    setWorkItemDeleted(ids.A, true)
    expect(purgeWorkItem(ids.A)).toEqual({ ok: true, projectId: pid })
    expect(getWorkItem(ids.A)).toBeUndefined()
    expect(listDeletedWorkItems(pid)).toEqual([])
    expect(count('SELECT COUNT(*) AS n FROM work_item_versions WHERE work_item_id = ?', ids.A)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM work_item_parts WHERE work_item_id = ?', ids.A)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM workbench_agent_sessions WHERE work_item_id = ?', ids.A)).toBe(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM workbench_agent_messages m WHERE NOT EXISTS (SELECT 1 FROM workbench_agent_sessions s WHERE s.id = m.session_id)').get()).toEqual({ n: 0 })
    // B erintetlen.
    expect(listWorkItemVersions(ids.B).length).toBeGreaterThan(0)
    expect(listWorkItemParts(ids.B).length).toBeGreaterThan(0)
    expect(msgs(ids.B)).toBeGreaterThan(0)
  })

  it('vegpont: lomtaron kivul 409 emberi mondattal, lomtarbol torol es friss listakat ad', async () => {
    const no = await callWorkbench(`/api/workbench/items/${ids.A}/purge`, 'POST', {})
    expect(no.status).toBe(409)
    expect(no.body).toMatchObject({ error: 'not_in_trash' })
    expect((no.body as { message: string }).message).toContain('Lomtár')
    await callWorkbench(`/api/workbench/items/${ids.A}/trash`, 'POST', { deleted: true })
    const r = await callWorkbench(`/api/workbench/items/${ids.A}/purge`, 'POST', {})
    expect(r.status).toBe(200)
    const body = r.body as { items: { title: string }[]; deleted: unknown[] }
    expect(body.items.map((i) => i.title).join('')).toBe('CB')
    expect(body.deleted).toEqual([])
  })
})
