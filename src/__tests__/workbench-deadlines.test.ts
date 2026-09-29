// #441 (v4 spec 1/A, K-1.17): hataridok es idopontok a feltoltott birosagi /
// hatosagi levelekbol, forrassal. Egy kattintassal teendo lesz beloluk (onnan
// naptar). A kezdonaptol szamitott hataridot a Marveen nem szamolja ki
// magatol: a kezbesites napjabol javasol, a napot a tulajdonos hagyja jova.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, setProjectArchived } from '../projects.js'
import { createWorkItem, getWorkItem, setWorkItemDeleted, purgeWorkItem } from '../workbench.js'
import { attachAsset, listWorkItemAssets } from '../workbench-assets.js'
import { ensureDocReadTables, DOCREAD_VERSION } from '../workbench-docread.js'
import { extractDeadlines, findTime, proposeDue, itemDeadlines } from '../workbench-deadlines.js'
import { listItemTodos } from '../workbench-todos.js'
import { executeTool } from '../workbench-agent/execute.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const HU = 'Fővárosi Törvényszék\n12.P.20.123/2025/4. szám\nA bíróság az ügyben a tárgyalást 2027. október 20. napjának 9 óra 00 percére tűzi ki. '
  + 'A bíróság felhívja az alperest, hogy ellenkérelmét a végzés kézbesítésétől számított 30 napon belül terjessze elő. '
  + 'A 2025. szeptember 1-jén kelt végzés ellen a kézbesítéstől számított tizenöt (15) napon belül fellebbezésnek van helye. '
  + 'A hiánypótlást 2027. november 3-ig kell teljesíteni. Az illetéket legkésőbb 2027. november 10. napjáig fizesse meg. '
  + 'A felek 8 munkanapon belül nyilatkozzanak. Budapest, 2025. szeptember 29.'

describe('kigyujtes', () => {
  it('magyar level: targyalas idoponttal, naptari es kezdonaptol szamitott hataridok; a kelt-datum es a keltezes nem hatarido', () => {
    const f = extractDeadlines(HU).map((d) => [d.kind, d.topic, d.date, d.time, d.relative])
    expect(f).toEqual([
      ['hearing', 'hearing', '2027-10-20', '09:00', null],
      ['deadline', 'response', null, null, { amount: 30, unit: 'day', trigger: 'delivery' }],
      ['deadline', 'appeal', null, null, { amount: 15, unit: 'day', trigger: 'delivery' }],
      ['deadline', 'cure', '2027-11-03', null, null],
      ['deadline', 'payment', '2027-11-10', null, null],
      ['deadline', 'response', null, null, { amount: 8, unit: 'workday', trigger: 'other' }],
    ])
  })

  it('nemet es angol level', () => {
    const de = 'Termin zur mündlichen Verhandlung wird bestimmt auf Dienstag, den 17. März 2027, 10:30 Uhr, Saal 2. '
      + 'Der Beklagten wird aufgegeben, binnen zwei Wochen nach Zustellung dieser Verfügung Stellung zu nehmen. '
      + 'Die Klageerwiderung ist bis zum 15. Januar 2027 einzureichen.'
    expect(extractDeadlines(de).map((d) => [d.kind, d.topic, d.date, d.time, d.relative])).toEqual([
      ['hearing', 'hearing', '2027-03-17', '10:30', null],
      ['deadline', 'response', null, null, { amount: 2, unit: 'week', trigger: 'delivery' }],
      ['deadline', 'response', '2027-01-15', null, null],
    ])
    const en = 'The defendant must serve an answer within 21 days after service of the summons. '
      + 'A status conference is set for January 12, 2027 at 9:00 a.m. Opposition papers are due by February 3, 2027. '
      + 'Due to the delay on March 1, 2026 nothing happened.'
    expect(extractDeadlines(en).map((d) => [d.kind, d.topic, d.date, d.time, d.relative])).toEqual([
      ['deadline', 'response', null, null, { amount: 21, unit: 'day', trigger: 'delivery' }],
      ['hearing', 'hearing', '2027-01-12', '09:00', null],
      ['deadline', 'response', '2027-02-03', null, null],
    ])
  })

  it('a forras a mondat szo szerint; hosszu mondatnal a talalat kornyeke', () => {
    const [d] = extractDeadlines('A hiánypótlást 2027. november 3-ig kell teljesíteni.')
    expect(d?.quote).toBe('A hiánypótlást 2027. november 3-ig kell teljesíteni.')
    const long = 'A ' + 'nagyon '.repeat(120) + 'hosszú mondatban a hiánypótlást 2027. november 3-ig kell teljesíteni, ' + 'és '.repeat(60) + 'vége.'
    const [l] = extractDeadlines(long)
    expect(l?.quote.length).toBeLessThanOrEqual(402)
    expect(l?.quote).toContain('2027. november 3-ig')
  })

  it('idopontok', () => {
    expect(['10:30', '10.30 órakor', '10 óra 30 perckor', 'um 9 Uhr', '9:00 a.m.', '2 p.m.', '24 órán belül', '2025.05.03'].map(findTime))
      .toEqual(['10:30', '10:30', '10:30', '09:00', '09:00', '14:00', null, null])
  })

  it('javaslat: a kezdonap nem szamit bele, hetvege -> hetfo, honap vege; munkanapban nincs javaslat', () => {
    expect(proposeDue('2025-10-01', 15, 'day')).toEqual({ due: '2025-10-16', shifted: false })
    expect(proposeDue('2025-10-03', 15, 'day')).toEqual({ due: '2025-10-20', shifted: true })
    expect(proposeDue('2025-01-31', 1, 'month')).toEqual({ due: '2025-02-28', shifted: false })
    expect(proposeDue('2025-10-01', 2, 'week')).toEqual({ due: '2025-10-15', shifted: false })
    expect(proposeDue('2025-10-01', 8, 'workday')).toBeNull()
    expect(proposeDue('2025-02-30', 8, 'day')).toBeNull()
    expect(proposeDue('tegnap', 8, 'day')).toBeNull()
  })
})

describe('a munkadarabon', () => {
  let depot = ''
  let pid = ''
  let itemId = ''

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-deadlines-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: pid, title: 'Válasz a végzésre', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    const a = attachAsset(getWorkItem(itemId)!, 'vegzes.pdf', Buffer.from('PDF vegzes'))
    if (!a.ok) throw new Error('anyag')
    ensureDocReadTables()
    const db = getDb()
    db.prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
      VALUES (?, 'vegzes.pdf', 'pdf', 'done', 2, 2, NULL, ?, 1)`).run(a.asset.sha256, DOCREAD_VERSION)
    db.prepare("INSERT INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, 1, 'Fővárosi Törvényszék. Végzés.', 'text', NULL, 0)").run(a.asset.sha256)
    db.prepare("INSERT INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, 2, ?, 'ocr', 55, 1)").run(a.asset.sha256, HU)
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const list = () => itemDeadlines(itemId, listWorkItemAssets(itemId))
  const base = () => `/api/workbench/items/${itemId}/deadlines`

  it('a lista forrassal; a rosszul olvashato oldal jelolve; a reszletek kozott is ott', async () => {
    const l = list()
    expect(l).toHaveLength(6)
    expect(l[0]).toMatchObject({ kind: 'hearing', date: '2027-10-20', name: 'vegzes.pdf', page: 2, low: true, todo: null, dismissed: false })
    expect(l[0]!.path).toMatch(/vegzes\.pdf$/)
    const detail = await callWorkbench(`/api/workbench/items/${itemId}`, 'GET')
    expect(detail.body.deadlines).toHaveLength(6)
  })

  it('naptari hatarido: egy kattintassal teendo, a forrassal a szovegeben; masodszor nem', async () => {
    const cure = list().find((d) => d.topic === 'cure')!
    const r = await callWorkbench(`${base()}/${cure.key}/todo`, 'POST', {})
    expect(r.status).toBe(201)
    expect(r.body.todo).toMatchObject({ due_date: '2027-11-03', text: 'Hiánypótlási határidő (vegzes.pdf, 2. oldal)', source: 'owner' })
    expect(r.body.deadlines.find((d: { key: string }) => d.key === cure.key).todo).toMatchObject({ due_date: '2027-11-03', done: false })
    expect(listItemTodos(itemId)).toHaveLength(1)
    const again = await callWorkbench(`${base()}/${cure.key}/todo`, 'POST', {})
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('deadline_already')
    // A targyalas idopontja a teendo szovegeben.
    const hearing = list().find((d) => d.kind === 'hearing')!
    const h = await callWorkbench(`${base()}/${hearing.key}/todo`, 'POST', {})
    expect(h.body.todo.text).toBe('Tárgyalás 09:00 (vegzes.pdf, 2. oldal)')
  })

  it('kezdonaptol szamitott: javaslat a kezbesites napjabol, a napot a tulajdonos adja; munkanapban nincs javaslat', async () => {
    const appeal = list().find((d) => d.topic === 'appeal')!
    const noDue = await callWorkbench(`${base()}/${appeal.key}/todo`, 'POST', {})
    expect(noDue.status).toBe(400)
    expect(noDue.body.error).toBe('deadline_needs_due')
    const p = await callWorkbench(`${base()}/${appeal.key}/propose`, 'POST', { trigger: '2025-10-03' })
    expect(p.body.proposal).toEqual({ due: '2025-10-20', shifted: true })
    expect(listItemTodos(itemId)).toHaveLength(0)
    const bad = await callWorkbench(`${base()}/${appeal.key}/propose`, 'POST', { trigger: '' })
    expect(bad.body.error).toBe('deadline_bad_trigger')
    const ok = await callWorkbench(`${base()}/${appeal.key}/todo`, 'POST', { due: '2025-10-21' })
    expect(ok.status).toBe(201)
    expect(ok.body.todo.due_date).toBe('2025-10-21')

    const work = list().find((d) => d.relative?.unit === 'workday')!
    const w = await callWorkbench(`${base()}/${work.key}/propose`, 'POST', { trigger: '2025-10-03' })
    expect(w.body.error).toBe('deadline_workdays')
    expect(w.body.message).toContain('munkaszüneti')
    const cure = list().find((d) => d.topic === 'cure')!
    const notRel = await callWorkbench(`${base()}/${cure.key}/propose`, 'POST', { trigger: '2025-10-03' })
    expect(notRel.body.error).toBe('deadline_not_relative')
  })

  it('csak a tulajdonos; eltunt tetel; elrejtes es visszahozas; archivalt projekt', async () => {
    const cure = list().find((d) => d.topic === 'cure')!
    const agent = await callWorkbench(`${base()}/${cure.key}/todo`, 'POST', {}, undefined, { kind: 'token' })
    expect(agent.status).toBe(403)
    expect(agent.body.error).toBe('deadline_owner_only')
    const gone = await callWorkbench(`${base()}/deadbeefdeadbeef/todo`, 'POST', {})
    expect(gone.status).toBe(404)
    expect(gone.body.deadlines).toHaveLength(6)

    const dis = await callWorkbench(`${base()}/${cure.key}/dismiss`, 'POST', {})
    expect(dis.body.deadlines.find((d: { key: string }) => d.key === cure.key).dismissed).toBe(true)
    const back = await callWorkbench(`${base()}/${cure.key}/dismiss`, 'DELETE')
    expect(back.body.deadlines.find((d: { key: string }) => d.key === cure.key).dismissed).toBe(false)

    setProjectArchived(pid, true)
    const arch = await callWorkbench(`${base()}/${cure.key}/todo`, 'POST', {})
    expect(arch.status).toBe(409)
    // Olvasni archivalt projektben is lehet.
    expect((await callWorkbench(base(), 'GET')).body.deadlines).toHaveLength(6)
  })

  it('az agent latja (forrassal), de teendot ezen at nem vesz fel', () => {
    const r = executeTool('doc.deadlines', {}, { projectId: pid, workItemId: itemId, lang: 'hu' })
    expect(r.ok).toBe(true)
    const data = (r as { data: { deadlines: { topic: string; counts_from: unknown; page: number; hard_to_read_page: boolean }[]; note: string } }).data
    expect(data.deadlines.find((d) => d.topic === 'appeal')).toMatchObject({ counts_from: { amount: 15, unit: 'day', trigger: 'delivery' }, page: 2, hard_to_read_page: true })
    expect(data.note).toContain('NOT computed by you')
  })

  it('a munkadarab vegleges torlese a donteseket is viszi', async () => {
    const cure = list().find((d) => d.topic === 'cure')!
    await callWorkbench(`${base()}/${cure.key}/dismiss`, 'POST', {})
    setWorkItemDeleted(itemId, true)
    expect(purgeWorkItem(itemId).ok).toBe(true)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM wb_deadline_state').get() as { n: number }).n).toBe(0)
  })
})

describe('a felulet: hataridok', () => {
  it('lista forrassal; naptari: egy kattintas; kezdonaptol: kezbesites napja -> javaslat -> jovahagyott nap', async () => {
    const h = workbenchHarness({ confirm: true })
    const ITEM = { id: 'w1', title: 'Válasz', type: 'document', status: 'draft', current_version_id: 'v1', folder: 'Valasz', source_path: null }
    const DL = [
      { key: 'k1', kind: 'deadline', topic: 'cure', date: '2099-11-03', time: null, relative: null, quote: 'A hiánypótlást 2099. november 3-ig kell teljesíteni.', path: 'Valasz/vegzes.pdf', name: 'vegzes.pdf', page: 2, low: true, todo: null, dismissed: false },
      { key: 'k2', kind: 'deadline', topic: 'appeal', date: null, time: null, relative: { amount: 15, unit: 'day', trigger: 'delivery' }, quote: 'kézbesítéstől számított 15 napon belül', path: 'Valasz/vegzes.pdf', name: 'vegzes.pdf', page: 2, low: false, todo: null, dismissed: false },
      { key: 'k3', kind: 'hearing', topic: 'hearing', date: '2000-01-05', time: '09:00', relative: null, quote: 'tárgyalás', path: 'Valasz/vegzes.pdf', name: 'vegzes.pdf', page: 1, low: false, todo: null, dismissed: false },
      { key: 'k4', kind: 'deadline', topic: 'payment', date: '2099-12-01', time: null, relative: null, quote: 'fizesse meg', path: 'Valasz/vegzes.pdf', name: 'vegzes.pdf', page: 1, low: false, todo: null, dismissed: true },
    ]
    h.respond((url, init) => {
      if (url.includes('/deadlines/k2/propose')) return { status: 200, body: { proposal: { due: '2099-10-20', shifted: true } } }
      if (url.includes('/deadlines/')) return { status: 201, body: { ok: true, todo: { id: 't1', due_date: '2099-11-03' }, deadlines: DL, todos: [] } }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/') && !(init && init.method && init.method !== 'GET')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: [], outline: null, deadlines: DL } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      if (url.includes('/todos')) return { status: 200, body: { todos: [] } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-dl-box'))
    const html = h.html()
    expect(html).toContain('workbench.dl.title')
    expect(html).toContain('workbench.dl.topic.cure')
    expect(html).toContain('A hiánypótlást 2099. november 3-ig kell teljesíteni.')
    expect(html).toContain('workbench.dl.low')
    expect(html).toContain('data-wb-act="dl-todo" data-wb-key="k1"')
    expect(html).toContain('workbench.dl.need_trigger')
    expect(html).toContain('id="wbDlTrig-k2"')
    expect(html).not.toContain('id="wbDlDue-k2"')
    expect(html).toContain('workbench.dl.past_title')
    expect(html).toContain('workbench.dl.hidden_title')
    expect(html).toContain('data-wb-act="dl-undismiss" data-wb-key="k4"')

    h.click({ 'data-wb-act': 'dl-todo', 'data-wb-key': 'k1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/deadlines/k1/todo') && c.init?.method === 'POST')).toBe(true))
    const add = h.fetchCalls.find((c) => c.url.includes('/deadlines/k1/todo'))
    expect(JSON.parse(String(add?.init?.body))).toEqual({})
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.dl.todo_toast⟧'))

    // Kezbesites napja nelkul nem kerdez.
    h.click({ 'data-wb-act': 'dl-propose', 'data-wb-key': 'k2' })
    expect(h.toasts).toContain('⟦workbench.dl.trigger_missing⟧')
    h.inputs['wbDlTrig-k2'] = { value: '2099-10-03', focus() {} }
    h.click({ 'data-wb-act': 'dl-propose', 'data-wb-key': 'k2' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.dl.proposal'))
    expect(h.html()).toContain('workbench.dl.shifted')
    expect(h.html()).toContain('workbench.dl.check_holidays')
    expect(h.html()).toContain('id="wbDlDue-k2" value="2099-10-20"')
    h.inputs['wbDlDue-k2'] = { value: '2099-10-21', focus() {} }
    h.click({ 'data-wb-act': 'dl-todo', 'data-wb-key': 'k2' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/deadlines/k2/todo'))).toBe(true))
    const rel = h.fetchCalls.find((c) => c.url.includes('/deadlines/k2/todo'))
    expect(JSON.parse(String(rel?.init?.body))).toEqual({ due: '2099-10-21' })
  })
})
