// v4 spec phase 4 -- BRAND KIT (K-4.1 .. K-4.3): storage and validation, the
// pure brand check, the agent (sees the brand, can read and check), the routes
// and the panel.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, getProject, updateProject, setProjectArchived } from '../projects.js'
import { createWorkItem, getWorkItem, listWorkItems, listDeletedWorkItems, setWorkItemDeleted, purgeWorkItem } from '../workbench.js'
import {
  getBrand, saveBrand, brandIsEmpty, checkCanvasBrand, brandForContext, emptyBrand, isLogoPath, BrandUnreadableError, type Brand,
  listBrandTemplates, saveBrandTemplate, getBrandTemplate, deleteBrandTemplate, BRAND_MAX_TEMPLATES,
} from '../workbench-brand.js'
import { createFromBrandTemplate } from '../workbench-brand-templates.js'
import { readCanvas } from '../workbench-canvas-store.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { emptyCanvas, type CanvasDoc } from '../workbench-graphic.js'
import { buildContext } from '../workbench-agent/context.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool, TOOLS } from '../workbench-agent/tools.js'
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

beforeEach(() => {
  initDatabase(':memory:')
  const a = createProject({ name: 'Freeber' })
  const b = createProject({ name: 'Másik' })
  if (!a.ok || !b.ok) throw new Error('project')
  pid = a.project.id
  other = b.project.id
})

const BRAND = {
  colors: [{ name: 'main blue', hex: '#1A73E8' }, { name: 'sun', hex: '#fbbc04' }],
  logo_light: 'Freeber/shared/logo.png', logo_dark: 'Freeber/shared/logo-dark.png',
  font_heading: 'serif', font_body: 'sans', logo_corner: 'bottom-right', logo_min_width_pct: 10, no_exclamation: true,
  notes: ['Always address the reader informally.'],
}

function doc(patch: Partial<CanvasDoc> = {}): CanvasDoc {
  return { ...emptyCanvas(1000, 1000), ...patch }
}
const text = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'text' as const, x: 10, y: 10, width: 300, height: 60, opacity: 1, text: 'Hello', fontSize: 40,
  font: 'serif' as const, color: '#1a73e8', align: 'left' as const, bold: false, italic: false, ...extra,
})
const logo = (extra: Record<string, unknown> = {}) => ({
  id: 'logo', type: 'image' as const, x: 850, y: 880, width: 120, height: 100, opacity: 1,
  src: 'Freeber/shared/logo.png', fit: 'contain' as const, alt: '', ...extra,
})

describe('brand kit: storage', () => {
  it('fresh install: nothing stored, the agent context says it was read and is empty', () => {
    expect(getBrand(pid)).toBeNull()
    expect(brandForContext(pid)).toMatch(/none set yet/)
  })

  it('saves, normalises colours (#ABC, duplicates) and keeps projects apart', () => {
    const r = saveBrand(pid, { ...BRAND, colors: [{ name: 'a', hex: '#ABC' }, { name: 'b', hex: '#aabbcc' }, { hex: '#1a73e8' }] })
    if (!r.ok) throw new Error(r.code)
    expect(r.brand.colors.map((c) => c.hex)).toEqual(['#aabbcc', '#1a73e8'])
    expect(r.brand.logo_corner).toBe('bottom-right')
    expect(getBrand(other)).toBeNull()
  })

  it('a partial change touches only the given keys', () => {
    saveBrand(pid, BRAND)
    const r = saveBrand(pid, { no_exclamation: false })
    if (!r.ok) throw new Error(r.code)
    expect(r.brand.no_exclamation).toBe(false)
    expect(r.brand.colors).toHaveLength(2)
    expect(r.brand.logo_light).toBe('Freeber/shared/logo.png')
  })

  it('rejects bad input with a code and stores nothing', () => {
    expect(saveBrand(pid, { colors: [{ hex: 'url(evil)' }] })).toMatchObject({ ok: false, code: 'bad_color' })
    expect(saveBrand(pid, { colors: Array.from({ length: 13 }, (_, i) => ({ hex: '#00000' + (i % 10) })) })).toMatchObject({ ok: false, code: 'too_many_colors' })
    expect(saveBrand(pid, { logo_light: '../../etc/passwd.png' })).toMatchObject({ ok: false, code: 'bad_logo' })
    expect(saveBrand(pid, { logo_light: 'notes.txt' })).toMatchObject({ ok: false, code: 'bad_logo' })
    expect(saveBrand(pid, { font_body: 'comic' })).toMatchObject({ ok: false, code: 'bad_font' })
    expect(saveBrand(pid, { logo_corner: 'middle' })).toMatchObject({ ok: false, code: 'bad_corner' })
    expect(saveBrand(pid, { logo_min_width_pct: 0 })).toMatchObject({ ok: false, code: 'bad_min_width' })
    expect(saveBrand(pid, { notes: ['x'.repeat(301)] })).toMatchObject({ ok: false, code: 'note_too_long' })
    expect(getBrand(pid)).toBeNull()
  })

  it('isLogoPath: pictures inside the project only', () => {
    expect(isLogoPath('a/b/logo.SVG')).toBe(true)
    for (const bad of ['/abs/logo.png', 'a/../b.png', 'C:\\x.png', 'https://x/y.png', 'a//b.png', 'logo.pdf', '']) expect(isLogoPath(bad)).toBe(false)
  })

  it('clearing a field with null/empty string removes it', () => {
    saveBrand(pid, BRAND)
    const r = saveBrand(pid, { logo_corner: '', logo_min_width_pct: null, logo_dark: null })
    if (!r.ok) throw new Error(r.code)
    expect(r.brand.logo_corner).toBeNull()
    expect(r.brand.logo_min_width_pct).toBeNull()
    expect(r.brand.logo_dark).toBeNull()
  })
})

describe('brand kit: the check (K-4.3)', () => {
  const brand = (): Brand => {
    const r = saveBrand(pid, BRAND)
    if (!r.ok) throw new Error(r.code)
    return r.brand
  }

  it('no brand or an empty brand: nothing to check', () => {
    expect(checkCanvasBrand(doc(), null)).toEqual([])
    expect(checkCanvasBrand(doc({ background: '#ff0000' }), emptyBrand())).toEqual([])
  })

  it('a drawing that follows the brand has no findings', () => {
    const d = doc({ background: '#ffffff', objects: [text('t'), logo()] as any })
    expect(checkCanvasBrand(d, brand())).toEqual([])
  })

  it('flags an off-palette colour (text, fill, background) but never black, white or grey', () => {
    const d = doc({
      background: '#ff0000',
      objects: [text('t1', { color: '#00ff00' }), text('t2', { color: '#000000' }), text('t3', { color: '#808080' }), logo()] as any,
    })
    const f = checkCanvasBrand(d, brand()).filter((x) => x.code === 'off_palette')
    expect(f.map((x) => x.object)).toEqual([null, 't1'])
    expect(f[1].message.en).toContain('#00ff00')
    expect(f[1].message.hu).toContain('márkaszínek')
  })

  it('flags a wrong font, an exclamation mark, a missing logo', () => {
    const d = doc({ objects: [text('t', { font: 'mono', text: 'Buy now!' })] as any })
    const codes = checkCanvasBrand(d, brand()).map((x) => x.code).sort()
    expect(codes).toEqual(['exclamation', 'logo_missing', 'off_font'])
  })

  it('flags a logo that is too small or in the wrong corner, with numbers', () => {
    const d = doc({ objects: [logo({ x: 10, y: 10, width: 50, height: 40 })] as any })
    const f = checkCanvasBrand(d, brand())
    expect(f.map((x) => x.code).sort()).toEqual(['logo_corner', 'logo_small'])
    expect(f.find((x) => x.code === 'logo_small')!.message.en).toContain('5%')
  })

  it('the dark logo counts as the brand logo too', () => {
    const d = doc({ objects: [logo({ src: 'Freeber/shared/logo-dark.png' })] as any })
    expect(checkCanvasBrand(d, brand())).toEqual([])
  })
})

describe('brand kit: the Workbench agent (K-4.2)', () => {
  const ctx = () => ({ projectId: pid, workItemId: null, lang: 'en' as const })

  it('every turn carries the brand, and the system prompt is unchanged in shape', () => {
    saveBrand(pid, BRAND)
    const c = buildContext(getProject(pid)!, null, 'en')
    expect(c.parts.some((p) => p.key === 'brand')).toBe(true)
    expect(c.contextText).toContain('#1a73e8')
    expect(c.contextText).toContain('Freeber/shared/logo.png')
    expect(c.contextText).toContain('bottom right corner')
    expect(c.contextText).toContain('Always address the reader informally.')
  })

  it('brand.get / brand.check are read-only tools with no autonomy category', () => {
    for (const n of ['brand.get', 'brand.check']) {
      expect(getTool(n)).toMatchObject({ destructive: false, external_effect: false, autonomyCategory: null })
    }
    // K-4.1: starting a drawing from a brand template creates a work item, so it is gated like workItem.create
    expect(getTool('brand.useTemplate')).toMatchObject({ destructive: false, external_effect: false, autonomyCategory: 'marveen_selfdev' })
    expect(TOOLS.filter((t) => t.name.startsWith('brand.')).map((t) => t.name).sort()).toEqual(['brand.check', 'brand.get', 'brand.useTemplate'])
  })

  it('brand.get: empty project says so; a saved brand comes back without internal fields', () => {
    expect(executeTool('brand.get', {}, ctx())).toMatchObject({ ok: true, data: { empty: true } })
    saveBrand(pid, BRAND)
    const r: any = executeTool('brand.get', {}, ctx())
    expect(r.data.empty).toBe(false)
    expect(r.data.brand.colors[0].hex).toBe('#1a73e8')
    expect(r.data.brand.project_id).toBeUndefined()
  })

  it('brand.check: needs a work item of THIS project; no brand and no drawing are said in words', () => {
    expect(executeTool('brand.check', {}, ctx())).toMatchObject({ ok: false, code: 'bad_input' })
    const w = createWorkItem({ project_id: other, title: 'Idegen', type: 'composite' })
    if (!w.ok) throw new Error('item')
    expect(executeTool('brand.check', { id: w.item.id }, ctx())).toMatchObject({ ok: false, code: 'not_found' })
    const mine = createWorkItem({ project_id: pid, title: 'Poszt', type: 'composite' })
    if (!mine.ok) throw new Error('item')
    expect(executeTool('brand.check', { id: mine.item.id }, ctx())).toMatchObject({ ok: true, data: { checked: false } })
    saveBrand(pid, BRAND)
    const r: any = executeTool('brand.check', { id: mine.item.id }, ctx())
    expect(r.ok).toBe(true)
    expect(r.data.checked).toBe(false)
    expect(r.data.note).toMatch(/no drawing/)
  })
})

describe('brand kit: the routes', () => {
  it('GET on a fresh project: empty brand + limits, exists=false', async () => {
    const r = await call('GET', `/api/workbench/brand?project=${pid}`, null)
    expect(r.status).toBe(200)
    expect(r.body.exists).toBe(false)
    expect(r.body.brand.colors).toEqual([])
    expect(r.body.limits.max_colors).toBe(12)
  })

  it('PUT saves, GET returns it; bad input is a 400 with a human sentence in the UI language', async () => {
    const ok = await call('PUT', '/api/workbench/brand', { project: pid, brand: BRAND })
    expect(ok.status).toBe(200)
    const got = await call('GET', `/api/workbench/brand?project=${pid}`, null)
    expect(got.body.exists).toBe(true)
    expect(got.body.brand.logo_corner).toBe('bottom-right')
    const bad = await call('PUT', '/api/workbench/brand', { project: pid, brand: { colors: [{ hex: 'red' }] } })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toMatch(/#1a73e8/)
    expect((await call('PUT', '/api/workbench/brand', { brand: {} })).status).toBe(400)
    expect((await call('PUT', '/api/workbench/brand', { project: 'nincs', brand: {} })).status).toBe(404)
  })

  it('check: unknown item is a 404; no drawing gives no findings', async () => {
    expect((await call('GET', '/api/workbench/brand/check?item=nincs', null)).status).toBe(404)
    const w = createWorkItem({ project_id: pid, title: 'Poszt', type: 'composite' })
    if (!w.ok) throw new Error('item')
    await call('PUT', '/api/workbench/brand', { project: pid, brand: BRAND })
    const r = await call('GET', `/api/workbench/brand/check?item=${w.item.id}`, null)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ has_brand: true, has_canvas: false, findings: [] })
  })
})

describe('brand kit: the panel', () => {
  const B = (extra: Record<string, unknown> = {}) => ({
    colors: [{ name: 'main blue', hex: '#1a73e8' }], logo_light: '', logo_dark: '', font_heading: '', font_body: '',
    logo_corner: '', logo_min_width_pct: null, no_exclamation: false, notes: [], project_id: 'p1', updated_at: 5, ...extra,
  })
  const FILES = [{ name: 'logo.png', path: 'Freeber/shared/logo.png', project_path: 'shared/logo.png', support: 'readable' }, { name: 'notes.txt', path: 'Freeber/shared/notes.txt' }]

  function open(h: ReturnType<typeof workbenchHarness>, write?: (body: any) => { status: number; body: unknown }, brand: unknown = B()) {
    h.respond((url, init) => {
      if (url.includes('/api/workbench/brand') && init?.method === 'PUT') return write ? write(JSON.parse(String(init.body))) : { status: 200, body: { brand } }
      if (url.includes('/api/workbench/brand')) return { status: 200, body: { brand, exists: true, limits: {} } }
      if (url.includes('/api/workbench/shared')) return { status: 200, body: { folder: 'shared', files: FILES } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Freeber')
    h.click({ 'data-wb-act': 'brand-open' })
  }

  it('opens with the explanation, the colours and only the PICTURES as logo choices; everything translated', async () => {
    const h = workbenchHarness()
    open(h)
    await vi.waitFor(() => expect(h.html()).toContain('id="wbBrandForm"'))
    const html = h.html()
    expect(html).toContain('workbench.brand.intro')
    expect(html).toContain('workbench.brand.colors_help')
    expect(html).toContain('value="#1a73e8"')
    expect(html).toContain('Freeber/shared/logo.png')
    expect(html).not.toContain('notes.txt')
    expect(untranslatedHungarian(html, ['Freeber', 'Kovács weboldal'])).toBe('')
  })

  it('save sends the whole form, nulls for empty fields', async () => {
    const h = workbenchHarness()
    let sent: any = null
    open(h, (body) => { sent = body; return { status: 200, body: { brand: B() } } })
    await vi.waitFor(() => expect(h.html()).toContain('id="wbBrandForm"'))
    h.inputs.wbBrandHex0 = { value: '#112233', focus() {} }
    h.inputs.wbBrandName0 = { value: 'deep', focus() {} }
    h.inputs.wbBrandLogoLight = { value: 'Freeber/shared/logo.png', focus() {} }
    h.inputs.wbBrandCorner = { value: 'bottom-right', focus() {} }
    h.inputs.wbBrandMinW = { value: '10', focus() {} }
    h.inputs.wbBrandNotes = { value: 'Be kind\n\n  Be short ', focus() {} }
    h.fire('submit', { target: { id: 'wbBrandForm' }, preventDefault() {} })
    await vi.waitFor(() => expect(sent).not.toBeNull())
    expect(sent.project).toBe('p1')
    expect(sent.brand).toMatchObject({
      colors: [{ name: 'deep', hex: '#112233' }], logo_light: 'Freeber/shared/logo.png', logo_dark: null,
      font_heading: null, logo_corner: 'bottom-right', logo_min_width_pct: 10, notes: ['Be kind', 'Be short'],
    })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.brand.toast_saved⟧'))
  })

  it('a load failure is shown as a failure, not as an empty brand', async () => {
    const h = workbenchHarness()
    h.respond((url) => url.includes('/api/workbench/brand') ? { status: 500, body: { message: 'cannot read' } } : { status: 200, body: itemsBody([]) })
    h.win.MarvinWorkbench.open('p1', 'Freeber')
    h.click({ 'data-wb-act': 'brand-open' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-error'))
    expect(h.html()).not.toContain('id="wbBrandForm"')
  })
})

describe('brand kit: inside the canvas editor (K-4.2 manual side, K-4.3)', () => {
  const ITEM = { id: 'w1', title: 'Nyári plakát', type: 'graphic', status: 'draft' }
  const DOC = {
    version: 1, width: 1000, height: 800, background: '#ffffff',
    objects: [{ id: 'headline', type: 'text', x: 0, y: 0, width: 800, height: 120, fontSize: 72, text: 'Ride!', color: '#ff0000', align: 'left', font: 'sans', bold: false, italic: false, opacity: 1 }],
  }
  const CANVAS = {
    canvas: DOC, exists: true, rel: 'P/a.canvas.json', name: 'a.canvas.json', version_id: 'v2', version_no: 2,
    current: true, draft: { rev: 1, updated_at: 1790000000, since_version: false },
    history: { can_undo: false, can_redo: false, undo: null, redo: null }, orphans: [],
    limits: { max_objects: 200, text_max: 2000 },
  }
  const BR = { colors: [{ name: 'main blue', hex: '#1a73e8' }], logo_light: '', logo_dark: '', font_heading: '', font_body: '', logo_corner: '', logo_min_width_pct: null, no_exclamation: true, notes: [] }

  async function openCanvas(h: ReturnType<typeof workbenchHarness>, brand: unknown, check?: unknown) {
    h.respond((url) => {
      if (url.includes('/api/workbench/brand/check')) return { status: 200, body: check }
      if (url.includes('/api/workbench/brand')) return { status: 200, body: { brand, exists: true, limits: {} } }
      if (url.includes('/api/workbench/shared')) return { status: 200, body: { folder: null, files: [] } }
      if (url.indexOf('/canvas') > 0) return { status: 200, body: CANVAS }
      if (url.indexOf('/preview') > 0) return { status: 200, body: { available: true, kind: 'canvas', mime: 'image/svg+xml', name: 'a.canvas.json', rel: 'P/a.canvas.json', reason: null, message: null, url: null } }
      if (url.indexOf('/api/workbench/items/') === 0) return { status: 200, body: { item: ITEM, versions: [], parts: [], part_kinds: ['text', 'image'], project: { id: 'p1', name: 'Freeber', archived: false } } }
      return { status: 200, body: itemsBody([ITEM]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Freeber')
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-can-objs'))
    h.click({ 'data-wb-act': 'canvas-edit', 'data-wb-obj': 'headline' })
  }

  it('the colour field offers the brand colours first; a click puts the colour in the field', async () => {
    const h = workbenchHarness()
    await openCanvas(h, BR)
    await vi.waitFor(() => expect(h.html()).toContain('wb-brand-swatch'))
    expect(h.html()).toContain('data-wb-hex="#1a73e8"')
    h.inputs.wbCanColor = { value: '#ff0000', focus() {} }
    h.click({ 'data-wb-act': 'brand-swatch', 'data-wb-target': 'wbCanColor', 'data-wb-hex': '#1a73e8' })
    expect(h.inputs.wbCanColor.value).toBe('#1a73e8')
  })

  it('a project without a brand shows no swatches', async () => {
    const h = workbenchHarness()
    await openCanvas(h, { ...BR, colors: [] })
    await vi.waitFor(() => expect(h.html()).toContain('wbCanColor'))
    expect(h.html()).not.toContain('wb-brand-swatch')
  })

  it('the brand check button lists the deviations in plain words', async () => {
    const h = workbenchHarness()
    await openCanvas(h, BR, { has_brand: true, has_canvas: true, findings: [{ code: 'off_palette', object: 'headline', message: 'The text "Ride!" uses #ff0000, which is not one of the brand colours.' }] })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="canvas-brand-check"'))
    h.click({ 'data-wb-act': 'canvas-brand-check' })
    await vi.waitFor(() => expect(h.html()).toContain('not one of the brand colours'))
    expect(h.html()).toContain('workbench.brand.check_found')
  })

  it('a clean drawing says so', async () => {
    const h = workbenchHarness()
    await openCanvas(h, BR, { has_brand: true, has_canvas: true, findings: [] })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="canvas-brand-check"'))
    h.click({ 'data-wb-act': 'canvas-brand-check' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.brand.check_ok'))
  })
})

// ---- found by the verification of #458 ---------------------------------------

describe('brand kit: one file, two spellings (project folder on disk)', () => {
  let depot = ''
  let file: { path: string; project_path: string }
  let itemId = ''
  const ctx = () => ({ projectId: pid, workItemId: itemId, lang: 'en' as const })

  beforeEach(async () => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-brand-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(join(depot, 'Projektek', 'Freeber'), { recursive: true })
    const up = updateProject(pid, { folder_path: 'Projektek/Freeber' })
    if (!up.ok) throw new Error('folder')
    const u = await callWorkbench(`/api/workbench/shared?project=${pid}&name=logo.png`, 'POST', Buffer.from('PNG'))
    if (u.status !== 201) throw new Error('upload ' + u.status)
    file = u.body.file
    const w = createWorkItem({ project_id: pid, title: 'Poszt', type: 'graphic' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
    const saved = await call('PUT', '/api/workbench/brand', { project: pid, brand: { logo_light: file.path, logo_corner: 'bottom-right', logo_min_width_pct: 10 } })
    if (saved.status !== 200) throw new Error('brand ' + saved.status)
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function draw(src: string): void {
    const r = executeTool('canvas.edit', {
      id: itemId,
      ops: [{ op: 'canvas', width: 1000, height: 1000 }, { op: 'add', type: 'image', id: 'logo', src, x: 850, y: 880, width: 120, height: 100 }],
    }, ctx())
    if (!r.ok) throw new Error(r.code + ': ' + r.detail)
  }

  it('the brand stores the Depot path, the agent\'s file list shows the project path: they differ', () => {
    expect(file.path).toBe('Projektek/Freeber/' + file.project_path)
    expect(getBrand(pid)!.logo_light).toBe(file.path)
  })

  it('a logo placed with the project-relative path (as the agent sees it) is NOT reported missing', async () => {
    draw(file.project_path)
    const tool: any = executeTool('brand.check', { id: itemId }, ctx())
    expect(tool.data.checked).toBe(true)
    expect(tool.data.findings).toEqual([])
    const r = await call('GET', `/api/workbench/brand/check?item=${itemId}`, null)
    expect(r.body).toMatchObject({ has_brand: true, has_canvas: true, findings: [] })
  })

  it('the Depot path and a "./" prefix count too; a same-named file elsewhere does not', () => {
    const b = getBrand(pid)!
    const at = (src: string) => checkCanvasBrand(doc({ objects: [logo({ src })] as any }), b, 'Projektek/Freeber').map((f) => f.code)
    expect(at(file.path)).toEqual([])
    expect(at('./' + file.project_path)).toEqual([])
    expect(at('other/logo.png')).toEqual(['logo_missing'])
    // without the project folder only the exact spelling can match
    expect(checkCanvasBrand(doc({ objects: [logo({ src: file.project_path })] as any }), b).map((f) => f.code)).toEqual(['logo_missing'])
  })
})

describe('brand kit: "nothing" is said only when it is true', () => {
  it('a saved but EMPTY brand is not a brand to check against', async () => {
    expect((await call('PUT', '/api/workbench/brand', { project: pid, brand: {} })).status).toBe(200)
    const w = createWorkItem({ project_id: pid, title: 'Poszt', type: 'composite' })
    if (!w.ok) throw new Error('item')
    const r = await call('GET', `/api/workbench/brand/check?item=${w.item.id}`, null)
    expect(r.status).toBe(200)
    expect(r.body.has_brand).toBe(false)
  })

  it('a stored brand that cannot be read is never reported as "no brand"', async () => {
    saveBrand(pid, BRAND)
    for (const bad of ['{not json', '{"colors":"blue"}']) {
      getDb().prepare('UPDATE workbench_brand SET data = ? WHERE project_id = ?').run(bad, pid)
      expect(() => getBrand(pid)).toThrow(BrandUnreadableError)
      const c = buildContext(getProject(pid)!, null, 'en')
      expect(c.contextText).toMatch(/cannot be read/)
      expect(c.contextText).not.toMatch(/none set yet/)
      expect(executeTool('brand.get', {}, { projectId: pid, workItemId: null, lang: 'en' })).toMatchObject({ ok: false, code: 'brand_unreadable' })
      const w = createWorkItem({ project_id: pid, title: 'Poszt', type: 'composite' })
      if (!w.ok) throw new Error('item')
      expect(executeTool('brand.check', { id: w.item.id }, { projectId: pid, workItemId: null, lang: 'en' })).toMatchObject({ ok: false, code: 'brand_unreadable' })
      expect((await call('GET', `/api/workbench/brand/check?item=${w.item.id}`, null)).status).toBe(500)
      // the panel gets the empty form WITH the warning, so the owner can set the brand again
      const got = await call('GET', `/api/workbench/brand?project=${pid}`, null)
      expect(got.status).toBe(200)
      expect(got.body).toMatchObject({ exists: true, unreadable: true })
      expect(got.body.brand.colors).toEqual([])
    }
    // saving again replaces the unreadable row
    const fixed = await call('PUT', '/api/workbench/brand', { project: pid, brand: { colors: [{ hex: '#1a73e8' }] } })
    expect(fixed.status).toBe(200)
    expect(getBrand(pid)!.colors).toEqual([{ name: '', hex: '#1a73e8' }])
    expect((await call('GET', `/api/workbench/brand?project=${pid}`, null)).body.unreadable).toBe(false)
  })

  it('"too small" never reads "10%, at least 10% is needed"', () => {
    const r = saveBrand(pid, BRAND)
    if (!r.ok) throw new Error(r.code)
    const f = checkCanvasBrand(doc({ objects: [logo({ width: 96 })] as any }), r.brand).filter((x) => x.code === 'logo_small')
    expect(f).toHaveLength(1)
    expect(f[0].message.en).toContain('9.6%')
    expect(f[0].message.hu).toContain('9.6%')
  })
})

describe('brand kit: the panel keeps what the owner typed', () => {
  const B = { colors: [{ name: 'main blue', hex: '#1a73e8' }], logo_light: '', logo_dark: '', font_heading: '', font_body: '', logo_corner: '', logo_min_width_pct: null, no_exclamation: false, notes: [], project_id: 'p1', updated_at: 5 }

  function open(h: ReturnType<typeof workbenchHarness>, shared: { status: number; body: unknown }, extra: Record<string, unknown> = {}) {
    h.respond((url) => {
      if (url.includes('/api/workbench/brand')) return { status: 200, body: { brand: B, exists: true, unreadable: false, limits: {}, ...extra } }
      if (url.includes('/api/workbench/shared')) return shared
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Freeber')
    h.click({ 'data-wb-act': 'brand-open' })
  }

  it('an unrelated redraw of the page does not throw away the unsaved fields', async () => {
    const h = workbenchHarness()
    open(h, { status: 200, body: { folder: 'shared', files: [{ name: 'logo.png', path: 'Freeber/shared/logo.png' }] } })
    await vi.waitFor(() => expect(h.html()).toContain('id="wbBrandForm"'))
    h.inputs.wbBrandHex0 = { value: '#112233', focus() {} }
    h.inputs.wbBrandName0 = { value: 'deep', focus() {} }
    h.inputs.wbBrandLogoLight = { value: 'Freeber/shared/logo.png', focus() {} }
    h.inputs.wbBrandNotes = { value: 'Be kind', focus() {} }
    h.fire('input', { target: { id: 'wbBrandName0', value: 'deep' } })
    // another part of the page redraws everything (here: the decisions panel opens)
    h.click({ 'data-wb-act': 'dec-open' })
    const html = h.html()
    expect(html).toContain('value="deep"')
    expect(html).toContain('value="#112233"')
    expect(html).toContain('>Be kind</textarea>')
    expect(html).toMatch(/<option value="Freeber\/shared\/logo\.png" selected>/)
  })

  it('a failed load of the shared materials is an error, not "no pictures yet"', async () => {
    const h = workbenchHarness()
    open(h, { status: 500, body: { message: 'cannot list the shared materials' } })
    await vi.waitFor(() => expect(h.html()).toContain('id="wbBrandForm"'))
    expect(h.html()).toContain('cannot list the shared materials')
    expect(h.html()).not.toContain('workbench.brand.logos_none')
  })

  it('an unreadable stored brand: the form opens with a warning that saving replaces it', async () => {
    const h = workbenchHarness()
    open(h, { status: 200, body: { folder: null, files: [] } }, { unreadable: true })
    await vi.waitFor(() => expect(h.html()).toContain('id="wbBrandForm"'))
    expect(h.html()).toContain('workbench.brand.unreadable')
  })

  it('the brand colour buttons sit in the input column of the editor grid, they do not shift the fields after them', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')
    const rule = css.match(/^\.wb-can-grid > \.wb-brand-sw \{[^}]*\}/m)
    expect(rule).not.toBeNull()
    expect(rule![0]).toMatch(/grid-column:\s*2/)
    // one column on a phone: the buttons must not open a second column there
    expect(css).toMatch(/@media \(max-width: 720px\) \{[^}]*\.wb-can-grid > \.wb-brand-sw \{ grid-column: 1; \}/)
  })
})

// ---- found by the second verification of #458 ----------------------------------

describe('brand kit: the check judges what is ON the drawing', () => {
  const brand = (patch: Record<string, unknown> = {}): Brand => {
    const r = saveBrand(pid, { ...BRAND, ...patch })
    if (!r.ok) throw new Error(r.code)
    return r.brand
  }
  const ellipse = (extra: Record<string, unknown> = {}) => ({
    id: 'dot', type: 'ellipse' as const, x: 10, y: 10, width: 100, height: 100, opacity: 1,
    fill: '#1a73e8', stroke: '#ff0000', strokeWidth: 0, ...extra,
  })

  it('an outline of zero width is not drawn, so its colour is not a deviation; a drawn one is', () => {
    expect(checkCanvasBrand(doc({ objects: [ellipse(), logo()] as any }), brand())).toEqual([])
    const f = checkCanvasBrand(doc({ objects: [ellipse({ strokeWidth: 4 }), logo()] as any }), brand())
    expect(f.map((x) => `${x.code}:${x.object}`)).toEqual(['off_palette:dot'])
  })

  it('a fully transparent element or an empty text is not on the drawing', () => {
    const d = doc({
      objects: [
        text('ghost', { color: '#00ff00', font: 'mono', text: 'Buy!', opacity: 0 }),
        text('blank', { color: '#00ff00', font: 'mono', text: '  \n ' }),
        logo(),
      ] as any,
    })
    expect(checkCanvasBrand(d, brand())).toEqual([])
  })

  it('an invisible logo does not count as "the logo is there"', () => {
    const f = checkCanvasBrand(doc({ objects: [logo({ opacity: 0 })] as any }), brand())
    expect(f.map((x) => x.code)).toEqual(['logo_missing'])
  })

  it('a logo centred on an axis is in no corner, whichever corner the brand asks for', () => {
    // at the bottom, horizontally centred: 440 + 120 / 2 = 500 of 1000
    const bottomCentre = doc({ objects: [logo({ x: 440, y: 880 })] as any })
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      expect(checkCanvasBrand(bottomCentre, brand({ logo_corner: corner })).map((x) => x.code), corner).toEqual(['logo_corner'])
    }
    // in the quarter the brand asks for it passes
    expect(checkCanvasBrand(doc({ objects: [logo()] as any }), brand({ logo_corner: 'bottom-right' }))).toEqual([])
  })

  it('a long or multi-line text is named in one line and marked as cut', () => {
    const d = doc({ objects: [text('t', { text: 'Summer sale starts\nnext Monday at nine sharp!' }), logo()] as any })
    const f = checkCanvasBrand(d, brand())
    expect(f.map((x) => x.code)).toEqual(['exclamation'])
    expect(f[0].message.en).toContain('"Summer sale starts next Monday…"')
    expect(f[0].message.hu).toContain('„Summer sale starts next Monday…”')
  })

  it('the smallest logo width is a number, not anything that converts to one', () => {
    expect(saveBrand(pid, { logo_min_width_pct: true })).toMatchObject({ ok: false, code: 'bad_min_width' })
    expect(saveBrand(pid, { logo_min_width_pct: [15] })).toMatchObject({ ok: false, code: 'bad_min_width' })
    expect(saveBrand(pid, { logo_min_width_pct: '12.5' })).toMatchObject({ ok: true, brand: { logo_min_width_pct: 12.5 } })
  })
})

// ---- K-4.1: brand templates -----------------------------------------------------

describe('brand templates (K-4.1): storage', () => {
  const D = (width = 1080, height = 1080): CanvasDoc => doc({ width, height, objects: [text('headline')] as any })

  it('fresh install: no templates; a saved one is listed with its size, per project', () => {
    expect(listBrandTemplates(pid)).toEqual([])
    const r = saveBrandTemplate(pid, '  Instagram   post ', D(), { createdBy: 'teszt' })
    if (!r.ok) throw new Error(r.code)
    expect(r.replaced).toBe(false)
    expect(listBrandTemplates(pid)).toMatchObject([{ id: r.template.id, name: 'Instagram post', width: 1080, height: 1080, objects: 1, unreadable: false }])
    expect(listBrandTemplates(other)).toEqual([])
  })

  it('a name is used once: saving again is refused unless the owner said replace', () => {
    const a = saveBrandTemplate(pid, 'Story', D(1080, 1920))
    if (!a.ok) throw new Error(a.code)
    expect(saveBrandTemplate(pid, 'story', D())).toEqual({ ok: false, code: 'template_name_taken' })
    const b = saveBrandTemplate(pid, 'STORY', D(1200, 628), { replace: true })
    if (!b.ok) throw new Error(b.code)
    expect(b.replaced).toBe(true)
    expect(b.template.id).toBe(a.template.id)
    expect(listBrandTemplates(pid)).toMatchObject([{ name: 'STORY', width: 1200, height: 628 }])
    // the same name in another project is another template
    expect(saveBrandTemplate(other, 'Story', D())).toMatchObject({ ok: true, replaced: false })
    expect(listBrandTemplates(pid)).toHaveLength(1)
  })

  it('name rules and the limit, each with its own code', () => {
    expect(saveBrandTemplate(pid, '   ', D())).toEqual({ ok: false, code: 'template_name_required' })
    expect(saveBrandTemplate(pid, 42, D())).toEqual({ ok: false, code: 'template_name_required' })
    expect(saveBrandTemplate(pid, 'x'.repeat(81), D())).toEqual({ ok: false, code: 'template_name_too_long' })
    for (let i = 0; i < BRAND_MAX_TEMPLATES; i++) expect(saveBrandTemplate(pid, `T${i}`, D()).ok).toBe(true)
    expect(saveBrandTemplate(pid, 'one too many', D())).toEqual({ ok: false, code: 'too_many_templates' })
    // replacing an existing one is not "one more"
    expect(saveBrandTemplate(pid, 'T3', D(), { replace: true })).toMatchObject({ ok: true, replaced: true })
  })

  it('getBrandTemplate finds by id or by name, only inside the project; delete removes it', () => {
    const r = saveBrandTemplate(pid, 'Instagram post', D())
    if (!r.ok) throw new Error(r.code)
    expect(getBrandTemplate(pid, r.template.id)).toMatchObject({ ok: true, doc: { width: 1080 } })
    expect(getBrandTemplate(pid, 'instagram POST')).toMatchObject({ ok: true })
    expect(getBrandTemplate(other, r.template.id)).toMatchObject({ ok: false, code: 'template_not_found' })
    expect(getBrandTemplate(pid, '')).toMatchObject({ ok: false, code: 'template_not_found' })
    expect(deleteBrandTemplate(other, r.template.id)).toBe(false)
    expect(deleteBrandTemplate(pid, r.template.id)).toBe(true)
    expect(listBrandTemplates(pid)).toEqual([])
  })

  it('a stored drawing that cannot be read is listed as unreadable, never dropped and never used', () => {
    const r = saveBrandTemplate(pid, 'Broken', D())
    if (!r.ok) throw new Error(r.code)
    getDb().prepare('UPDATE workbench_brand_templates SET doc = ? WHERE id = ?').run('{not json', r.template.id)
    expect(listBrandTemplates(pid)).toMatchObject([{ name: 'Broken', unreadable: true, width: null, objects: null }])
    expect(getBrandTemplate(pid, r.template.id)).toMatchObject({ ok: false, code: 'template_unreadable' })
    // the agent is not offered a template it could not use
    expect(brandForContext(pid)).not.toContain('Broken')
    expect(deleteBrandTemplate(pid, r.template.id)).toBe(true)
  })
})

describe('brand templates (K-4.1): from a drawing to a template to a new drawing', () => {
  let depot = ''
  let itemId = ''
  const ctx = () => ({ projectId: pid, workItemId: itemId, lang: 'en' as const })

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-brandtpl-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(join(depot, 'Projektek', 'Freeber'), { recursive: true })
    const up = updateProject(pid, { folder_path: 'Projektek/Freeber' })
    if (!up.ok) throw new Error('folder')
    const w = createWorkItem({ project_id: pid, title: 'Nyári poszt', type: 'graphic' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function draw(): void {
    const r = executeTool('canvas.edit', {
      id: itemId,
      ops: [{ op: 'canvas', width: 1080, height: 1350 }, { op: 'add', type: 'text', id: 'headline', text: 'Hello', x: 40, y: 40, width: 600, height: 120 }],
    }, ctx())
    if (!r.ok) throw new Error(r.code + ': ' + r.detail)
  }

  it('a work item without a drawing is said so in a sentence; nothing is saved', async () => {
    const r = await call('POST', '/api/workbench/brand/templates', { item: itemId, name: 'Poszt' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('brand_template_no_canvas')
    expect(r.body.message).not.toBe(r.body.error)
    expect(listBrandTemplates(pid)).toEqual([])
    const gone = await call('POST', '/api/workbench/brand/templates', { item: 'nincs', name: 'x' })
    expect(gone.status).toBe(404)
    expect(gone.body.error).toBe('brand_template_item_not_found')
  })

  it('save -> listed with the brand -> the new drawing is a COPY; the template and the source stay as they were', async () => {
    draw()
    const saved = await call('POST', '/api/workbench/brand/templates', { item: itemId, name: 'Instagram poszt' })
    expect(saved.status).toBe(201)
    expect(saved.body.template).toMatchObject({ name: 'Instagram poszt', width: 1080, height: 1350, objects: 1, unreadable: false })
    const got = await call('GET', `/api/workbench/brand?project=${pid}`, null)
    expect(got.body.templates).toMatchObject([{ id: saved.body.template.id, name: 'Instagram poszt' }])
    expect(got.body.limits).toMatchObject({ max_templates: 30, template_name_max: 80 })
    // a project that only has templates still has no brand row
    expect(got.body.exists).toBe(false)

    const used = await call('POST', `/api/workbench/brand/templates/${saved.body.template.id}/use`, { project: pid })
    expect(used.status).toBe(201)
    expect(used.body.item).toMatchObject({ project_id: pid, type: 'graphic', title: 'Instagram poszt' })
    expect(used.body.item.id).not.toBe(itemId)
    const copy = readCanvas(used.body.item.id)
    if (!copy.ok) throw new Error(copy.code)
    expect(copy.exists).toBe(true)
    expect(copy.doc).toMatchObject({ width: 1080, height: 1350 })
    expect(copy.doc.objects.map((o) => o.id)).toEqual(['headline'])

    // changing the copy changes neither the template nor the drawing it came from
    const edit = executeTool('canvas.edit', { id: used.body.item.id, ops: [{ op: 'remove', id: 'headline' }] }, ctx())
    if (!edit.ok) throw new Error(edit.code + ': ' + edit.detail)
    expect(getBrandTemplate(pid, saved.body.template.id)).toMatchObject({ ok: true, template: { objects: 1 } })
    const src = readCanvas(itemId)
    if (!src.ok) throw new Error(src.code)
    expect(src.doc.objects).toHaveLength(1)
  })

  it('the template is a snapshot: the drawing it came from can be purged, the template still works', async () => {
    draw()
    const saved = await call('POST', '/api/workbench/brand/templates', { item: itemId })
    expect(saved.status).toBe(201)
    // without a name the work item's title is the name
    expect(saved.body.template.name).toBe('Nyári poszt')
    setWorkItemDeleted(itemId, true)
    expect(purgeWorkItem(itemId)).toMatchObject({ ok: true })
    expect(getWorkItem(itemId)).toBeUndefined()
    expect(listBrandTemplates(pid)).toHaveLength(1)
    const used = await call('POST', `/api/workbench/brand/templates/${saved.body.template.id}/use`, { project: pid, title: 'Őszi poszt' })
    expect(used.status).toBe(201)
    expect(used.body.item.title).toBe('Őszi poszt')
  })

  it('a taken name is a 409 with its own code; replace overwrites; delete needs the right project', async () => {
    draw()
    expect((await call('POST', '/api/workbench/brand/templates', { item: itemId, name: 'Story' })).status).toBe(201)
    const again = await call('POST', '/api/workbench/brand/templates', { item: itemId, name: 'story' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('brand_template_name_taken')
    expect(again.body.message).not.toBe(again.body.error)
    const rep = await call('POST', '/api/workbench/brand/templates', { item: itemId, name: 'story', replace: true })
    expect(rep.status).toBe(200)
    expect(rep.body.replaced).toBe(true)
    expect(rep.body.templates).toHaveLength(1)
    const id = rep.body.template.id
    expect((await call('DELETE', `/api/workbench/brand/templates/${id}`, null)).status).toBe(400)
    expect((await call('DELETE', `/api/workbench/brand/templates/${id}?project=${other}`, null)).status).toBe(404)
    expect(listBrandTemplates(pid)).toHaveLength(1)
    const del = await call('DELETE', `/api/workbench/brand/templates/${id}?project=${pid}`, null)
    expect(del.status).toBe(200)
    expect(del.body.templates).toEqual([])
    const gone = await call('POST', `/api/workbench/brand/templates/${id}/use`, { project: pid })
    expect(gone.status).toBe(404)
    expect(gone.body.error).toBe('brand_template_not_found')
    expect(gone.body.message).not.toBe(gone.body.error)
  })

  it('an archived project is read-only: no saving, no using, no removing', async () => {
    draw()
    const saved = await call('POST', '/api/workbench/brand/templates', { item: itemId, name: 'Story' })
    const id = saved.body.template.id
    if (!setProjectArchived(pid, true)) throw new Error('archive')
    for (const r of [
      await call('POST', '/api/workbench/brand/templates', { item: itemId, name: 'Masik' }),
      await call('POST', `/api/workbench/brand/templates/${id}/use`, { project: pid }),
      await call('DELETE', `/api/workbench/brand/templates/${id}?project=${pid}`, null),
    ]) {
      expect(r.status).toBe(409)
      expect(r.body.error).toBe('project_archived')
    }
    expect(listBrandTemplates(pid)).toHaveLength(1)
    expect(listWorkItems(pid)).toHaveLength(1)
  })

  it('when the drawing cannot be written, no empty work item stays behind and the reason comes back', () => {
    const t = saveBrandTemplate(other, 'Story', doc())
    if (!t.ok) throw new Error(t.code)
    // `other` has no folder in the Depot, so the canvas file has nowhere to go
    const r = createFromBrandTemplate({ id: other }, t.template.id, { createdBy: 'teszt' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).not.toBe('template_failed')
    expect(listWorkItems(other)).toEqual([])
    expect(listDeletedWorkItems(other)).toEqual([])
  })

  it('the agent sees the templates and starts a drawing from one by name', () => {
    draw()
    const cur = readCanvas(itemId)
    if (!cur.ok) throw new Error(cur.code)
    const t = saveBrandTemplate(pid, 'Instagram poszt', cur.doc)
    if (!t.ok) throw new Error(t.code)
    // no colours or rules yet: the agent is told so AND still gets the templates
    const c = buildContext(getProject(pid)!, null, 'en')
    expect(c.contextText).toMatch(/none set yet/)
    expect(c.contextText).toContain('"Instagram poszt" (1080x1350)')
    expect(c.contextText).toContain('brand.useTemplate')
    const got: any = executeTool('brand.get', {}, ctx())
    expect(got.data).toMatchObject({ empty: true, templates: [{ id: t.template.id, name: 'Instagram poszt', width: 1080, height: 1350, usable: true }] })

    const made: any = executeTool('brand.useTemplate', { template: 'instagram poszt', title: 'Szeptemberi akció' }, ctx())
    expect(made.ok).toBe(true)
    expect(made.data.item).toMatchObject({ title: 'Szeptemberi akció', type: 'graphic', project_id: pid })
    expect(readCanvas(made.data.item.id)).toMatchObject({ ok: true, exists: true, doc: { width: 1080, height: 1350 } })

    // an unknown template: the answer names the ones that exist
    const bad: any = executeTool('brand.useTemplate', { template: 'nincs ilyen' }, ctx())
    expect(bad).toMatchObject({ ok: false, code: 'template_not_found' })
    expect(bad.detail).toContain('"Instagram poszt"')
    expect(executeTool('brand.useTemplate', {}, ctx())).toMatchObject({ ok: false, code: 'bad_input' })
    // with a brand set, the templates are one more line of it
    saveBrand(pid, BRAND)
    expect(brandForContext(pid)).toMatch(/Colours: .*\n(.*\n)*- Brand templates .*"Instagram poszt"/)
  })
})

describe('brand templates (K-4.1): the panel and the canvas toolbar', () => {
  type Extra = ((url: string, method: string, init?: RequestInit) => { status: number; body: unknown } | null) | null
  const B = { colors: [{ name: 'main blue', hex: '#1a73e8' }], logo_light: '', logo_dark: '', font_heading: '', font_body: '', logo_corner: '', logo_min_width_pct: null, no_exclamation: false, notes: [], project_id: 'p1', updated_at: 5 }
  const TPL = { id: 't1', name: 'Instagram poszt', width: 1080, height: 1350, objects: 4, created_at: 1790000000, unreadable: false }
  const ITEM = { id: 'w1', title: 'Plakat', type: 'graphic', status: 'draft' }
  const CANVAS = {
    canvas: { version: 1, width: 1000, height: 800, background: '#ffffff', objects: [{ id: 'headline', type: 'text', x: 0, y: 0, width: 800, height: 120, fontSize: 72, text: 'Ride', color: '#1a73e8', align: 'left', font: 'sans', bold: false, italic: false, opacity: 1 }] },
    exists: true, rel: 'P/a.canvas.json', name: 'a.canvas.json', version_id: 'v2', version_no: 2,
    current: true, draft: { rev: 1, updated_at: 1790000000, since_version: false },
    history: { can_undo: false, can_redo: false, undo: null, redo: null }, orphans: [],
    limits: { max_objects: 200, text_max: 2000 },
  }

  /** One responder for both views: the project list, an opened drawing, the brand. */
  function serve(h: ReturnType<typeof workbenchHarness>, templates: unknown[], extra: Extra, items: unknown[] = []) {
    h.respond((url, init) => {
      const method = init?.method || 'GET'
      const own = extra ? extra(url, method, init) : null
      if (own) return own
      if (url.includes('/api/workbench/brand')) return { status: 200, body: { brand: B, exists: true, unreadable: false, templates, limits: {} } }
      if (url.includes('/api/workbench/shared')) return { status: 200, body: { folder: null, files: [] } }
      if (url.indexOf('/canvas') > 0) return { status: 200, body: CANVAS }
      if (url.indexOf('/preview') > 0) return { status: 200, body: { available: true, kind: 'canvas', mime: 'image/svg+xml', name: 'a.canvas.json', rel: 'P/a.canvas.json', reason: null, message: null, url: null } }
      const m = url.match(/^\/api\/workbench\/items\/([^/?]+)/)
      if (m) return { status: 200, body: { item: { ...ITEM, id: m[1] }, versions: [], parts: [], part_kinds: ['text', 'image'], project: { id: 'p1', name: 'Freeber', archived: false } } }
      return { status: 200, body: itemsBody(items) }
    })
  }

  function openPanel(h: ReturnType<typeof workbenchHarness>, templates: unknown[], extra: Extra = null) {
    serve(h, templates, extra)
    h.win.MarvinWorkbench.open('p1', 'Freeber')
    h.click({ 'data-wb-act': 'brand-open' })
  }

  async function openDrawing(h: ReturnType<typeof workbenchHarness>, extra: Extra = null) {
    serve(h, [], extra, [ITEM])
    h.win.MarvinWorkbench.open('p1', 'Freeber')
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="canvas-brand-tpl-save"'))
  }

  it('fresh project: the Templates part says how to make the first one', async () => {
    const h = workbenchHarness()
    openPanel(h, [])
    await vi.waitFor(() => expect(h.html()).toContain('id="wbBrandForm"'))
    expect(h.html()).toContain('workbench.brand.h_templates')
    expect(h.html()).toContain('workbench.brand.tpl_none')
    expect(h.html()).not.toContain('data-wb-act="brand-tpl-use"')
  })

  it('lists the templates; "new drawing from this" posts, closes the panel and opens the new work item', async () => {
    const h = workbenchHarness()
    let body: any = null
    openPanel(h, [TPL], (url, method, init) => {
      if (url.includes('/brand/templates/t1/use') && method === 'POST') {
        body = JSON.parse(String(init?.body))
        return { status: 201, body: { ok: true, item: { ...ITEM, id: 'w9', title: 'Instagram poszt' }, versions: [], template: TPL } }
      }
      return null
    })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="brand-tpl-use"'))
    expect(h.html()).toContain('Instagram poszt')
    expect(h.html()).toContain('workbench.brand.tpl_meta')
    expect(h.html()).toContain('workbench.brand.tpl_help')
    expect(untranslatedHungarian(h.html(), ['Freeber', 'Kovács weboldal'])).toBe('')
    h.click({ 'data-wb-act': 'brand-tpl-use', 'data-wb-tpl': 't1' })
    await vi.waitFor(() => expect(body).toEqual({ project: 'p1' }))
    await vi.waitFor(() => expect(h.toasts.some((x) => x.includes('workbench.brand.tpl_created'))).toBe(true))
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.startsWith('/api/workbench/items/w9'))).toBe(true))
    expect(h.html()).not.toContain('id="wbBrandPanel"')
  })

  it('removing asks first: a "no" sends nothing', async () => {
    const h = workbenchHarness({ confirm: false })
    openPanel(h, [TPL])
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="brand-tpl-del"'))
    h.click({ 'data-wb-act': 'brand-tpl-del', 'data-wb-tpl': 't1' })
    expect(h.fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false)
    expect(h.html()).toContain('Instagram poszt')
  })

  it('removing after a "yes" sends the DELETE with the project, and the list empties', async () => {
    const h = workbenchHarness()
    let asked = ''
    openPanel(h, [TPL], (url, method) => {
      if (method === 'DELETE') { asked = url; return { status: 200, body: { ok: true, templates: [] } } }
      return null
    })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="brand-tpl-del"'))
    h.click({ 'data-wb-act': 'brand-tpl-del', 'data-wb-tpl': 't1' })
    await vi.waitFor(() => expect(asked).toContain('/api/workbench/brand/templates/t1?project=p1'))
    await vi.waitFor(() => expect(h.html()).toContain('workbench.brand.tpl_none'))
    expect(h.toasts).toContain('⟦workbench.brand.tpl_deleted⟧')
  })

  it('an unreadable template is shown with the reason and can only be removed', async () => {
    const h = workbenchHarness()
    openPanel(h, [{ ...TPL, width: null, height: null, objects: null, unreadable: true }])
    await vi.waitFor(() => expect(h.html()).toContain('workbench.brand.tpl_unreadable'))
    expect(h.html()).not.toContain('data-wb-act="brand-tpl-use"')
    expect(h.html()).toContain('data-wb-act="brand-tpl-del"')
  })

  it('the canvas toolbar saves the drawing as a brand template under the typed name', async () => {
    const h = workbenchHarness()
    let sent: any = null
    h.win.prompt = () => '  Instagram poszt '
    await openDrawing(h, (url, method, init) => {
      if (url.includes('/api/workbench/brand/templates') && method === 'POST') {
        sent = JSON.parse(String(init?.body))
        return { status: 201, body: { ok: true, template: TPL, replaced: false, templates: [TPL] } }
      }
      return null
    })
    h.click({ 'data-wb-act': 'canvas-brand-tpl-save' })
    await vi.waitFor(() => expect(sent).toEqual({ item: 'w1', name: 'Instagram poszt', replace: false }))
    await vi.waitFor(() => expect(h.toasts.some((x) => x.includes('workbench.brand.tpl_saved'))).toBe(true))
    // the saved one is in the panel without another load
    h.click({ 'data-wb-act': 'brand-open' })
    expect(h.html()).toContain('data-wb-act="brand-tpl-use"')
  })

  it('cancelling the name prompt saves nothing', async () => {
    const h = workbenchHarness()
    h.win.prompt = () => null
    await openDrawing(h)
    h.click({ 'data-wb-act': 'canvas-brand-tpl-save' })
    expect(h.fetchCalls.some((c) => c.init?.method === 'POST' && c.url.includes('/brand/templates'))).toBe(false)
  })

  it('a taken name asks before replacing, and replaces only after a yes', async () => {
    const h = workbenchHarness()
    const bodies: any[] = []
    h.win.prompt = () => 'Story'
    await openDrawing(h, (url, method, init) => {
      if (url.includes('/api/workbench/brand/templates') && method === 'POST') {
        const b = JSON.parse(String(init?.body))
        bodies.push(b)
        return b.replace
          ? { status: 200, body: { ok: true, template: { ...TPL, name: 'Story' }, replaced: true, templates: [TPL] } }
          : { status: 409, body: { error: 'brand_template_name_taken', message: 'taken' } }
      }
      return null
    })
    h.click({ 'data-wb-act': 'canvas-brand-tpl-save' })
    await vi.waitFor(() => expect(bodies.map((b) => b.replace)).toEqual([false, true]))
    await vi.waitFor(() => expect(h.toasts.some((x) => x.includes('workbench.brand.tpl_replaced'))).toBe(true))
    expect(h.toasts).not.toContain('taken')
  })

  it('a taken name and a "no": the old template stays, nothing is sent again', async () => {
    const h = workbenchHarness({ confirm: false })
    let posts = 0
    h.win.prompt = () => 'Story'
    await openDrawing(h, (url, method) => {
      if (url.includes('/api/workbench/brand/templates') && method === 'POST') { posts += 1; return { status: 409, body: { error: 'brand_template_name_taken', message: 'taken' } } }
      return null
    })
    h.click({ 'data-wb-act': 'canvas-brand-tpl-save' })
    await vi.waitFor(() => expect(posts).toBe(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(posts).toBe(1)
  })

  it('a check that compared no drawing does not say "follows the brand"', async () => {
    const h = workbenchHarness()
    await openDrawing(h, (url) => (url.includes('/api/workbench/brand/check') ? { status: 200, body: { has_brand: true, has_canvas: false, findings: [] } } : null))
    h.click({ 'data-wb-act': 'canvas-brand-check' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.brand.check_nocanvas'))
    expect(h.html()).not.toContain('workbench.brand.check_ok')
  })

  it('what the owner types while the brand is being fetched again is not wiped by the answer', async () => {
    const h = workbenchHarness()
    // the canvas editor has already loaded the brand (for the colour buttons)
    await openDrawing(h)
    const loads = () => h.fetchCalls.filter((c) => /^\/api\/workbench\/brand\?/.test(c.url)).length
    await vi.waitFor(() => expect(loads()).toBe(1))
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="brand-open"'))
    // so the panel opens with the form at once, and asks the server again
    h.click({ 'data-wb-act': 'brand-open' })
    expect(h.html()).toContain('id="wbBrandForm"')
    expect(loads()).toBe(2)
    h.inputs.wbBrandName0 = { value: 'deep blue', focus() {} }
    h.fire('input', { target: { id: 'wbBrandName0', value: 'deep blue' } })
    const before = h.renders.length
    await vi.waitFor(() => expect(h.renders.length).toBeGreaterThan(before))
    expect(h.html()).toContain('value="deep blue"')
    expect(h.html()).not.toContain('value="main blue"')
  })
})

describe('brand kit: the editor colour field shows its colour', () => {
  const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

  it('the colour well is not squeezed to a line by the text-field padding', () => {
    // .wb-input has 8px padding; on a 27px high colour input that left ~1px of colour
    const rule = css.match(/^\.wb-can-grid input\[type="color"\]\.wb-input \{[^}]*\}/m)
    expect(rule).not.toBeNull()
    expect(rule![0]).toMatch(/padding:\s*2px 4px/)
    expect(rule![0]).toMatch(/height:\s*36px/)
  })

  it('on a phone the brand colour buttons are big enough for a fingertip', () => {
    expect(css).toMatch(/@media \(max-width: 720px\) \{ \.wb-brand-swatch \{ width: 32px; height: 32px; \}/)
  })
})

describe('brand kit: clear space around the logo', () => {
  const brand = (clear: unknown = 25): Brand => {
    const r = saveBrand(pid, { ...BRAND, logo_clear_space_pct: clear })
    if (!r.ok) throw new Error(r.code)
    return r.brand
  }
  const crowded = (d: ReturnType<typeof doc>, b: Brand) => checkCanvasBrand(d, b).filter((x) => x.code === 'logo_crowded')

  it('is a number from 1 to 100, or empty', () => {
    expect(saveBrand(pid, { logo_clear_space_pct: 0 })).toMatchObject({ ok: false, code: 'bad_clear_space' })
    expect(saveBrand(pid, { logo_clear_space_pct: 101 })).toMatchObject({ ok: false, code: 'bad_clear_space' })
    expect(saveBrand(pid, { logo_clear_space_pct: true })).toMatchObject({ ok: false, code: 'bad_clear_space' })
    expect(saveBrand(pid, { logo_clear_space_pct: '25' })).toMatchObject({ ok: true, brand: { logo_clear_space_pct: 25 } })
    expect(saveBrand(pid, { logo_clear_space_pct: '' })).toMatchObject({ ok: true, brand: { logo_clear_space_pct: null } })
  })

  it('a brand with only a clear space is not empty, and the agent is told', () => {
    const r = saveBrand(pid, { logo_clear_space_pct: 30 })
    if (!r.ok) throw new Error(r.code)
    expect(brandIsEmpty(r.brand)).toBe(false)
    expect(brandForContext(pid)).toContain('30% of the logo')
  })

  it('flags an element inside the margin, in plain words', () => {
    // logo 120 wide: the margin is 30 px, so the zone starts at x = 820
    const d = doc({ objects: [logo(), text('t', { x: 700, y: 900, width: 140, height: 40 })] as any })
    const f = crowded(d, brand())
    expect(f).toHaveLength(1)
    expect(f[0].object).toBe('logo')
    expect(f[0].message.hu).toContain('szabad terület')
    expect(f[0].message.en).toContain('too close')
  })

  it('an element outside the margin, a background panel and a line are fine', () => {
    const far = text('t', { x: 700, y: 900, width: 100, height: 40 })
    const panel = { id: 'bg', type: 'rect' as const, x: 0, y: 0, width: 1000, height: 1000, opacity: 1, fill: '#1a73e8', radius: 0 }
    const line = { id: 'ln', type: 'line' as const, x: 800, y: 900, width: 100, height: 0, opacity: 1, stroke: '#000000', strokeWidth: 2 }
    expect(crowded(doc({ objects: [panel, logo(), far, line] as any }), brand())).toEqual([])
  })

  it('no clear space set: no finding', () => {
    const d = doc({ objects: [logo(), text('t', { x: 700, y: 900, width: 200, height: 40 })] as any })
    expect(crowded(d, brand(null))).toEqual([])
  })
})
