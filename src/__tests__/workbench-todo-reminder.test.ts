// #406, otlet a5ecabbe -- TEENDO-EMLEKEZTETO a tulajdonos sajat csatornajan:
// mikor esedekes, egyszer megy ki, a sikertelen kuldes nem jelol, beallitas,
// vegpontok, felulet.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addTodo, updateTodo, getTodo } from '../workbench-todos.js'
import {
  getReminderSettings, setReminderSettings, getReminderStatus, remindUpTo, dueReminders,
  reminderText, runTodoReminders, REMINDER_DEFAULTS, REMINDER_RETRY_AFTER_S,
} from '../workbench-todo-reminder.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

let pid = ''
let itemId = ''
const at = (ymd: string, hh = 12, mm = 0) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d, hh, mm) }
const todo = (text: string, due: string | null) => {
  const r = addTodo({ work_item_id: itemId, text, due_date: due, by: 'o', source: 'owner' })
  if (!r.ok) throw new Error(r.code)
  return r.todo
}

function setup() {
  initDatabase(':memory:')
  const p = createProject({ name: 'Kovács weboldal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  const it = createWorkItem({ project_id: pid, title: 'Ajánlat', type: 'document' })
  if (!it.ok) throw new Error('munkadarab')
  itemId = it.item.id
}

describe('emlekezteto: beallitas', () => {
  beforeEach(setup)

  it('friss telepites: bekapcsolva, elozo nap 18:00', () => {
    expect(getReminderSettings()).toEqual(REMINDER_DEFAULTS)
    expect(REMINDER_DEFAULTS).toEqual({ enabled: true, days_before: 1, time: '18:00' })
  })

  it('modositas es hibas ertek kulon koddal', () => {
    expect(setReminderSettings({ time: '7:05', days_before: 2, enabled: false })).toMatchObject({ ok: true, settings: { time: '07:05', days_before: 2, enabled: false } })
    expect(setReminderSettings({ time: '25:00' })).toEqual({ ok: false, code: 'bad_time' })
    expect(setReminderSettings({ days_before: 5 })).toEqual({ ok: false, code: 'bad_days_before' })
    expect(getReminderSettings()).toEqual({ time: '07:05', days_before: 2, enabled: false })
  })

  it('allapot: nincs csatorna -> kimondja, nem hallgat', () => {
    expect(getReminderStatus(() => false)).toMatchObject({ channel: 'no_channel', last_sent_at: null, last_error: null })
    expect(getReminderStatus(() => true).channel).toBe('ok')
  })
})

describe('emlekezteto: mikor esedekes', () => {
  beforeEach(setup)

  it('elozo nap 18:00 elott a holnapi meg nem, utana igen', () => {
    const s = REMINDER_DEFAULTS
    expect(remindUpTo(s, at('2026-10-01', 17, 59))).toBe('2026-10-01')
    expect(remindUpTo(s, at('2026-10-01', 18, 0))).toBe('2026-10-02')
    expect(remindUpTo({ ...s, days_before: 0, time: '08:00' }, at('2026-10-01', 9))).toBe('2026-10-01')
    expect(remindUpTo({ ...s, days_before: 7 }, at('2026-10-01', 19))).toBe('2026-10-08')
  })

  it('csak nyitott, hataridos, nem lejart, aktiv projektbeli teendo', () => {
    todo('Holnapi', '2026-10-02')
    todo('Mai', '2026-10-01')
    todo('Tegnapi (lejart)', '2026-09-30')
    todo('Jovo heti', '2026-10-08')
    todo('Hatarido nelkul', null)
    const done = todo('Kesz', '2026-10-02')
    updateTodo(done.id, { done: true })
    const texts = dueReminders(at('2026-10-01', 18, 30)).map((r) => r.text)
    expect(texts).toEqual(['Mai', 'Holnapi'])
    setProjectArchived(pid, true)
    expect(dueReminders(at('2026-10-01', 18, 30))).toEqual([])
  })

  it('uzenet: egy uzenet, ma/holnap, projekt / munkadarab, a tobbi szammal', () => {
    const rows = [
      { id: 'a', text: 'Átnézni', due_date: '2026-10-02', project_name: 'Kovács', item_title: 'Ajánlat' },
      { id: 'b', text: 'Felhívni', due_date: '2026-10-01', project_name: 'Kovács', item_title: '' },
    ]
    const hu = reminderText(rows, at('2026-10-01', 18), 'hu')
    expect(hu).toContain('2 teendő')
    expect(hu).toContain('holnap: Átnézni (Kovács / Ajánlat)')
    expect(hu).toContain('ma: Felhívni (Kovács)')
    const en = reminderText(rows, at('2026-10-01', 18), 'en')
    expect(en).toContain('tomorrow: Átnézni')
    const many = Array.from({ length: 25 }, (_, i) => ({ ...rows[0], id: 'x' + i }))
    expect(reminderText(many, at('2026-10-01', 18), 'hu')).toContain('még 5')
  })
})

describe('emlekezteto: kuldes', () => {
  beforeEach(setup)

  it('egyszer megy ki; a hatarido atirasa ujra elesiti', async () => {
    const t = todo('Holnapi', '2026-10-02')
    const send = vi.fn(async () => 'sent' as const)
    expect(await runTodoReminders(at('2026-10-01', 18, 5), send)).toEqual({ kind: 'sent', count: 1 })
    expect(await runTodoReminders(at('2026-10-01', 18, 10), send)).toEqual({ kind: 'nothing' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(getTodo(t.id)).toMatchObject({ reminded_for: '2026-10-02' })
    expect(getReminderStatus(() => true).last_sent_at).toBeTruthy()
    updateTodo(t.id, { due_date: '2026-10-05' })
    expect(await runTodoReminders(at('2026-10-04', 18, 5), send)).toEqual({ kind: 'sent', count: 1 })
  })

  it('sikertelen kuldes NEM jelol: a hiba latszik, fel ora mulva ujraprobalja', async () => {
    const t = todo('Holnapi', '2026-10-02')
    const bad = vi.fn(async () => { throw new Error('Telegram API 400') })
    const r = await runTodoReminders(at('2026-10-01', 18, 5), bad)
    expect(r).toMatchObject({ kind: 'failed', pending: 1 })
    expect(getTodo(t.id)).toMatchObject({ reminded_for: null })
    expect(getReminderStatus(() => true)).toMatchObject({ last_error: 'Telegram API 400' })
    const good = vi.fn(async () => 'sent' as const)
    expect(await runTodoReminders(at('2026-10-01', 18, 10), good)).toMatchObject({ kind: 'backoff' })
    expect(good).not.toHaveBeenCalled()
    const later = new Date(at('2026-10-01', 18, 5).getTime() + (REMINDER_RETRY_AFTER_S + 60) * 1000)
    expect(await runTodoReminders(later, good)).toEqual({ kind: 'sent', count: 1 })
    expect(getReminderStatus(() => true).last_error).toBe(null)
  })

  it('nincs csatorna: nem jelol, kimondja', async () => {
    const t = todo('Holnapi', '2026-10-02')
    expect(await runTodoReminders(at('2026-10-01', 18, 5), async () => 'no_channel')).toEqual({ kind: 'no_channel', pending: 1 })
    expect(getTodo(t.id)).toMatchObject({ reminded_for: null })
  })

  it('kikapcsolva: semmi nem megy ki', async () => {
    todo('Holnapi', '2026-10-02')
    setReminderSettings({ enabled: false })
    const send = vi.fn(async () => 'sent' as const)
    expect(await runTodoReminders(at('2026-10-01', 18, 5), send)).toEqual({ kind: 'off' })
    expect(send).not.toHaveBeenCalled()
  })

  it('ismetlodo teendo kovetkezo peldanya a sajat hataridejere ujra emlekeztet', async () => {
    const r = addTodo({ work_item_id: itemId, text: 'Heti', due_date: '2026-10-02', repeat: 'weekly', by: 'o', source: 'owner' })
    if (!r.ok) throw new Error(r.code)
    const send = vi.fn(async () => 'sent' as const)
    await runTodoReminders(at('2026-10-01', 18, 5), send)
    updateTodo(r.todo.id, { done: true }, at('2026-10-02'))
    expect(await runTodoReminders(at('2026-10-08', 18, 5), send)).toEqual({ kind: 'sent', count: 1 })
  })
})

describe('emlekezteto: vegpontok', () => {
  beforeEach(setup)

  it('allapot, mentes, hibas ertek emberi mondattal', async () => {
    const g = await callWorkbench('/api/workbench/todo-reminder', 'GET')
    expect(g.status).toBe(200)
    expect(g.body).toMatchObject({ reminder: { enabled: true, days_before: 1, time: '18:00' } })
    const p = await callWorkbench('/api/workbench/todo-reminder', 'PUT', { enabled: false, days_before: 0, time: '08:30' })
    expect(p.body).toMatchObject({ reminder: { enabled: false, days_before: 0, time: '08:30' } })
    const bad = await callWorkbench('/api/workbench/todo-reminder', 'PUT', { time: 'reggel' })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'todo_reminder_bad_time' })
    expect(typeof (bad.body as { message: string }).message).toBe('string')
  })
})

describe('emlekezteto: a felulet', () => {
  function open(reminder: unknown) {
    const h = workbenchHarness()
    h.respond((url, init) => {
      if (url.includes('/api/workbench/todo-reminder/test')) return { status: 409, body: { error: 'todo_reminder_no_channel', message: 'Nincs csatorna' } }
      if (url.includes('/api/workbench/todo-reminder') && init && init.method === 'PUT') {
        return { status: 200, body: { reminder: { ...(reminder as object), enabled: false } } }
      }
      if (url.includes('/api/workbench/todo-reminder')) return { status: 200, body: { reminder } }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'td-open' })
    return h
  }
  const base = { enabled: true, days_before: 1, time: '18:00', channel: 'ok', last_sent_at: null, last_error: null, last_error_at: null }

  it('beallitas latszik, forditva; nincs csatornanal kimondja', async () => {
    const h = open({ ...base, channel: 'no_channel' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.td.rem.no_channel'))
    expect(h.html()).toContain('id="wbTdRemTime"')
    expect(h.html()).toContain('data-wb-act="td-rem-test"')
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal'])).toBe('')
  })

  it('utolso hiba: a csatorna valasza latszik', async () => {
    const h = open({ ...base, last_error: 'Telegram API 400', last_error_at: 1790000000 })
    await vi.waitFor(() => expect(h.html()).toContain('Telegram API 400'))
    expect(h.html()).toContain('workbench.td.rem.last_error')
  })

  it('proba nincs csatornaval: a szerver mondata a toastban', async () => {
    const h = open(base)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="td-rem-test"'))
    h.click({ 'data-wb-act': 'td-rem-test' })
    await vi.waitFor(() => expect(h.toasts.join('|')).toContain('Nincs csatorna'))
  })
})
