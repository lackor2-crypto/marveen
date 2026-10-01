// v4 spec phase 4 -- BRAND KIT (K-4.1 .. K-4.3): storage and validation, the
// pure brand check, the agent (sees the brand, can read and check), the routes
// and the panel.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createProject, getProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { getBrand, saveBrand, checkCanvasBrand, brandForContext, emptyBrand, isLogoPath, type Brand } from '../workbench-brand.js'
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
    expect(TOOLS.filter((t) => t.name.startsWith('brand.'))).toHaveLength(2)
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
