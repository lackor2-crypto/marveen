// #493: the "Social post" TEMPLATE opens on a platform-sized canvas, like the intake's Social post button --
// not on the parts list the owner complained about (TG 7954). Server, agent and front end.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { listWorkItemParts } from '../workbench.js'
import { WORKBENCH_TEMPLATES, listTemplates, createFromTemplate, postCanvasFromTexts } from '../workbench-templates.js'
import { readCanvas } from '../workbench-canvas-store.js'
import { executeTool } from '../workbench-agent/execute.js'
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

let dir = ''
let pid = ''

function freshProject(withFolder: boolean): void {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-tplcanvas-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Poszt' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (withFolder) {
    if (!updateProject(pid, { folder_path: 'Projektek/Poszt' }).ok) throw new Error('mappa')
    mkdirSync(join(dir, 'Projektek', 'Poszt'), { recursive: true })
  }
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
  delete process.env['MARVEEN_DEPOT']
})

const post = WORKBENCH_TEMPLATES.find((t) => t.id === 'social_post')!

describe('social post template -> canvas (server)', () => {
  beforeEach(() => freshProject(true))

  it('only the social post template is a canvas template, and the list says so', () => {
    expect(WORKBENCH_TEMPLATES.filter((t) => t.canvas).map((t) => t.id)).toEqual(['social_post'])
    expect(listTemplates('hu').map((t) => [t.id, t.canvas])).toEqual([
      ['offer', false], ['letter', false], ['social_post', true], ['invitation', false],
    ])
  })

  it('opens on a canvas of the chosen platform size, with the template text on it; the parts stay', () => {
    const r = createFromTemplate({ id: pid }, 'social_post', { lang: 'hu', created_by: 'teszt', platform: 'instagram_square' })
    if (!r.ok) throw new Error(r.code)
    expect(r.canvas).toBe(true)
    expect(r.item.type).toBe('composite')
    expect(r.item.current_version_id).toBe(r.version.id)
    const c = readCanvas(r.item.id)
    if (!c.ok) throw new Error(c.code)
    expect(c.exists).toBe(true)
    expect([c.doc.width, c.doc.height]).toEqual([1080, 1080])
    const texts = c.doc.objects.map((o: any) => o.text)
    expect(texts[0]).toBe(post.parts[0].hu)
    expect(texts[1]).toBe(post.parts.slice(1).map((p) => p.hu).join('\n\n'))
    expect(listWorkItemParts(r.item.id).map((p) => p.text)).toEqual(post.parts.map((p) => p.hu))
  })

  it('no platform, or an unknown one: the Facebook post size', () => {
    for (const platform of [undefined, 'nincs-ilyen']) {
      const r = createFromTemplate({ id: pid }, 'social_post', { lang: 'en', platform })
      if (!r.ok) throw new Error(r.code)
      const c = readCanvas(r.item.id)
      if (!c.ok) throw new Error(c.code)
      expect([c.doc.width, c.doc.height]).toEqual([1200, 630])
    }
  })

  it('the other templates stay parts lists, without a canvas', () => {
    const r = createFromTemplate({ id: pid }, 'letter', { lang: 'hu', platform: 'instagram_square' })
    if (!r.ok) throw new Error(r.code)
    expect(r.canvas).toBeUndefined()
    const c = readCanvas(r.item.id)
    expect(c.ok && c.exists).toBe(false)
  })

  it('endpoint: the platform reaches the canvas, and the answer says the canvas was laid', async () => {
    const res = await call('POST', '/api/workbench/templates/use?lang=hu', { project_id: pid, template: 'social_post', platform: 'linkedin_post' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ ok: true, template: 'social_post', canvas: true })
    const c = readCanvas(res.body.item.id)
    if (!c.ok) throw new Error(c.code)
    expect([c.doc.width, c.doc.height]).toEqual([1200, 627])
  })

  it('agent: workItem.fromTemplate lays the canvas too, as an agent step', () => {
    const r = executeTool('workItem.fromTemplate', { template: 'social_post', platform: 'instagram_square' }, { projectId: pid, workItemId: null, lang: 'en' })
    expect(r).toMatchObject({ ok: true, data: { canvas: true } })
    const c = readCanvas((r as any).data.item.id)
    if (!c.ok) throw new Error(c.code)
    expect([c.doc.width, c.doc.height]).toEqual([1080, 1080])
  })
})

describe('social post template without a project folder', () => {
  beforeEach(() => freshProject(false))

  it('the item is still made as a parts list (the page then offers the convert button), never an error', () => {
    // A project without a folder now gets one on first write; the fallback is for a machine with no Depot at all.
    const savedDepot = process.env['MARVEEN_DEPOT']
    delete process.env['MARVEEN_DEPOT']
    let r: ReturnType<typeof createFromTemplate>
    try { r = createFromTemplate({ id: pid }, 'social_post', { lang: 'hu', platform: 'facebook_post' }) } finally {
      if (savedDepot !== undefined) process.env['MARVEEN_DEPOT'] = savedDepot
    }
    if (!r.ok) throw new Error(r.code)
    expect(r.canvas).toBe(false)
    expect(r.parts).toHaveLength(post.parts.length)
    const c = readCanvas(r.item.id)
    expect(c.ok && c.exists).toBe(false)
  })
})

describe('post layout', () => {
  it('headline + body inside the canvas, every size the picker offers', () => {
    for (const [w, h] of [[1200, 630], [1080, 1080], [1200, 627]]) {
      const doc = postCanvasFromTexts(['Cim', 'Elso', '', 'Masodik'], w, h)
      expect(doc.objects.map((o: any) => o.text)).toEqual(['Cim', 'Elso\n\nMasodik'])
      for (const o of doc.objects as any[]) {
        expect(o.x + o.width).toBeLessThanOrEqual(w)
        expect(o.y + o.height).toBeLessThanOrEqual(h)
      }
    }
    expect(postCanvasFromTexts([], 1200, 630).objects).toEqual([])
  })
})

describe('social post template (front end)', () => {
  const TPL = [
    { id: 'letter', type: 'document', name: 'Levél', description: 'Hivatalos levél.', part_count: 4, first_line: 'y', canvas: false },
    { id: 'social_post', type: 'composite', name: 'Közösségi poszt', description: 'Poszt vásznon.', part_count: 4, first_line: 'x', canvas: true },
  ]

  function open(h: ReturnType<typeof workbenchHarness>, list: unknown[]) {
    h.respond((url) => {
      if (url.includes('/api/workbench/templates/use')) return { status: 201, body: { ok: true, item: { id: 'w1', title: 'Közösségi poszt' }, versions: [], parts: [], canvas: true } }
      if (url.includes('/api/workbench/templates')) return { status: 200, body: { templates: list } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: { id: 'w1', title: 'Közösségi poszt', type: 'composite' }, versions: [], parts: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Poszt')
  }
  const uses = (h: ReturnType<typeof workbenchHarness>) =>
    h.fetchCalls.filter((c) => c.url.includes('/api/workbench/templates/use')).map((c) => JSON.parse(String(c.init!.body)))

  it('the template list carries a platform picker of its own, and the picked size goes with the click', async () => {
    const h = workbenchHarness()
    open(h, TPL)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-tpl="social_post"'))
    expect(h.html()).toContain('id="wbTplPlatform"')
    expect(h.html()).toContain('workbench.tpl.platform_hint')
    h.fire('input', { target: { id: 'wbTplPlatform', value: 'instagram_square' } })
    h.click({ 'data-wb-act': 'tpl-use', 'data-wb-tpl': 'social_post' })
    await vi.waitFor(() => expect(uses(h)).toHaveLength(1))
    expect(uses(h)[0]).toEqual({ project_id: 'p1', template: 'social_post', platform: 'instagram_square' })
    // The new item opens, and its canvas is asked for (a composite with a canvas shows the canvas).
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/w1/canvas'))).toBe(true))
  })

  it('the new-item form shows both pickers: picking in one moves the other, so the screen never shows a size the click will not use', async () => {
    const h = workbenchHarness()
    open(h, TPL)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-tpl="social_post"'))
    h.inputs['wbIntakePlatform'] = { value: 'facebook_post', focus() {} }
    h.inputs['wbTplPlatform'] = { value: 'facebook_post', focus() {} }
    h.fire('input', { target: { id: 'wbTplPlatform', value: 'linkedin_post' } })
    expect(h.inputs['wbIntakePlatform'].value).toBe('linkedin_post')
    h.fire('input', { target: { id: 'wbIntakePlatform', value: 'instagram_square' } })
    expect(h.inputs['wbTplPlatform'].value).toBe('instagram_square')
    h.click({ 'data-wb-act': 'tpl-use', 'data-wb-tpl': 'social_post' })
    await vi.waitFor(() => expect(uses(h)).toHaveLength(1))
    expect(uses(h)[0].platform).toBe('instagram_square')
  })

  it('a template list without a canvas template has no picker; a plain template sends no platform', async () => {
    const h = workbenchHarness()
    open(h, TPL.slice(0, 1))
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-tpl="letter"'))
    expect(h.html()).not.toContain('wbTplPlatform')
    h.click({ 'data-wb-act': 'tpl-use', 'data-wb-tpl': 'letter' })
    await vi.waitFor(() => expect(uses(h)).toHaveLength(1))
    expect(uses(h)[0]).toEqual({ project_id: 'p1', template: 'letter' })
  })

  it('has the new hint in Hungarian and English, naming the real menu', () => {
    const root = join(__dirname, '..', '..')
    const hu = readFileSync(join(root, 'web', 'lang', 'hu.js'), 'utf8')
    const en = readFileSync(join(root, 'web', 'lang', 'en.js'), 'utf8')
    expect(hu).toMatch(/"workbench\.tpl\.platform_hint": "[^"]*Átméretezés/)
    expect(en).toMatch(/"workbench\.tpl\.platform_hint": "[^"]*Resize/)
    expect(hu).toContain('"workbench.fr.size": "Átméretezés"')
    expect(en).toContain('"workbench.fr.size": "Resize"')
  })
})
