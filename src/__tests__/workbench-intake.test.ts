// #441, K-3.1 -- BELEPO: "Mit szeretnel letrehozni?". Az osztalyozo (egy mondat ->
// munkatipus, vagy visszakerdezes), a vegpont, es a felulet vegig: mondat ->
// kerdes -> valasztas -> megnyilo munkadarab -> a mondat az Agenthez megy.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCodeBridgePrompt } from '../workbench-agent/code-bridge-turn.js'
import { initDatabase } from '../db.js'
import { createProject, setProjectArchived, updateProject } from '../projects.js'
import { listWorkItems, createWorkItem } from '../workbench.js'
import { executeTool } from '../workbench-agent/execute.js'
import { buildPreview } from '../workbench-preview.js'
import { guessIntakeKind, intakeTitle, INTAKE_KINDS, INTAKE_TYPE } from '../workbench-intake.js'
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

describe('belepo: md / jegyzet kerese (Boss, TG 7276)', () => {
  it('az osztalyozo egy md-kerest jegyzetnek ismer fel (nem gomb), a cim fix es rovid', () => {
    expect(guessIntakeKind('szeretnék egy md filet csinálni és beleírni hogy szia')).toEqual({ sure: true, kind: 'note' })
    expect(guessIntakeKind('Make a markdown note about the meeting')).toEqual({ sure: true, kind: 'note' })
    expect(guessIntakeKind('Jegyzet a tegnapi megbeszélésről')).toEqual({ sure: true, kind: 'note' })
    expect(intakeTitle('szeretnék egy md filet csinálni és beleírni hogy szia', 'note', 'hu')).toBe('Új jegyzet')
    expect(intakeTitle('x', 'note', 'en')).toBe('New note')
    // A gombos lista: öt eredeti fajta + a névjegykártya.
    expect([...INTAKE_KINDS]).toHaveLength(6)
  })

  describe('a vegpont', () => {
    let depot = ''
    let pid = ''
    beforeEach(() => {
      initDatabase(':memory:')
      depot = mkdtempSync(join(tmpdir(), 'marveen-wb-intake-md-'))
      mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
      process.env['MARVEEN_DEPOT'] = depot
      const a = createProject({ name: 'Kovács ház' })
      if (!a.ok) throw new Error('projekt')
      pid = a.project.id
    })
    afterEach(() => { delete process.env['MARVEEN_DEPOT']; rmSync(depot, { recursive: true, force: true }) })

    it('mappas projekt: jegyzet-munkadarab sajat .md fajllal, ami a forrasa', async () => {
      const up = updateProject(pid, { folder_path: 'Projektek/teszt' })
      if (!up.ok) throw new Error('mappa')
      const folder = (await call('POST', '/api/workbench/folders', { project_id: pid, parent: '', name: 'Jegyzetek' })).body.folder as string
      const r = await call('POST', '/api/workbench/intake?lang=hu', { project_id: pid, folder, text: 'szeretnék egy md filet csinálni és beleírni hogy szia' })
      expect(r.status).toBe(201)
      expect(r.body).toMatchObject({ kind: 'note', item: { type: 'note', title: 'Új jegyzet' }, file: { name: 'Új jegyzet.md' } })
      expect(r.body.item.source_path).toBe(r.body.file.rel)
      expect(r.body.versions[0].source_path).toBe(r.body.file.rel)
      expect(existsSync(join(depot, r.body.file.rel))).toBe(true)
      expect(r.body.file.rel).toContain('Jegyzetek/')
      // Ugyanaz a nev masodszor: uj fajl, nem feluliras. #540: a masodik munkadarab SAJAT, szamozott mappat kap az
      // elso MELLETT (nem annak a mappajaba kerul), ezert a fajl neve maradhat, az utja mas.
      const r2 = await call('POST', '/api/workbench/intake?lang=hu', { project_id: pid, folder, text: 'még egy md fájl' })
      expect(r2.body.file.rel).not.toBe(r.body.file.rel)
      expect(r2.body.file.rel).toContain('Jegyzetek/Új jegyzet (2)/')
      expect(existsSync(join(depot, r.body.file.rel))).toBe(true)
      expect(existsSync(join(depot, r2.body.file.rel))).toBe(true)
    })

    it('projektmappa nelkul is letrejon a jegyzet: a projekt az elso irasra mappat kap (TG 2895), nem hibazik', async () => {
      const r = await call('POST', '/api/workbench/intake?lang=hu', { project_id: pid, text: 'csinálj egy md jegyzetet' })
      expect(r.status).toBe(201)
      expect(r.body.item.type).toBe('note')
      expect(r.body.file.rel).toMatch(/\.md$/)
      expect(existsSync(join(depot, r.body.file.rel))).toBe(true)
    })
  })

  it('az ugynok promptja megnevezi a fajlt: abba irjon, ne kulon fajlba', () => {
    const base = { projectName: 'P', projectFolder: '/x', history: [], message: 'md fájl, benne: szia', lang: 'hu' as const }
    const md = buildCodeBridgePrompt({ ...base, workItem: { title: 'Új jegyzet', type: 'note', file: 'Projektek/teszt/Új jegyzet.md', folder: null } })
    expect(md).toContain('Work item file')
    expect(md).toContain('Projektek/teszt/Új jegyzet.md')
    expect(md).toContain('WRITE IT INTO THIS FILE')
    // Irodai dokumentum forrasanal NEM mondjuk, hogy irja felul.
    const docx = buildCodeBridgePrompt({ ...base, workItem: { title: 'Ajánlat', type: 'document', file: 'Projektek/teszt/a.docx', folder: null } })
    expect(docx).not.toContain('Work item file')
  })

  describe('workItem.writeText: az ugynok a munkadarab SAJAT fajljaba ir', () => {
    let depot = ''
    afterEach(() => { delete process.env['MARVEEN_DEPOT']; rmSync(depot, { recursive: true, force: true }) })

    it('a szoveg uj verzio lesz es az elonezet ezt mutatja; fajl nelkuli munkadarabra emberi hiba', async () => {
      initDatabase(':memory:')
      depot = mkdtempSync(join(tmpdir(), 'marveen-wb-intake-tool-'))
      mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
      process.env['MARVEEN_DEPOT'] = depot
      const a = createProject({ name: 'Kovács ház' })
      if (!a.ok) throw new Error('projekt')
      const up = updateProject(a.project.id, { folder_path: 'Projektek/teszt' })
      if (!up.ok) throw new Error('mappa')
      const folder = (await call('POST', '/api/workbench/folders', { project_id: a.project.id, parent: '', name: 'Jegyzetek' })).body.folder as string
      const made = await call('POST', '/api/workbench/intake?lang=hu', { project_id: a.project.id, folder, text: 'csinálj egy md filet' })
      const itemId = made.body.item.id as string
      const ctxt = { projectId: a.project.id, workItemId: itemId, lang: 'hu' as const }
      const w = executeTool('workItem.writeText', { text: 'szia' }, ctxt)
      expect(w.ok).toBe(true)
      const p = buildPreview(itemId)
      expect(p.kind).toBe('text')
      expect(p.text).toBe('szia')
      // Fajl nelkuli munkadarab: nem csendes siker, hanem megmondja, mit tegyen helyette.
      const bare = createWorkItem({ project_id: a.project.id, type: 'note', title: 'fajl nelkul' })
      if (!bare.ok) throw new Error('item')
      const bad = executeTool('workItem.writeText', { id: bare.item.id, text: 'x' }, ctxt)
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.detail).toMatch(/workItem\.addPart/)
    })
  })
})

describe('névjegykártya (Boss, 2026-10-02): saját kérés-típus, kétoldalas kártya-méretű deck', () => {
  it('az osztályozó a névjegy-szavakat névjegykártyának ismeri fel (nem prezentációnak)', () => {
    expect(guessIntakeKind('Szeretnék egy névjegykártyát Kovács Annának')).toEqual({ sure: true, kind: 'business_card' })
    expect(guessIntakeKind('make me a business card')).toEqual({ sure: true, kind: 'business_card' })
    expect(guessIntakeKind('Visitenkarte für die Firma')).toEqual({ sure: true, kind: 'business_card' })
  })
  it('a munkadarab-fajta prezentáció (deck), a cím magyarul és angolul', () => {
    expect(INTAKE_TYPE['business_card']).toBe('presentation')
    expect(intakeTitle('', 'business_card', 'hu')).toBe('Új névjegykártya')
    expect(intakeTitle('', 'business_card', 'en')).toBe('New business card')
  })
})

// The Simple view's start screen offers a Table button (the plan's sixth type next to the five);
// it creates an empty spreadsheet through /items/new-table, not through the intake guess.
describe('intake: table button', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
  it('is offered next to the server kinds and routed to new-table', () => {
    expect(src).toContain("var INTAKE_UI_KINDS = INTAKE_KINDS.concat(['table'])")
    expect(src).toContain("if (kind === 'table') { intakeCreateTable(text, name); return }")
    expect(src).toContain("'/api/workbench/items/new-table'")
  })
})
