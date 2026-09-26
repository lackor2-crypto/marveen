// #406, 14. pont -- KIS TEENDOK HATARIDOVEL: tarolas, naptarfajl, vegpontok,
// agens-eszkoz ES a felulet.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import {
  addTodo, updateTodo, deleteTodo, listItemTodos, listProjectTodos, cleanDueDate,
  todosToIcs, resolveAgentDue, TODOS_PER_ITEM_MAX, TODO_TEXT_MAX,
} from '../workbench-todos.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

let pid = ''
let itemId = ''

function setup() {
  initDatabase(':memory:')
  const p = createProject({ name: 'Kovács weboldal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  const it = createWorkItem({ project_id: pid, title: 'Ajánlat', type: 'document' })
  if (!it.ok) throw new Error('munkadarab')
  itemId = it.item.id
}

describe('teendok: tarolas', () => {
  beforeEach(setup)

  it('hatarido ellenorzese: letezo naptari nap vagy semmi', () => {
    expect(cleanDueDate('2026-10-02')).toEqual({ ok: true, due: '2026-10-02' })
    expect(cleanDueDate('')).toEqual({ ok: true, due: null })
    expect(cleanDueDate(null)).toEqual({ ok: true, due: null })
    expect(cleanDueDate('2026-02-30').ok).toBe(false)
    expect(cleanDueDate('pentek').ok).toBe(false)
  })

  it('friss projekt: ures lista, nem hiba', () => {
    expect(listProjectTodos(pid)).toEqual([])
    expect(listItemTodos(itemId)).toEqual([])
  })

  it('felvetel, kipipalas, visszaallitas, torles', () => {
    const r = addTodo({ work_item_id: itemId, text: '  Szöveget átnézni ', due_date: '2026-10-02', by: 'owner', source: 'ui' })
    if (!r.ok) throw new Error(r.code)
    expect(r.todo).toMatchObject({ text: 'Szöveget átnézni', due_date: '2026-10-02', done_at: null, project_id: pid })
    expect(listProjectTodos(pid)[0]).toMatchObject({ item_title: 'Ajánlat' })
    const d = updateTodo(r.todo.id, { done: true })
    expect(d.ok && d.todo.done_at).toBeTruthy()
    const u = updateTodo(r.todo.id, { done: false, due_date: '' })
    expect(u.ok && u.todo).toMatchObject({ done_at: null, due_date: null })
    expect(updateTodo(r.todo.id, { due_date: '2026-13-01' })).toMatchObject({ ok: false, code: 'bad_due_date' })
    expect(deleteTodo(r.todo.id)).toBe(true)
    expect(deleteTodo(r.todo.id)).toBe(false)
    expect(updateTodo(r.todo.id, { done: true })).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('hibak kulon koddal: ures, tul hosszu, rossz munkadarab, felso korlat', () => {
    expect(addTodo({ work_item_id: itemId, text: '   ', due_date: null, by: 'o', source: 'ui' })).toMatchObject({ ok: false, code: 'text_required' })
    expect(addTodo({ work_item_id: itemId, text: 'x'.repeat(TODO_TEXT_MAX + 1), due_date: null, by: 'o', source: 'ui' })).toMatchObject({ ok: false, code: 'text_too_long' })
    expect(addTodo({ work_item_id: 'nincs', text: 'a', due_date: null, by: 'o', source: 'ui' })).toMatchObject({ ok: false, code: 'item_not_found' })
    for (let i = 0; i < TODOS_PER_ITEM_MAX; i++) addTodo({ work_item_id: itemId, text: 't' + i, due_date: null, by: 'o', source: 'ui' })
    expect(addTodo({ work_item_id: itemId, text: 'egy tobb', due_date: null, by: 'o', source: 'ui' })).toMatchObject({ ok: false, code: 'too_many' })
  })
})

describe('naptarfajl (.ics)', () => {
  it('egesz napos esemeny, emlekezteto, escape, CRLF, tordeles', () => {
    const ics = todosToIcs([
      { id: 't1', text: 'Átnézni; vesszővel, és \\ jellel', due_date: '2026-10-02', item_title: 'Ajánlat' },
      { id: 't2', text: 'nincs határidő', due_date: null, item_title: 'Ajánlat' },
      { id: 't3', text: 'é'.repeat(80), due_date: '2026-12-31', item_title: 'Levél' },
    ], 'Kovács weboldal', 'hu', 1790000000)
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('DTSTART;VALUE=DATE:20261002\r\n')
    expect(ics).toContain('DTEND;VALUE=DATE:20261003\r\n')
    expect(ics).toContain('DTEND;VALUE=DATE:20270101\r\n')
    expect(ics).toContain('SUMMARY:Átnézni\\; vesszővel\\, és \\\\ jellel')
    expect(ics).toContain('TRIGGER:PT9H')
    expect(ics).not.toContain('nincs határidő')
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2)
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
    expect(todosToIcs([{ id: 'x', text: 'a', due_date: '2026-10-02', item_title: 'B' }], 'P', 'en')).toContain('Project: P')
  })
})

describe('agens hataridoje', () => {
  const FRI = new Date(2026, 8, 25, 15, 0, 0) // pentek
  it('a het napja: a legkozelebbi, a mai is; ekezet nelkul es angolul is', () => {
    expect(resolveAgentDue({ dueWeekday: 'péntek' }, FRI)).toEqual({ ok: true, due: '2026-09-25' })
    expect(resolveAgentDue({ dueWeekday: 'hetfo' }, FRI)).toEqual({ ok: true, due: '2026-09-28' })
    expect(resolveAgentDue({ dueWeekday: 'Thursday' }, FRI)).toEqual({ ok: true, due: '2026-10-01' })
    expect(resolveAgentDue({ dueWeekday: 'holnap' }, FRI).ok).toBe(false)
  })
  it('napok szama, pontos nap, vagy semmi', () => {
    expect(resolveAgentDue({ dueInDays: 7 }, FRI)).toEqual({ ok: true, due: '2026-10-02' })
    expect(resolveAgentDue({ dueInDays: -1 }, FRI).ok).toBe(false)
    expect(resolveAgentDue({ due: '2026-11-11' }, FRI)).toEqual({ ok: true, due: '2026-11-11' })
    expect(resolveAgentDue({}, FRI)).toEqual({ ok: true, due: null })
  })
  it('eszkoz: a projekten belul vesz fel, idegen munkadarabot elutasit', () => {
    setup()
    expect(getTool('workItem.addTodo')?.autonomyCategory).toBe('marveen_selfdev')
    const ctx = { projectId: pid, workItemId: null, lang: 'hu' as const }
    const r = executeTool('workItem.addTodo', { workItem: itemId, text: 'Képeket kérni', dueInDays: 3 }, ctx)
    expect(r.ok).toBe(true)
    expect(listItemTodos(itemId)[0]).toMatchObject({ text: 'Képeket kérni', source: 'agent' })
    const o = createProject({ name: 'Idegen' })
    if (!o.ok) throw new Error('p')
    const r2 = executeTool('workItem.addTodo', { workItem: itemId, text: 'x' }, { ...ctx, projectId: o.project.id })
    expect(r2).toMatchObject({ ok: false, code: 'item_not_found' })
    expect(executeTool('workItem.addTodo', { workItem: itemId, text: 'x', dueWeekday: 'soha' }, ctx)).toMatchObject({ ok: false, code: 'bad_input' })
  })
})

describe('teendok: vegpontok', () => {
  beforeEach(setup)

  it('felvetel, lista, modositas, torles; hibak emberi mondattal', async () => {
    const empty = await callWorkbench(`/api/workbench/todos?project=${pid}`, 'GET')
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({ todos: [] })
    const bad = await callWorkbench('/api/workbench/todos', 'POST', { item_id: itemId, text: 'a', due_date: '2026-02-30' })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'todo_bad_due_date' })
    expect(typeof (bad.body as { message: string }).message).toBe('string')
    const miss = await callWorkbench('/api/workbench/todos', 'POST', { item_id: 'nincs', text: 'a' })
    expect(miss.status).toBe(404)
    const ok = await callWorkbench('/api/workbench/todos', 'POST', { item_id: itemId, text: 'Átnézni', due_date: '2026-10-02' })
    expect(ok.status).toBe(200)
    const id = (ok.body as { todo: { id: string } }).todo.id
    const patched = await callWorkbench(`/api/workbench/todos/${id}`, 'PATCH', { done: true })
    expect((patched.body as { todos: { done_at: number | null }[] }).todos[0].done_at).toBeTruthy()
    const del = await callWorkbench(`/api/workbench/todos/${id}`, 'DELETE')
    expect(del.body).toMatchObject({ todos: [] })
    expect((await callWorkbench(`/api/workbench/todos/${id}`, 'DELETE')).status).toBe(404)
  })

  it('naptarfajl letoltes; hatarido nelkul kulon kod', async () => {
    const a = addTodo({ work_item_id: itemId, text: 'Átnézni', due_date: '2026-10-02', by: 'o', source: 'ui' })
    const b = addTodo({ work_item_id: itemId, text: 'Valamikor', due_date: null, by: 'o', source: 'ui' })
    if (!a.ok || !b.ok) throw new Error('x')
    const one = await callWorkbench(`/api/workbench/todos/${a.todo.id}/ics`, 'GET')
    expect(one.status).toBe(200)
    expect(String(one.headers['Content-Type'])).toContain('text/calendar')
    expect(String(one.headers['Content-Disposition'])).toContain('attachment')
    expect(one.raw.toString()).toContain('DTSTART;VALUE=DATE:20261002')
    expect((await callWorkbench(`/api/workbench/todos/${b.todo.id}/ics`, 'GET')).status).toBe(409)
    const all = await callWorkbench(`/api/workbench/todos/ics?project=${pid}`, 'GET')
    expect(all.status).toBe(200)
    expect(all.raw.toString().match(/BEGIN:VEVENT/g)).toHaveLength(1)
    deleteTodo(a.todo.id)
    expect((await callWorkbench(`/api/workbench/todos/ics?project=${pid}`, 'GET')).status).toBe(409)
  })

  it('archivalt projektben nem lehet teendot felvenni', async () => {
    setProjectArchived(pid, true)
    const r = await callWorkbench('/api/workbench/todos', 'POST', { item_id: itemId, text: 'a' })
    expect(r.status).toBe(409)
  })
})

describe('teendok: a felulet', () => {
  const p = (n: number) => String(n).padStart(2, '0')
  const day = (off: number) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
  const TD = (over: Record<string, unknown>) => ({ id: 'td' + Math.random(), work_item_id: 'w1', project_id: 'p1', text: 'x', due_date: null, done_at: null, item_title: 'Ajánlat', ...over })

  function open(reply: () => { status: number; body: unknown }) {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/api/workbench/todos')) return reply()
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'td-open' })
    return h
  }

  it('csoportok: lejart, ma, kozelgo, hatarido nelkul, kesz; naptar-link', async () => {
    const todos = [
      TD({ text: 'Régi feladat', due_date: day(-2) }),
      TD({ text: 'Mai feladat', due_date: day(0) }),
      TD({ text: 'Jövő heti', due_date: day(6) }),
      TD({ text: 'Bármikor' }),
      TD({ text: 'Megvan', done_at: 1 }),
    ]
    const h = open(() => ({ status: 200, body: { todos } }))
    await vi.waitFor(() => expect(h.html()).toContain('Régi feladat'))
    for (const g of ['overdue', 'today', 'upcoming', 'nodate', 'done']) expect(h.html()).toContain('workbench.td.group.' + g)
    expect(h.html()).toContain('wb-td-overdue')
    expect(h.html()).toContain('/api/workbench/todos/ics?project=p1')
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'Ajánlat', 'Régi feladat', 'Mai feladat', 'Jövő heti', 'Bármikor', 'Megvan'])).toBe('')
  })

  it('ures projekt: kimondja, nincs naptar-gomb', async () => {
    const h = open(() => ({ status: 200, body: { todos: [] } }))
    await vi.waitFor(() => expect(h.html()).toContain('workbench.td.empty_project'))
    expect(h.html()).not.toContain('/api/workbench/todos/ics')
  })

  it('betoltesi hiba: a szerver mondata + ujraproba, nem "nincs teendo"', async () => {
    const h = open(() => ({ status: 500, body: { error: 'x', message: 'Belső hiba' } }))
    await vi.waitFor(() => expect(h.html()).toContain('Belső hiba'))
    expect(h.html()).toContain('data-wb-act="td-retry"')
    expect(h.html()).not.toContain('workbench.td.empty_project')
  })
})
