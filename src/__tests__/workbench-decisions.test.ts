// #406, 10. pont -- DONTESNAPLO: a szerver (tarolas, visszavonas, korlatok),
// az agens (latja es rogzit) ES a felulet (mit lat es mit kuld a felhasznalo).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createProject, getProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import {
  addDecision, listDecisions, updateDecision, setDecisionRevoked, decisionsForContext,
  DECISION_MAX_CHARS, DECISIONS_MAX_ACTIVE,
} from '../workbench-decisions.js'
import { buildContext } from '../workbench-agent/context.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import type { RouteContext } from '../web/routes/types.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

async function call(method: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const chunks: Buffer[] = []
  const out = { status: 200 }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const done = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (s: number) => { out.status = s; return res }
  res.setHeader = () => res
  const req: any = Readable.from([Buffer.from(body == null ? '' : JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: 'session', user: 'teszt' } } as unknown as RouteContext
  if (await tryHandleWorkbench(ctx)) await done
  const s = Buffer.concat(chunks).toString('utf-8')
  return { status: out.status, body: s ? JSON.parse(s) : null }
}

let pid = ''
let other = ''

describe('dontesnaplo: a szerver', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const a = createProject({ name: 'Kovács weboldal' })
    const b = createProject({ name: 'Másik' })
    if (!a.ok || !b.ok) throw new Error('projekt')
    pid = a.project.id
    other = b.project.id
  })

  it('friss telepites: ures lista, es az agens-kontextus KIMONDJA, hogy meg nincs', () => {
    expect(listDecisions(pid)).toEqual([])
    expect(decisionsForContext(pid)).toMatch(/none recorded yet/)
  })

  it('rogzites, projektenkent kulon; a legfrissebb elol', () => {
    addDecision({ project_id: pid, text: '  A logó   kék marad. ', by: 'teszt' })
    addDecision({ project_id: pid, text: 'Tegező a szöveg.' })
    addDecision({ project_id: other, text: 'Idegen döntés' })
    const list = listDecisions(pid)
    expect(list.map((d) => d.text).sort()).toEqual(['A logó kék marad.', 'Tegező a szöveg.'])
    expect(list.every((d) => d.project_id === pid)).toBe(true)
    expect(list.find((d) => d.text === 'A logó kék marad.')!.created_by).toBe('teszt')
  })

  it('ures, tul hosszu, idegen munkadarab: elutasitva, semmi nem kerul be', () => {
    expect(addDecision({ project_id: pid, text: '   ' })).toEqual({ ok: false, code: 'text_required' })
    expect(addDecision({ project_id: pid, text: 'x'.repeat(DECISION_MAX_CHARS + 1) })).toEqual({ ok: false, code: 'text_too_long' })
    const w = createWorkItem({ project_id: other, title: 'Idegen', type: 'note' })
    if (!w.ok) throw new Error('item')
    expect(addDecision({ project_id: pid, text: 'x', work_item_id: w.item.id })).toEqual({ ok: false, code: 'item_not_in_project' })
    expect(listDecisions(pid)).toEqual([])
  })

  it('visszavonas: a sor megmarad (athuzva), az agens mar nem kapja; visszaallithato', () => {
    const r = addDecision({ project_id: pid, text: 'A logó kék marad.' })
    if (!r.ok) throw new Error('add')
    setDecisionRevoked(r.decision.id, true)
    expect(listDecisions(pid)).toEqual([])
    expect(listDecisions(pid, { includeRevoked: true })[0].revoked_at).not.toBeNull()
    expect(decisionsForContext(pid)).toMatch(/none recorded yet/)
    setDecisionRevoked(r.decision.id, false)
    expect(decisionsForContext(pid)).toContain('A logó kék marad.')
    const u = updateDecision(r.decision.id, 'A logó sötétkék marad.')
    expect(u.ok && u.decision.text).toBe('A logó sötétkék marad.')
    expect(updateDecision('nincs', 'x')).toEqual({ ok: false, code: 'not_found' })
  })

  it('felso hatar az ervenyes dontesekre', () => {
    for (let i = 0; i < DECISIONS_MAX_ACTIVE; i++) addDecision({ project_id: pid, text: `d${i}` })
    expect(addDecision({ project_id: pid, text: 'egy tobb' })).toEqual({ ok: false, code: 'too_many' })
  })

  it('route: lista (visszavontakkal), rogzites, javitas, visszavonas; emberi mondat a hibanal', async () => {
    const empty = await call('GET', `/api/workbench/decisions?project=${pid}`, null)
    expect(empty.status).toBe(200)
    expect(empty.body.decisions).toEqual([])

    const bad = await call('POST', '/api/workbench/decisions', { project: pid, text: '' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('decision_text_required')
    expect(bad.body.message.length).toBeGreaterThan(10)

    const add = await call('POST', '/api/workbench/decisions', { project: pid, text: 'A logó kék marad.' })
    expect(add.status).toBe(200)
    expect(add.body.decision).toMatchObject({ text: 'A logó kék marad.', created_by: 'teszt', source: 'owner' })
    const id = add.body.decision.id

    const ed = await call('PATCH', `/api/workbench/decisions/${id}`, { text: 'A logó kék.' })
    expect(ed.body.decision.text).toBe('A logó kék.')
    const rv = await call('PATCH', `/api/workbench/decisions/${id}`, { revoked: true })
    expect(rv.body.decision.revoked_at).not.toBeNull()
    const all = await call('GET', `/api/workbench/decisions?project=${pid}`, null)
    expect(all.body.decisions).toHaveLength(1)

    expect((await call('PATCH', '/api/workbench/decisions/nincs', { text: 'x' })).status).toBe(404)
    expect((await call('GET', '/api/workbench/decisions?project=nincs', null)).status).toBe(404)
  })
})

describe('dontesnaplo: a Munkapad-agens', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const a = createProject({ name: 'Kovács weboldal' })
    if (!a.ok) throw new Error('projekt')
    pid = a.project.id
  })
  const ctx = () => ({ projectId: pid, workItemId: null, lang: 'hu' as const })

  it('a kontextusban ott vannak az ervenyes dontesek, es a szabaly, hogy kovesse oket', () => {
    addDecision({ project_id: pid, text: 'A logó kék marad.' })
    const c = buildContext(getProject(pid)!, null, 'hu')
    expect(c.contextText).toContain('A logó kék marad.')
    expect(c.parts.some((p) => p.key === 'decisions')).toBe(true)
    expect(c.system).toContain('decision.record')
  })

  it('decision.record: EHHEZ a projekthez rogzit, agens-forrassal; ures szoveg hibat ad', () => {
    expect(getTool('decision.record')?.autonomyCategory).toBe('marveen_selfdev')
    expect(getTool('decision.list')?.autonomyCategory).toBeNull()
    const r = executeTool('decision.record', { text: 'Péntekig kész a szöveg.' }, ctx())
    expect(r).toMatchObject({ ok: true, data: { text: 'Péntekig kész a szöveg.', project: pid } })
    expect(listDecisions(pid)[0]).toMatchObject({ source: 'agent' })
    expect(executeTool('decision.record', { text: ' ' }, ctx())).toMatchObject({ ok: false, code: 'bad_input' })
    const l = executeTool('decision.list', {}, ctx())
    expect(l).toMatchObject({ ok: true, data: { count: 1 } })
  })

  it('decision.list ures projektnel kimondja, hogy meg nincs', () => {
    const r = executeTool('decision.list', {}, ctx())
    expect(r).toMatchObject({ ok: true, data: { count: 0 } })
    expect((r as any).data.note).toMatch(/no decision/)
  })
})

describe('dontesnaplo: a felulet', () => {
  const D = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    id, project_id: 'p1', work_item_id: null, text, created_by: 'teszt', source: 'owner',
    created_at: 100, updated_at: 100, revoked_at: null, ...extra,
  })

  function open(h: ReturnType<typeof workbenchHarness>, list: unknown, write?: (url: string, body: any) => { status: number; body: unknown }) {
    h.respond((url, init) => {
      if (url.includes('/api/workbench/decisions') && init?.method && init.method !== 'GET') {
        return write ? write(url, JSON.parse(String(init.body || '{}'))) : { status: 200, body: {} }
      }
      if (url.includes('/api/workbench/decisions')) {
        if (list && typeof list === 'object' && 'status' in (list as any)) return list as any
        return { status: 200, body: { decisions: list, max_chars: 500, max_active: 200 } }
      }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'dec-open' })
  }

  const writes = (h: ReturnType<typeof workbenchHarness>) =>
    h.fetchCalls.filter((c) => c.url.includes('/api/workbench/decisions') && c.init?.method && c.init.method !== 'GET')
      .map((c) => ({ method: c.init!.method, url: c.url.split('?')[0], body: JSON.parse(String(c.init!.body)) }))

  it('ures naplo: magyarazat + urlap, nem hibauzenet; rogzites elkuldi es megjeleniti', async () => {
    const h = workbenchHarness()
    open(h, [], (_u, body) => ({ status: 200, body: { decision: D('d1', body.text) } }))
    await vi.waitFor(() => expect(h.html()).toContain('workbench.dec.empty'))
    expect(h.html()).toContain('workbench.dec.intro')
    expect(h.html()).toContain('id="wbDecForm"')
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal'])).toBe('')
    h.inputs.wbDecText = { value: ' A logó kék marad. ', focus() {} }
    h.fire('submit', { target: { id: 'wbDecForm' }, preventDefault() {} })
    await vi.waitFor(() => expect(h.html()).toContain('A logó kék marad.'))
    expect(writes(h)).toEqual([{ method: 'POST', url: '/api/workbench/decisions', body: { project: 'p1', text: 'A logó kék marad.' } }])
    expect(h.toasts).toContain('⟦workbench.dec.toast.add⟧')
  })

  it('ures szoveggel nem kuld semmit, helyben szol', async () => {
    const h = workbenchHarness()
    open(h, [])
    await vi.waitFor(() => expect(h.html()).toContain('id="wbDecForm"'))
    h.inputs.wbDecText = { value: '  ', focus() {} }
    h.fire('submit', { target: { id: 'wbDecForm' }, preventDefault() {} })
    expect(h.toasts).toContain('⟦workbench.dec.empty_text⟧')
    expect(writes(h)).toEqual([])
  })

  it('ervenyes es visszavont kulon; visszavonas rakerdez, visszaallitas nem', async () => {
    const h = workbenchHarness()
    open(h, [D('d1', 'Kék logó'), D('d2', 'Régi betűtípus', { revoked_at: 200, source: 'agent' })],
      (url, body) => ({ status: 200, body: { decision: D(url.includes('d1') ? 'd1' : 'd2', url.includes('d1') ? 'Kék logó' : 'Régi betűtípus', { revoked_at: body.revoked ? 300 : null }) } }))
    await vi.waitFor(() => expect(h.html()).toContain('Kék logó'))
    const html = h.html()
    expect(html).toContain('workbench.dec.revoked_head')
    expect(html).toContain('wb-dec-revoked')
    expect(html).toContain('workbench.dec.by_agent')
    expect(html).toContain('data-wb-act="dec-restore" data-wb-dec="d2"')
    h.click({ 'data-wb-act': 'dec-revoke', 'data-wb-dec': 'd1' })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.dec.toast.revoke⟧'))
    expect(writes(h)[0]).toEqual({ method: 'PATCH', url: '/api/workbench/decisions/d1', body: { revoked: true } })
    expect(h.html()).toContain('workbench.dec.none_active')
  })

  it('visszavonas megse: nem kuld semmit', async () => {
    const h = workbenchHarness({ confirm: false })
    open(h, [D('d1', 'Kék logó')])
    await vi.waitFor(() => expect(h.html()).toContain('Kék logó'))
    h.click({ 'data-wb-act': 'dec-revoke', 'data-wb-dec': 'd1' })
    await new Promise((r) => setTimeout(r, 10))
    expect(writes(h)).toEqual([])
  })

  it('javitas: szerkesztomezo, a mentes a javitott szoveget kuldi', async () => {
    const h = workbenchHarness()
    open(h, [D('d1', 'Kék logó')], (_u, body) => ({ status: 200, body: { decision: D('d1', body.text) } }))
    await vi.waitFor(() => expect(h.html()).toContain('Kék logó'))
    h.click({ 'data-wb-act': 'dec-edit', 'data-wb-dec': 'd1' })
    expect(h.html()).toContain('id="wbDecEditForm"')
    h.inputs.wbDecEditText = { value: 'Sötétkék logó', focus() {} }
    h.fire('submit', { target: { id: 'wbDecEditForm' }, preventDefault() {} })
    await vi.waitFor(() => expect(h.html()).toContain('Sötétkék logó'))
    expect(writes(h)).toEqual([{ method: 'PATCH', url: '/api/workbench/decisions/d1', body: { text: 'Sötétkék logó' } }])
    expect(h.html()).not.toContain('id="wbDecEditForm"')
  })

  it('betoltesi hiba: a szerver mondata, NEM az "ures" szoveg', async () => {
    const h = workbenchHarness()
    open(h, { status: 500, body: { error: 'x', message: 'Belső hiba' } })
    await vi.waitFor(() => expect(h.html()).toContain('Belső hiba'))
    expect(h.html()).not.toContain('workbench.dec.empty')
  })

  it('iras hiba: a szerver mondata latszik toastban', async () => {
    const h = workbenchHarness()
    open(h, [], () => ({ status: 400, body: { error: 'decision_text_too_long', message: 'A döntés túl hosszú.' } }))
    await vi.waitFor(() => expect(h.html()).toContain('id="wbDecForm"'))
    h.inputs.wbDecText = { value: 'x', focus() {} }
    h.fire('submit', { target: { id: 'wbDecForm' }, preventDefault() {} })
    await vi.waitFor(() => expect(h.toasts).toContain('A döntés túl hosszú.'))
  })
})
