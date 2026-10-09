// #441 (v4 spec 7.3, K-1.32 ... K-1.34): "Erzekeny" jeloles projekten es
// munkadarabon, a keresokifejezes szemelyesadat-szurese (minta + pontos
// nev-egyezes), a kimeno adatok naploja a meglevo naplokbol, es a felulet.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, getProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem, purgeWorkItem, setWorkItemDeleted } from '../workbench.js'
import { addSection, addBlock } from '../workbench-docmodel.js'
import {
  privacyState, setItemSensitive, setProjectSensitive, sensitiveItemIds, personalDataIn, knownNames, searchBlock,
  externalServiceAllowed, egressLog, recordImageAiCall, itemAiCost,
} from '../workbench-privacy.js'
import { runTool } from '../workbench-agent/execute.js'
import { buildContext } from '../workbench-agent/context.js'
import { createAgentSession, addAgentMessage, startToolCall, finishToolCall } from '../workbench-agent/sessions.js'
import { addTodo, ensureTodoTable } from '../workbench-todos.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

describe('erzekeny jeloles es szemelyes adat a keresesben', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-privacy-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    saved['MARVEEN_DEPOT'] = process.env['MARVEEN_DEPOT']
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: pid, title: 'Válaszbeadvány', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    const s = addSection(itemId, '1. Tényállás')
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'Az alperes, Kovács Anna, a Landgericht Berlin előtt pert indított ellenem.', author: 'agent' })
  })
  afterEach(() => {
    if (saved['MARVEEN_DEPOT'] === undefined) delete process.env['MARVEEN_DEPOT']
    else process.env['MARVEEN_DEPOT'] = saved['MARVEEN_DEPOT']
    rmSync(depot, { recursive: true, force: true })
  })

  it('a munkadarab es a projekt jelolese; a projekte minden munkadarabra all', () => {
    expect(privacyState(pid, itemId)).toEqual({ sensitive: false, item: false, project: false })
    setItemSensitive(itemId, true, 'teszt')
    expect(privacyState(pid, itemId)).toEqual({ sensitive: true, item: true, project: false })
    expect(sensitiveItemIds(pid)).toEqual([itemId])
    setItemSensitive(itemId, false, 'teszt')
    setProjectSensitive(pid, true, 'teszt')
    expect(privacyState(pid, itemId)).toEqual({ sensitive: true, item: false, project: true })
    expect(privacyState(pid, null).sensitive).toBe(true)
  })

  it('kulso fajl-szolgaltatas (kepszerkeszto, kulso szovegfelismeres) erzekenynel nem kaphatja meg; a kereses igen, szurve', () => {
    expect(externalServiceAllowed(pid, itemId, 'image_edit')).toBe(true)
    setItemSensitive(itemId, true, null)
    expect(externalServiceAllowed(pid, itemId, 'image_edit')).toBe(false)
    expect(externalServiceAllowed(pid, itemId, 'image_generate')).toBe(false)
    expect(externalServiceAllowed(pid, itemId, 'ocr_external')).toBe(false)
    expect(externalServiceAllowed(pid, itemId, 'web_search')).toBe(true)
  })

  it('szerkezetes szemelyes adat minta szerint', () => {
    const kinds = (q: string) => personalDataIn(q, []).map((h) => h.kind)
    expect(kinds('12.P.20.123/2025/4 végzés fellebbezés')).toContain('case_number')
    expect(kinds('Az 2 O 123/25 ügyben')).toContain('case_number')
    expect(kinds('case 1:23-cv-01234 docket')).toContain('case_number')
    expect(kinds('IBAN DE89 3704 0044 0532 0130 00 Rückbuchung')).toContain('iban')
    expect(kinds('számla 11773016-12345678 zárolás')).toContain('account')
    expect(kinds('kovacs.anna@example.com levél')).toContain('email')
    expect(kinds('hívd a +36 30 123 4567 számot')).toContain('phone')
    expect(kinds('Budapest, Fő utca 12 lakcím')).toContain('address')
    expect(kinds('1052 Budapest, Petőfi Sándor utca 5')).toContain('address')
    expect(kinds('Hauptstraße 5 Berlin Miete')).toContain('address')
    expect(kinds('szül. 1980.05.12 Budapest')).toContain('birth_date')
    // Altalanos jogi kerdes: nincs benne semmi.
    expect(personalDataIn('fellebbezési határidő polgári perben Magyarország', [])).toEqual([])
    expect(personalDataIn('Landgericht Berlin Zuständigkeit Mietsache', [])).toEqual([])
  })

  it('nevek pontos egyezessel: a munkadarab ismert nevei es a tulajdonos; az intezmeny nem nev; toldalekolt alak is talalat', () => {
    const names = knownNames(itemId)
    expect(names).toContain('Kovács Anna')
    expect(names).not.toContain('Landgericht Berlin')
    expect(personalDataIn('Kovács Annát beperelték, mi a teendő', names)).toEqual([{ kind: 'name', value: 'Kovács Anna' }])
    expect(personalDataIn('KOVACS ANNA pert indított', names).map((h) => h.kind)).toEqual(['name'])
    expect(personalDataIn('Landgericht Berlin Zuständigkeit', names)).toEqual([])
  })

  it('a kereses csak erzekenynel all meg; az agent megtudja, mit kell kihagynia', async () => {
    expect(searchBlock(pid, itemId, 'Kovács Anna per')).toBe(null)
    setItemSensitive(itemId, true, null)
    expect(searchBlock(pid, itemId, 'Kovács Anna per')).toEqual([{ kind: 'name', value: 'Kovács Anna' }])
    expect(searchBlock(pid, itemId, 'polgári per fellebbezési határidő')).toBe(null)
    const r = await runTool('web.search', { query: 'Kovács Anna 12.P.20.123/2025/4' }, { projectId: pid, workItemId: itemId, lang: 'hu' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('sensitive_personal_data')
    expect(!r.ok && r.detail).toContain('Kovács Anna')
    expect(!r.ok && r.detail).toContain('12.P.20.123/2025/4')
  })

  it('az agent kontextusa csak erzekenynel kap jelzest', async () => {
    const project = getProject(pid)!
    const item = getWorkItem(itemId)!
    expect((await buildContext(project, item, 'hu')).parts.some((p) => p.key === 'privacy')).toBe(false)
    setProjectSensitive(pid, true, null)
    const c = await buildContext(project, item, 'hu')
    expect(c.parts.some((p) => p.key === 'privacy')).toBe(true)
    expect(c.contextText).toContain('SENSITIVE')
  })

  it('a munkadarab vegleges torlesevel a jelolese is megy', () => {
    setItemSensitive(itemId, true, null)
    setWorkItemDeleted(itemId, true)
    expect(purgeWorkItem(itemId).ok).toBe(true)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM wb_item_privacy').get()).toEqual({ n: 0 })
  })

  it('K-1.33 + K-X.1: a kepszerkeszto AI hivasa bekerul a naploba, a munkadarab AI-koltsege osszesitve latszik, torleskor eltunik', () => {
    expect(itemAiCost(itemId)).toEqual({ usd: 0, calls: 0, unknown: 0 })
    recordImageAiCall(itemId, { model: 'gemini-x', file: 'Freeber/auto.png', instruction_chars: 20, cost_usd: 0.039, status: 'sent' })
    recordImageAiCall(itemId, { model: 'gemini-x', file: 'Freeber/auto-ai.png', instruction_chars: 10, cost_usd: 0.04, status: 'sent' })
    recordImageAiCall(itemId, { model: 'gemini-y', file: 'Freeber/logo.png', instruction_chars: 10, cost_usd: null, status: 'sent' })
    recordImageAiCall(itemId, { model: 'gemini-x', file: 'Freeber/x.png', instruction_chars: 10, cost_usd: null, status: 'failed' })
    // a sikertelen hivas nem szamit koltsegnek, az ismeretlen arut kulon jelzi
    expect(itemAiCost(itemId)).toEqual({ usd: 0.079, calls: 3, unknown: 1 })
    const rows = egressLog(itemId).filter((r) => r.service === 'image_ai')
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.status).sort()).toEqual(['failed', 'sent', 'sent', 'sent'])
    expect(rows.find((r) => r.file === 'Freeber/auto.png')).toMatchObject({ model: 'gemini-x', cost_usd: 0.039 })
    expect(purgeWorkItem(itemId).ok).toBe(false)
    setWorkItemDeleted(itemId, true)
    expect(purgeWorkItem(itemId).ok).toBe(true)
    expect(itemAiCost(itemId).calls).toBe(0)
  })

  it('kimeno adatok naploja (K-1.33): Agent-kor az olvasott fajlokkal, kereses (letiltott is), teljes erteku ugynok, Google Naptar', () => {
    expect(egressLog(itemId)).toEqual([])
    const s = createAgentSession({ project_id: pid, work_item_id: itemId })
    const db = getDb()
    const at = (table: string, id: string, col: string, v: number) => db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(v, id)
    const u1 = addAgentMessage(s.id, 'user', 'Olvasd el a levelet.')
    at('workbench_agent_messages', u1.id, 'created_at', 1000)
    const c1 = startToolCall(s.id, 'file.read', { path: 'Level/idezes.pdf' })
    finishToolCall(c1.id, 'ok', { ok: true })
    at('workbench_agent_tool_calls', c1.id, 'started_at', 1001)
    const c2 = startToolCall(s.id, 'web.search', { query: 'Kovács Anna per' })
    finishToolCall(c2.id, 'error', { ok: false, code: 'sensitive_personal_data' })
    at('workbench_agent_tool_calls', c2.id, 'started_at', 1002)
    const c3 = startToolCall(s.id, 'web.search', { query: 'fellebbezési határidő' })
    finishToolCall(c3.id, 'ok', { ok: true })
    at('workbench_agent_tool_calls', c3.id, 'started_at', 1003)
    const a1 = addAgentMessage(s.id, 'assistant', 'Elolvastam.', { model: 'm', via: { kind: 'account', account: 'usalackor' } })
    at('workbench_agent_messages', a1.id, 'created_at', 1004)
    // A teljes erteku ugynok kore: a valasznak nincs "melyik fiokon" jelolese.
    const u2 = addAgentMessage(s.id, 'user', 'Most te.')
    at('workbench_agent_messages', u2.id, 'created_at', 2000)
    const a2 = addAgentMessage(s.id, 'assistant', 'Kész.')
    at('workbench_agent_messages', a2.id, 'created_at', 2005)
    ensureTodoTable()
    const td = addTodo({ work_item_id: itemId, text: 'Fellebbezés beadása', due_date: '2027-03-01' })
    if (!td.ok) throw new Error('teendo')
    db.prepare("UPDATE work_item_todos SET gcal_event_id = 'e1', gcal_account = 'lackor2@example.com', gcal_synced_at = 3000 WHERE id = ?").run(td.todo.id)

    const log = egressLog(itemId)
    expect(log.map((r) => [r.at, r.service, r.status])).toEqual([
      [3000, 'google_calendar', 'sent'],
      [2000, 'claude_code', 'sent'],
      [1003, 'web_search', 'sent'],
      [1002, 'web_search', 'blocked'],
      [1000, 'claude', 'sent'],
    ])
    expect(log[4]).toMatchObject({ account: 'usalackor', message_chars: 'Olvasd el a levelet.'.length, files: ['Level/idezes.pdf'] })
    expect(log[3]!.query).toBe('Kovács Anna per')
    expect(log[0]).toMatchObject({ todo: 'Fellebbezés beadása', due: '2027-03-01', account: 'lackor2@example.com' })
  })

  it('utvonalak: allapot + naplo; bekapcsolni az agent is tud, kikapcsolni csak a tulajdonos; projekt-szint; lista es reszletek', async () => {
    const base = `/api/workbench/items/${itemId}/privacy`
    const g = await callWorkbench(base, 'GET')
    expect(g.status).toBe(200)
    expect(g.body).toMatchObject({ privacy: { sensitive: false }, egress: [], ocr: 'local' })
    expect((await callWorkbench(base, 'PUT', { sensitive: 'yes' })).status).toBe(400)
    const on = await callWorkbench(base, 'PUT', { sensitive: true }, undefined, { kind: 'token' })
    expect(on.status).toBe(200)
    expect(on.body.privacy.item).toBe(true)
    const offAgent = await callWorkbench(base, 'PUT', { sensitive: false }, undefined, { kind: 'token' })
    expect(offAgent.status).toBe(403)
    expect(offAgent.body.message).toContain('csak te')
    expect((await callWorkbench(base, 'PUT', { sensitive: false })).body.privacy.item).toBe(false)
    const pp = await callWorkbench(`/api/workbench/privacy?project=${pid}`, 'PUT', { sensitive: true })
    expect(pp.status).toBe(200)
    expect(pp.body.privacy.project).toBe(true)
    expect((await callWorkbench(`/api/workbench/privacy?project=nincs`, 'GET')).status).toBe(404)
    const list = await callWorkbench(`/api/workbench/items?project=${pid}`, 'GET')
    expect(list.body.project.sensitive).toBe(true)
    expect(list.body.sensitive_items).toEqual([])
    const detail = await callWorkbench(`/api/workbench/items/${itemId}`, 'GET')
    expect(detail.body.privacy).toEqual({ sensitive: true, item: false, project: true })
  })
})

describe('a felulet: erzekeny jeloles es technikai reszletek', () => {
  const ITEM = { id: 'w1', title: 'Beadvány', type: 'note', status: 'draft', current_version_id: 'v1', folder: 'Beadvany', source_path: null }
  const EGRESS = [
    { at: 2000, service: 'web_search', account: null, query: 'Kovács Anna per', status: 'blocked' },
    { at: 1000, service: 'claude', account: 'usalackor', message_chars: 12, files: ['Level/idezes.pdf'], status: 'sent' },
  ]

  async function open(privacy: Record<string, boolean>, project: Record<string, unknown> = { id: 'p1', name: 'Iroda', archived: false, sensitive: false }) {
    const h = workbenchHarness({ confirm: true })
    h.respond((url, init) => {
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/w1/privacy') && init?.method === 'PUT') return { status: 200, body: { ok: true, privacy: { sensitive: true, item: true, project: false } } }
      if (url.includes('/api/workbench/privacy')) return { status: 200, body: { ok: true, privacy: { sensitive: true, item: false, project: true }, sensitive_items: [] } }
      if (url.includes('/w1/privacy')) return { status: 200, body: { privacy, egress: EGRESS, ocr: 'local' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: [], privacy } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: { ...itemsBody([ITEM], project), sensitive_items: privacy['item'] ? ['w1'] : [] } }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="tech-toggle"'))
    return h
  }

  it('nem jelolt munkadarab: bekapcsolo gomb; kattintasra PUT, utana lakat a listaban', async () => {
    const h = await open({ sensitive: false, item: false, project: false })
    expect(h.html()).toContain('workbench.privacy.item_off')
    expect(h.html()).not.toContain('class="wb-lock"')
    h.click({ 'data-wb-act': 'privacy-item', 'data-wb-on': '1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/w1/privacy') && c.init?.method === 'PUT')).toBe(true))
    const put = h.fetchCalls.find((c) => c.url.includes('/w1/privacy') && c.init?.method === 'PUT')
    expect(JSON.parse(String(put?.init?.body))).toEqual({ sensitive: true })
    await vi.waitFor(() => expect(h.html()).toContain('class="wb-lock"'))
    expect(h.html()).toContain('workbench.privacy.hint')
  })

  it('a projekt jelolese miatt erzekeny: nincs munkadarab-kapcsolo, a projekt kikapcsolhato', async () => {
    const h = await open({ sensitive: true, item: false, project: true }, { id: 'p1', name: 'Iroda', archived: false, sensitive: true })
    const html = h.html()
    expect(html).toContain('workbench.privacy.item_from_project')
    expect(html).not.toContain('data-wb-act="privacy-item"')
    expect(html).toContain('data-wb-act="privacy-project" data-wb-on="0"')
  })

  it('technikai reszletek: a naplo sorai (a letiltott kereses is), a helyi szovegfelismeres', async () => {
    const h = await open({ sensitive: true, item: true, project: false })
    h.click({ 'data-wb-act': 'tech-toggle' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-egress'))
    const html = h.html()
    expect(html).toContain('workbench.egress.ocr_local')
    expect(html).toContain('workbench.egress.service.web_search')
    expect(html).toContain('workbench.egress.blocked')
    expect(html).toContain('workbench.egress.service.claude')
    expect(html).toContain('Level/idezes.pdf')
  })
})
