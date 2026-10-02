// #441, K-3.1 -- BELEPO: "Mit szeretnel letrehozni?". Az osztalyozo (egy mondat ->
// munkatipus, vagy visszakerdezes), a vegpont, es a felulet vegig: mondat ->
// kerdes -> valasztas -> megnyilo munkadarab -> a mondat az Agenthez megy.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import { listWorkItems } from '../workbench.js'
import { guessIntakeKind, intakeTitle, INTAKE_KINDS } from '../workbench-intake.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import type { RouteContext } from '../web/routes/types.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
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

describe('belepo: az osztalyozo', () => {
  it('egyertelmu mondat: egy tipus, harom nyelven, ragozva is', () => {
    expect(guessIntakeKind('Facebook-poszt a jövő heti nyílt napról')).toEqual({ sure: true, kind: 'social_post' })
    expect(guessIntakeKind('Fellebbezés a végzés ellen')).toEqual({ sure: true, kind: 'court_filing' })
    expect(guessIntakeKind('Ajánlat Kovács úrnak a tetőjavításra')).toEqual({ sure: true, kind: 'document' })
    expect(guessIntakeKind('Rövid videó a műhelyről')).toEqual({ sure: true, kind: 'video' })
    expect(guessIntakeKind('Prezentáció a közgyűlésre')).toEqual({ sure: true, kind: 'presentation' })
    expect(guessIntakeKind('Berufung gegen das Urteil')).toEqual({ sure: true, kind: 'court_filing' })
    expect(guessIntakeKind('An Instagram post for the new shop')).toEqual({ sure: true, kind: 'social_post' })
  })

  it('semmi fogodzo: nem talalgat, mind az ot tipust kinalja', () => {
    expect(guessIntakeKind('valami a jövő hétre')).toEqual({ sure: false, options: [...INTAKE_KINDS] })
    expect(guessIntakeKind('')).toEqual({ sure: false, options: [...INTAKE_KINDS] })
  })

  it('beadvany + mas tipus: rakerdez a kettore', () => {
    const g = guessIntakeKind('Levél a bíróságnak')
    expect(g.sure).toBe(false)
    if (!g.sure) expect([...g.options].sort()).toEqual(['court_filing', 'document'])
    const p = guessIntakeKind('Facebook-poszt a perről')
    expect(p.sure).toBe(false)
  })

  it('a cim az elso mondat, roviditve; ures mondatnal a tipus neve', () => {
    expect(intakeTitle('Poszt a nyílt napról. Legyen vidám.', 'social_post', 'hu')).toBe('Poszt a nyílt napról.')
    expect(intakeTitle('x '.repeat(100), 'document', 'hu').length).toBeLessThanOrEqual(80)
    expect(intakeTitle('', 'court_filing', 'hu')).toBe('Új bírósági beadvány')
    expect(intakeTitle('', 'video', 'en')).toBe('New video')
  })
})

describe('belepo: a vegpont', () => {
  let pid = ''
  beforeEach(() => {
    initDatabase(':memory:')
    const a = createProject({ name: 'Kovács weboldal' })
    if (!a.ok) throw new Error('projekt')
    pid = a.project.id
  })

  it('egyertelmu mondat: munkadarab a mondat cimevel, a mondat a prompt', async () => {
    const r = await call('POST', '/api/workbench/intake?lang=hu', { project_id: pid, text: 'Instagram poszt az akcióról' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ ok: true, ask: false, kind: 'social_post', item: { title: 'Instagram poszt az akcióról', type: 'graphic', created_by: 'teszt' } })
    expect(listWorkItems(pid)).toHaveLength(1)
  })

  it('bizonytalan mondat: visszakerdez, es SEMMI nem jon letre', async () => {
    const r = await call('POST', '/api/workbench/intake?lang=hu', { project_id: pid, text: 'Levél a bíróságnak' })
    expect(r.status).toBe(200)
    expect(r.body.ask).toBe(true)
    expect(r.body.options).toContain('court_filing')
    expect(r.body.message).toMatch(/Nem vagyok biztos/)
    expect(listWorkItems(pid)).toEqual([])
  })

  it('gomb (kind): mondat nelkul is letrejon; a prezentacio sajat fajta (diasor)', async () => {
    const b = await call('POST', '/api/workbench/intake?lang=hu', { project_id: pid, kind: 'court_filing' })
    expect(b.status).toBe(201)
    expect(b.body.item).toMatchObject({ title: 'Új bírósági beadvány', type: 'document' })
    const p = await call('POST', '/api/workbench/intake?lang=hu', { project_id: pid, kind: 'presentation', text: 'Diák a közgyűlésre' })
    expect(p.body.item.type).toBe('presentation')
    expect(p.body.message).toBeNull()
  })

  it('hibak emberi mondattal: ures, nincs projekt, archivalt projekt', async () => {
    const e = await call('POST', '/api/workbench/intake?lang=hu', { project_id: pid, text: '  ' })
    expect(e.status).toBe(400)
    expect(e.body.message).toMatch(/egy mondatban/)
    expect((await call('POST', '/api/workbench/intake?lang=en', { project_id: 'nincs', text: 'x' })).status).toBe(404)
    setProjectArchived(pid, true)
    expect((await call('POST', '/api/workbench/intake?lang=hu', { project_id: pid, kind: 'video' })).status).toBe(409)
  })
})

describe('belepo: a felulet', () => {
  function open(h: ReturnType<typeof workbenchHarness>, intake: (body: any) => { status: number; body: unknown }) {
    h.respond((url, init) => {
      if (url.includes('/api/workbench/intake')) return intake(JSON.parse(String(init?.body || '{}')))
      if (url.includes('/api/workbench/agent/message')) return { status: 200, body: '', stream: { chunks: ['event: done\ndata: {}\n\n'] } }
      if (url.includes('/api/workbench/agent/')) return { status: 200, body: { session: null, messages: [] } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: { id: 'w1', title: 'Poszt', type: 'graphic' }, versions: [], parts: [] } }
      if (url.includes('/api/workbench/templates')) return { status: 200, body: { templates: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  }
  const intakes = (h: ReturnType<typeof workbenchHarness>) =>
    h.fetchCalls.filter((c) => c.url.includes('/api/workbench/intake')).map((c) => JSON.parse(String(c.init!.body)))

  it('"+ Uj munka": a kerdes, a mezo es az ot gomb; a regi urlap osszecsukva megmarad', async () => {
    const h = workbenchHarness()
    open(h, () => ({ status: 500, body: {} }))
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="new"'))
    h.click({ 'data-wb-act': 'new' })
    const html = h.html()
    expect(html).toContain('workbench.intake.title')
    expect(html).toContain('id="wbIntakeText"')
    for (const k of INTAKE_KINDS) expect(html).toContain(`data-wb-kind="${k}"`)
    expect(html).toContain('<details class="wb-new-manual">')
    expect(html).toContain('wbNewForm')
  })

  it('bizonytalan mondat: a felulet a felkinalt tipusokat mutatja, a mondat megmarad; valasztasra letrejon es az Agenthez megy', async () => {
    const h = workbenchHarness()
    open(h, (b) => b.kind
      ? { status: 201, body: { ok: true, ask: false, kind: b.kind, item: { id: 'w1', title: 'Levél a bíróságnak' }, versions: [], message: null } }
      : { status: 200, body: { ok: true, ask: true, options: ['court_filing', 'document'], message: 'Nem vagyok biztos benne.' } })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="new"'))
    h.click({ 'data-wb-act': 'new' })
    h.fire('input', { target: { id: 'wbIntakeText', value: 'Levél a bíróságnak' } })
    h.click({ 'data-wb-act': 'intake-go' })
    await vi.waitFor(() => expect(h.html()).toContain('Nem vagyok biztos benne.'))
    expect(h.html()).toContain('data-wb-kind="court_filing"')
    expect(h.html()).not.toContain('data-wb-kind="video"')
    expect(h.html()).toContain('Levél a bíróságnak</textarea>')

    h.click({ 'data-wb-act': 'intake-kind', 'data-wb-kind': 'court_filing' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/agent/message'))).toBe(true))
    expect(intakes(h)).toEqual([
      { project_id: 'p1', text: 'Levél a bíróságnak' },
      { project_id: 'p1', text: 'Levél a bíróságnak', kind: 'court_filing' },
    ])
    const msg = h.fetchCalls.find((c) => c.url.includes('/api/workbench/agent/message'))!
    expect(JSON.parse(String(msg.init!.body))).toMatchObject({ project_id: 'p1', work_item_id: 'w1', message: 'Levél a bíróságnak' })
    expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/w1'))).toBe(true)
  })

  it('ures mezo + "Mehet": nem kuld semmit, csak szol', async () => {
    const h = workbenchHarness()
    open(h, () => ({ status: 500, body: {} }))
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="new"'))
    h.click({ 'data-wb-act': 'new' })
    h.click({ 'data-wb-act': 'intake-go' })
    expect(h.toasts).toContain('⟦workbench.intake.empty⟧')
    expect(intakes(h)).toEqual([])
  })

  it('gomb mondat nelkul: letrehozza, de az Agentnek nem kuld ures uzenetet', async () => {
    const h = workbenchHarness()
    open(h, (b) => ({ status: 201, body: { ok: true, ask: false, kind: b.kind, item: { id: 'w1', title: 'Új videó' }, versions: [], message: null } }))
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="new"'))
    h.click({ 'data-wb-act': 'new' })
    h.click({ 'data-wb-act': 'intake-kind', 'data-wb-kind': 'video' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/w1'))).toBe(true))
    expect(intakes(h)).toEqual([{ project_id: 'p1', text: '', kind: 'video' }])
    expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/agent/message'))).toBe(false)
  })
})
