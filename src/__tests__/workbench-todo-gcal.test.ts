// #406, 14. pont B resze -- teendo a Google Naptarba: csak a tulajdonos
// kattintasara, teendonkent, a jovahagyasi kapun at; masodik kattintas
// frissit, nem duplikal. A kulso hivasokat (token, HTTP) csereljuk.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getApproval, resolveApproval } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addTodo, getTodo } from '../workbench-todos.js'
import {
  gcalStatus, _setGcalDeps, requestTodoCalendar, settleTodoCalendarApprovals, GCAL_CATEGORY,
  type HttpCall,
} from '../workbench-todo-gcal.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

let pid = ''
let itemId = ''
let calls: { url: string; method: string; body: any }[] = []
let nextStatus: number[] = []
let level = 3

const http: HttpCall = async (url, init) => {
  calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null })
  const status = nextStatus.shift() ?? 200
  // PATCH ugyanazt az esemenyt adja vissza, POST ujat.
  const id = init.method === 'PATCH' ? url.split('/').pop() : 'ev-' + calls.length
  return { status, text: status < 300 ? JSON.stringify({ id }) : '{"error":{"message":"nope"}}' }
}

function setup() {
  initDatabase(':memory:')
  const p = createProject({ name: 'Kovács weboldal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  const it = createWorkItem({ project_id: pid, title: 'Ajánlat', type: 'document' })
  if (!it.ok) throw new Error('munkadarab')
  itemId = it.item.id
  calls = []
  nextStatus = []
  level = 3
  _setGcalDeps({ token: async () => 'tok', http, status: () => ({ state: 'ready', account: 'a@x.hu' }), level: () => level })
}

function todo(due: string | null = '2026-10-02') {
  const r = addTodo({ work_item_id: itemId, text: 'Árajánlatot küldeni', due_date: due, by: 'owner', source: 'ui' })
  if (!r.ok) throw new Error(r.code)
  return r.todo.id
}

afterEach(() => _setGcalDeps())

describe('naptar: fiok-allapot', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'gcal-'))
  it('nincs token-fajl = nincs fiok (friss telepites)', () => {
    expect(gcalStatus(dir())).toEqual({ state: 'no_account', account: null })
  })
  it('olvashatatlan fajl = nem tudtuk megnezni, nem "nincs"', () => {
    const d = dir(); writeFileSync(join(d, 'google-tokens.json'), '{nem json')
    expect(gcalStatus(d).state).toBe('check_failed')
  })
  it('naptar-jog nelkuli fiok = no_scope; naptar-joggal = ready', () => {
    const d = dir()
    writeFileSync(join(d, 'google-tokens.json'), JSON.stringify({ fiok1: { scope: 'https://www.googleapis.com/auth/gmail.readonly' } }))
    expect(gcalStatus(d)).toEqual({ state: 'no_scope', account: 'fiok1' })
    writeFileSync(join(d, 'google-tokens.json'), JSON.stringify({ fiok1: { scope: 'https://www.googleapis.com/auth/calendar openid' } }))
    expect(gcalStatus(d)).toEqual({ state: 'ready', account: 'fiok1' })
  })
})

describe('naptar: iras es jovahagyas', () => {
  beforeEach(setup)

  it('3-as szint: azonnal ir; masodik kattintas UGYANAZT az esemenyt frissiti', async () => {
    const id = todo()
    const r = await requestTodoCalendar(id, 'hu', 'teszt')
    expect(r).toMatchObject({ ok: true, state: 'done', event_id: 'ev-1' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body.start).toEqual({ date: '2026-10-02' })
    expect(calls[0].body.end).toEqual({ date: '2026-10-03' })
    expect(calls[0].body.summary).toBe('Árajánlatot küldeni')
    expect(getTodo(id)).toMatchObject({ gcal_event_id: 'ev-1', gcal_account: 'a@x.hu', gcal_error: null })
    await requestTodoCalendar(id, 'hu', 'teszt')
    expect(calls[1].method).toBe('PATCH')
    expect(calls[1].url).toMatch(/\/events\/ev-1$/)
    expect(getTodo(id)!.gcal_event_id).toBe('ev-1')
  })

  it('a naptarbol kitorolt esemeny (404): ujat vesz fel, nem hibazik', async () => {
    const id = todo()
    await requestTodoCalendar(id, 'hu', null)
    nextStatus = [404]
    const r = await requestTodoCalendar(id, 'hu', null)
    expect(r).toMatchObject({ ok: true, state: 'done' })
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'POST'])
    expect(getTodo(id)!.gcal_event_id).toBe('ev-3')
  })

  it('Google-hiba: a teendon latszik, a valasz megmondja', async () => {
    const id = todo()
    nextStatus = [500]
    const r = await requestTodoCalendar(id, 'hu', null)
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    expect(getTodo(id)).toMatchObject({ gcal_event_id: null, gcal_error: 'failed' })
  })

  it('2-es szint: jegy nyilik, iras nincs; masodik kattintas nem nyit masodikat', async () => {
    level = 2
    const id = todo()
    const r = await requestTodoCalendar(id, 'hu', 'teszt')
    if (!r.ok || r.state !== 'pending') throw new Error('pending kellett')
    expect(calls).toEqual([])
    const a = getApproval(r.approval_id)!
    expect(a).toMatchObject({ category: GCAL_CATEGORY, status: 'pending' })
    expect(a.action_description).toContain('Árajánlatot küldeni')
    expect(a.action_description).toContain('2026-10-02')
    const again = await requestTodoCalendar(id, 'hu', 'teszt')
    expect(again).toEqual({ ok: true, state: 'pending', approval_id: r.approval_id })
    // Fuggo jegy mellett a rendezes nem ir.
    expect(await settleTodoCalendarApprovals()).toBe(0)
    expect(calls).toEqual([])
  })

  it('jovahagyas utan PONTOSAN a jovahagyott esemeny megy ki, egyszer', async () => {
    level = 2
    const id = todo()
    const r = await requestTodoCalendar(id, 'hu', null)
    if (!r.ok || r.state !== 'pending') throw new Error('pending kellett')
    resolveApproval(r.approval_id, 'approved', 'owner')
    expect(await settleTodoCalendarApprovals()).toBe(1)
    expect(await settleTodoCalendarApprovals()).toBe(0)
    expect(calls.length).toBe(1)
    expect(calls[0].body.start).toEqual({ date: '2026-10-02' })
    expect(getTodo(id)).toMatchObject({ gcal_event_id: 'ev-1', gcal_approval_id: null })
  })

  it('elutasitas: nincs iras, a teendon latszik', async () => {
    level = 2
    const id = todo()
    const r = await requestTodoCalendar(id, 'hu', null)
    if (!r.ok || r.state !== 'pending') throw new Error('pending kellett')
    resolveApproval(r.approval_id, 'rejected', 'owner')
    await settleTodoCalendarApprovals()
    expect(calls).toEqual([])
    expect(getTodo(id)).toMatchObject({ gcal_error: 'rejected', gcal_approval_id: null, gcal_event_id: null })
  })

  it('1-es szint: tiltva; hatarido nelkul: nincs mit beirni', async () => {
    level = 1
    expect(await requestTodoCalendar(todo(), 'hu', null)).toMatchObject({ ok: false, code: 'blocked' })
    level = 3
    expect(await requestTodoCalendar(todo(null), 'hu', null)).toMatchObject({ ok: false, code: 'no_due' })
    expect(calls).toEqual([])
  })

  it('nincs Google-fiok: kod, nem iras', async () => {
    _setGcalDeps({ http, status: () => ({ state: 'no_account', account: null }), level: () => 3 })
    expect(await requestTodoCalendar(todo(), 'hu', null)).toMatchObject({ ok: false, code: 'no_account' })
    expect(calls).toEqual([])
  })
})

describe('naptar: vegpont', () => {
  beforeEach(setup)

  it('siker: a friss teendo-listat adja vissza', async () => {
    const id = todo()
    const r = await callWorkbench(`/api/workbench/todos/${id}/gcal`, 'POST', {})
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ state: 'done' })
    expect(r.body.todo.gcal_event_id).toBe('ev-1')
  })

  it('hibakodok emberi mondattal', async () => {
    expect((await callWorkbench('/api/workbench/todos/nincs/gcal', 'POST', {})).status).toBe(404)
    const nd = await callWorkbench(`/api/workbench/todos/${todo(null)}/gcal`, 'POST', {})
    expect(nd.status).toBe(409)
    expect(typeof nd.body.message).toBe('string')
    level = 1
    const bl = await callWorkbench(`/api/workbench/todos/${todo()}/gcal`, 'POST', {})
    expect(bl).toMatchObject({ status: 403, body: { error: 'todo_gcal_blocked' } })
    _setGcalDeps({ http, status: () => ({ state: 'no_account', account: null }), level: () => 3 })
    const na = await callWorkbench(`/api/workbench/todos/${todo()}/gcal`, 'POST', {})
    expect(na).toMatchObject({ status: 409, body: { error: 'todo_gcal_no_account' } })
    expect(na.body.message).toMatch(/Google/)
  })

  it('archivalt projektben nem ir', async () => {
    const id = todo()
    setProjectArchived(pid, true)
    expect((await callWorkbench(`/api/workbench/todos/${id}/gcal`, 'POST', {})).status).toBe(409)
    expect(calls).toEqual([])
  })
})

describe('naptar: a felulet', () => {
  const TD = (over: Record<string, unknown>) => ({ id: 'td1', work_item_id: 'w1', project_id: 'p1', text: 'Árajánlat', due_date: '2026-10-02', done_at: null, item_title: 'Ajánlat', ...over })

  function open(gcal: { state: string; account: string | null }, todos: unknown[], post?: { status: number; body: unknown }) {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/api/workbench/gcal-status')) return { status: 200, body: { gcal } }
      if (url.includes('/gcal')) return post || { status: 200, body: {} }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'td-open' })
    return h
  }

  it('friss telepites (nincs fiok): emberi mondat + beallito gomb, naptar-gomb nincs', async () => {
    const h = open({ state: 'no_account', account: null }, [TD({})])
    await vi.waitFor(() => expect(h.html()).toContain('workbench.td.gcal.setup_none'))
    expect(h.html()).toContain('data-wb-act="td-gcal-setup"')
    expect(h.html()).not.toContain('data-wb-act="td-gcal"')
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'Ajánlat', 'Árajánlat'])).toBe('')
  })

  it('bekotott fiok: gomb a hataridos teendon, hatarido nelkulin nincs; fuggo jegynel a jovahagyasokhoz visz', async () => {
    const h = open({ state: 'ready', account: 'a@x.hu' }, [TD({}), TD({ id: 'td2', due_date: null }), TD({ id: 'td3', gcal_approval_id: 'ap1' })])
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="td-gcal"'))
    const html = h.html()
    expect(html).toContain('data-wb-todo="td1"')
    expect(html).not.toContain('data-wb-act="td-gcal" data-wb-todo="td2"')
    expect(html).toContain('workbench.td.gcal.pending')
    expect(html).toContain('data-wb-act="goto-approvals"')
    expect(html).not.toContain('workbench.td.gcal.setup')
  })

  it('kattintas: POST, a jegy-toast', async () => {
    const h = open({ state: 'ready', account: 'a@x.hu' }, [TD({})], { status: 200, body: { state: 'pending', approval_id: 'ap1', todos: [TD({ gcal_approval_id: 'ap1' })] } })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="td-gcal"'))
    h.click({ 'data-wb-act': 'td-gcal', 'data-wb-todo': 'td1' })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.td.gcal.toast_pending⟧'))
    expect(h.fetchCalls.find((c) => c.url.includes('/api/workbench/todos/td1/gcal'))?.init?.method).toBe('POST')
  })
})

describe('naptar: autonomia-kategoria', () => {
  it('a seedben 2-es szinten van, cimkevel', () => {
    const seed = JSON.parse(readFileSync(join(process.cwd(), 'seed-config', 'autonomy-config.json'), 'utf-8'))
    const cats = seed.categories || seed
    const c = (Array.isArray(cats) ? cats : []).find((x: { key: string }) => x.key === GCAL_CATEGORY)
    expect(c).toMatchObject({ level: 2, locked: false })
    expect(String(c.label).length).toBeGreaterThan(10)
  })
})
