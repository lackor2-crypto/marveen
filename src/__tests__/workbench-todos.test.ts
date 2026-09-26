// #406, 14. pont -- KIS TEENDOK HATARIDOVEL: tarolas, naptarfajl, vegpontok,
// agens-eszkoz ES a felulet.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import {
  addTodo, updateTodo, deleteTodo, listItemTodos, listProjectTodos, cleanDueDate,
  todosToIcs, resolveAgentDue, TODOS_PER_ITEM_MAX, TODO_TEXT_MAX, nextDueDate, cleanRepeat, getTodo,
} from '../workbench-todos.js'
import { getDb } from '../db.js'
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

// Otlet 11dfd5a9: "minden hetfon" / "minden honap 1-jen" -- kipipalas utan
// magatol jon a kovetkezo.
describe('ismetlodo teendok', () => {
  beforeEach(setup)
  const at = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d, 12) }

  it('kovetkezo nap: hetente +7, havonta ugyanaz a nap, rovid honapban az utolso', () => {
    expect(nextDueDate('2026-10-05', 'weekly', null, at('2026-10-05'))).toBe('2026-10-12')
    expect(nextDueDate('2026-12-28', 'weekly', null, at('2026-12-28'))).toBe('2027-01-04')
    expect(nextDueDate('2026-10-01', 'monthly', 1, at('2026-10-01'))).toBe('2026-11-01')
    expect(nextDueDate('2026-01-31', 'monthly', 31, at('2026-01-31'))).toBe('2026-02-28')
    // februar utan a 31-es horgony visszater a 31-re, nem ragad 28-on
    expect(nextDueDate('2026-02-28', 'monthly', 31, at('2026-02-28'))).toBe('2026-03-31')
    expect(nextDueDate('2028-01-31', 'monthly', 31, at('2028-01-31'))).toBe('2028-02-29')
  })

  it('keson kipipalva nem szul mar lejart kovetkezot', () => {
    expect(nextDueDate('2026-09-07', 'weekly', null, at('2026-09-26'))).toBe('2026-09-28')
    expect(nextDueDate('2026-06-01', 'monthly', 1, at('2026-09-26'))).toBe('2026-10-01')
    // korai pipa: a kovetkezo a mostani utan jon, nem ugyanarra a napra
    expect(nextDueDate('2026-10-05', 'weekly', null, at('2026-09-26'))).toBe('2026-10-12')
  })

  it('bemenet: ismeretlen ertek es hatarido nelkuli ismetlodes kulon koddal', () => {
    expect(cleanRepeat('none')).toEqual({ ok: true, repeat: null })
    expect(cleanRepeat('weekly')).toEqual({ ok: true, repeat: 'weekly' })
    expect(cleanRepeat('daily').ok).toBe(false)
    expect(addTodo({ work_item_id: itemId, text: 'a', due_date: '2026-10-05', repeat: 'daily', by: 'o', source: 'owner' })).toMatchObject({ ok: false, code: 'bad_repeat' })
    expect(addTodo({ work_item_id: itemId, text: 'a', due_date: null, repeat: 'weekly', by: 'o', source: 'owner' })).toMatchObject({ ok: false, code: 'repeat_needs_due' })
    const r = addTodo({ work_item_id: itemId, text: 'a', due_date: '2026-10-05', repeat: 'weekly', by: 'o', source: 'owner' })
    if (!r.ok) throw new Error(r.code)
    expect(updateTodo(r.todo.id, { due_date: '' })).toMatchObject({ ok: false, code: 'repeat_needs_due' })
  })

  it('kipipalas: pontosan egy kovetkezo; visszavetel: az erintetlen kovetkezo eltunik', () => {
    const r = addTodo({ work_item_id: itemId, text: 'Heti jelentés', due_date: '2026-10-05', repeat: 'weekly', by: 'o', source: 'owner' })
    if (!r.ok) throw new Error(r.code)
    const d = updateTodo(r.todo.id, { done: true }, at('2026-10-05'))
    if (!d.ok || !d.next) throw new Error('nincs kovetkezo')
    expect(d.next).toMatchObject({ text: 'Heti jelentés', due_date: '2026-10-12', repeat: 'weekly', done_at: null })
    // ujra-pipa (mar kesz) nem szul masodikat
    const again = updateTodo(r.todo.id, { done: true }, at('2026-10-05'))
    expect(again.ok && again.next).toBe(null)
    expect(listItemTodos(itemId).filter((x) => x.done_at == null)).toHaveLength(1)
    // visszavetel: az erintetlen kovetkezo torlodik
    const u = updateTodo(r.todo.id, { done: false }, at('2026-10-05'))
    expect(u.ok && u.todo.next_id).toBe(null)
    expect(getTodo(d.next.id)).toBeUndefined()
    // ujra kipipalva: ujra pontosan egy
    const d2 = updateTodo(r.todo.id, { done: true }, at('2026-10-05'))
    expect(d2.ok && d2.next).toBeTruthy()
    expect(listItemTodos(itemId)).toHaveLength(2)
  })

  it('visszavetel nem torli a kovetkezot, amihez a tulajdonos mar hozzanyult', () => {
    const r = addTodo({ work_item_id: itemId, text: 'Havi számla', due_date: '2026-10-01', repeat: 'monthly', by: 'o', source: 'owner' })
    if (!r.ok) throw new Error(r.code)
    const d = updateTodo(r.todo.id, { done: true }, at('2026-10-01'))
    if (!d.ok || !d.next) throw new Error('nincs kovetkezo')
    updateTodo(d.next.id, { text: 'Havi számla + melléklet' }, new Date(at('2026-10-01').getTime() + 5000))
    updateTodo(r.todo.id, { done: false }, at('2026-10-02'))
    expect(getTodo(d.next.id)).toMatchObject({ text: 'Havi számla + melléklet' })
    // ujra kipipalva: a megmaradt kovetkezo mellett NEM jon masodik
    const again = updateTodo(r.todo.id, { done: true }, at('2026-10-02'))
    expect(again.ok && again.next).toBe(null)
    expect(listItemTodos(itemId)).toHaveLength(2)
  })

  it('"ne ismetlodjon": a kipipalas utan nem jon kovetkezo; havi nap a hataridovel valtozik', () => {
    const r = addTodo({ work_item_id: itemId, text: 'a', due_date: '2026-10-15', repeat: 'monthly', by: 'o', source: 'owner' })
    if (!r.ok) throw new Error(r.code)
    expect(r.todo.repeat_day).toBe(15)
    const moved = updateTodo(r.todo.id, { due_date: '2026-10-20' })
    expect(moved.ok && moved.todo.repeat_day).toBe(20)
    const stop = updateTodo(r.todo.id, { repeat: '' })
    expect(stop.ok && stop.todo).toMatchObject({ repeat: null, repeat_day: null })
    const d = updateTodo(r.todo.id, { done: true })
    expect(d.ok && d.next).toBe(null)
  })

  it('a felso korlat csak a NYITOTT teendoket szamolja -- egy heti teendo ket ev utan sem akad el', () => {
    for (let i = 0; i < TODOS_PER_ITEM_MAX; i++) {
      const x = addTodo({ work_item_id: itemId, text: 't' + i, due_date: null, by: 'o', source: 'owner' })
      if (x.ok && i % 2 === 0) updateTodo(x.todo.id, { done: true })
    }
    expect(addTodo({ work_item_id: itemId, text: 'uj', due_date: null, by: 'o', source: 'owner' }).ok).toBe(true)
  })

  it('regi tabla (oszlopok nelkul) is megkapja az uj oszlopokat', () => {
    initDatabase(':memory:')
    getDb().exec(`CREATE TABLE work_item_todos (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, project_id TEXT NOT NULL,
      text TEXT NOT NULL, due_date TEXT, done_at INTEGER, created_by TEXT, source TEXT, created_at INTEGER, updated_at INTEGER)`)
    const p = createProject({ name: 'Régi' })
    if (!p.ok) throw new Error('p')
    const it = createWorkItem({ project_id: p.project.id, title: 'x', type: 'document' })
    if (!it.ok) throw new Error('it')
    const r = addTodo({ work_item_id: it.item.id, text: 'a', due_date: '2026-10-05', repeat: 'weekly', by: 'o', source: 'owner' })
    expect(r.ok && r.todo.repeat).toBe('weekly')
    expect(getTodo(r.ok ? r.todo.id : '')).toMatchObject({ repeat: 'weekly' })
  })

  it('vegpontok: felvetel ismetlodessel, kipipalas visszaadja a kovetkezot, emberi hibamondat', async () => {
    const bad = await callWorkbench('/api/workbench/todos', 'POST', { item_id: itemId, text: 'a', repeat: 'weekly' })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'todo_repeat_needs_due' })
    expect(typeof (bad.body as { message: string }).message).toBe('string')
    const ok = await callWorkbench('/api/workbench/todos', 'POST', { item_id: itemId, text: 'Heti', due_date: '2026-10-05', repeat: 'weekly' })
    expect(ok.status).toBe(200)
    const id = (ok.body as { todo: { id: string; repeat: string } }).todo.id
    expect((ok.body as { todo: { repeat: string } }).todo.repeat).toBe('weekly')
    const done = await callWorkbench(`/api/workbench/todos/${id}`, 'PATCH', { done: true })
    const next = (done.body as { next: { due_date: string } | null }).next
    expect(next && next.due_date > '2026-10-05').toBe(true)
    expect((done.body as { todos: unknown[] }).todos).toHaveLength(2)
    const stop = await callWorkbench(`/api/workbench/todos/${next ? (next as unknown as { id: string }).id : ''}`, 'PATCH', { repeat: null })
    expect((stop.body as { todo: { repeat: string | null } }).todo.repeat).toBe(null)
  })

  it('agens-eszkoz: ismetlodest is fel tud venni, hatarido nelkul kimondja a hibat', () => {
    const tool = getTool('workItem.addTodo')
    expect(tool && tool.input).toContain('repeat')
    const ok = executeTool('workItem.addTodo', { workItem: itemId, text: 'Heti mentés', dueInDays: 1, repeat: 'weekly' }, { projectId: pid, workItemId: null, lang: 'hu' as const })
    expect(ok).toMatchObject({ ok: true, data: { repeat: 'weekly' } })
    const bad = executeTool('workItem.addTodo', { workItem: itemId, text: 'x', repeat: 'weekly' }, { projectId: pid, workItemId: null, lang: 'hu' as const })
    expect(bad).toMatchObject({ ok: false, code: 'bad_input' })
  })
})

describe('ismetlodo teendok: a felulet', () => {
  function openItem(todos: unknown[], patchReply?: unknown) {
    const h = workbenchHarness()
    h.respond((url, init) => {
      if (url.includes('/api/workbench/todos/') && init && init.method === 'PATCH') return { status: 200, body: patchReply }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'td-open' })
    return h
  }
  const row = { id: 'r1', work_item_id: 'w1', project_id: 'p1', text: 'Heti jelentés', due_date: '2026-10-05', done_at: null, item_title: 'Ajánlat', repeat: 'weekly', repeat_day: null }

  it('a sor mutatja az ismetlodest es a "ne ismetlodjon" gombot, forditva', async () => {
    const h = openItem([row, { ...row, id: 'r2', text: 'Havi', repeat: 'monthly', repeat_day: 31, due_date: '2026-10-31' }])
    await vi.waitFor(() => expect(h.html()).toContain('Heti jelentés'))
    expect(h.html()).toContain('workbench.td.repeat_weekly_label')
    expect(h.html()).toContain('workbench.td.repeat_monthly_label')
    expect(h.html()).toContain('data-wb-act="td-norepeat"')
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'Ajánlat', 'Heti jelentés', 'Havi'])).toBe('')
  })

  it('kipipalas: a toast megmondja, mikor jon a kovetkezo', async () => {
    const h = openItem([row], { todo: { ...row, done_at: 1 }, next: { ...row, id: 'r9', due_date: '2026-10-12' }, todos: [] })
    await vi.waitFor(() => expect(h.html()).toContain('Heti jelentés'))
    h.click({ 'data-wb-act': 'td-toggle', 'data-wb-todo': 'r1' })
    await vi.waitFor(() => expect(h.toasts.join('|')).toContain('workbench.td.toast.done_next'))
  })
})
