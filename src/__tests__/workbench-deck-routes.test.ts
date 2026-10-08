// Presentation deck over HTTP: working copy, undo, versions, slide pictures, PPTX/PDF export.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { applyDeckOps, emptyDeck } from '../workbench-deck.js'
import { buildDeckPptx } from '../workbench-deck-pptx.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

const HAVE_SOFFICE = spawnSync('soffice', ['--version']).status === 0
/** A LibreOffice with only the text part (Writer) installed cannot open a PPTX: the PDF test needs the presentation part (Impress). */
function haveImpress(): boolean {
  if (!HAVE_SOFFICE) return false
  const d = mkdtempSync(join(tmpdir(), 'marveen-impress-'))
  try {
    const deck = applyDeckOps(emptyDeck(), [{ op: 'addSlide', layout: 'title', title: 'x' }])
    if (!deck.ok) return false
    writeFileSync(join(d, 'p.pptx'), buildDeckPptx(deck.doc, () => null).bytes)
    const r = spawnSync('soffice', ['--headless', '--norestore', `-env:UserInstallation=file://${d}/profile`, '--convert-to', 'pdf', '--outdir', d, join(d, 'p.pptx')], { timeout: 120_000 })
    return r.status === 0 && existsSync(join(d, 'p.pdf'))
  } catch { return false } finally { rmSync(d, { recursive: true, force: true }) }
}
const HAVE_IMPRESS = haveImpress()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGM4ISeHFTFQTwIAbv4ggUBHKgEAAAAASUVORK5CYII=', 'base64')

describe('presentation deck: the routes', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const dir = () => join(depot, 'Projektek', 'teszt')
  const url = (tail = '') => `/api/workbench/items/${itemId}/deck${tail}`
  const json = { 'content-type': 'application/json' }

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-deck-'))
    mkdirSync(dir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Kovács ház' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/teszt' }).ok) throw new Error('folder')
    const w = createWorkItem({ project_id: pid, title: 'Közgyűlés', type: 'presentation' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const ops = (list: unknown[]) => callWorkbench(url('/ops'), 'POST', JSON.stringify({ ops: list }), json)

  it('a fresh presentation has an empty deck (not an error); the first edit creates the file and version 1', async () => {
    const g = await callWorkbench(url(), 'GET')
    expect(g.status).toBe(200)
    expect(g.body).toMatchObject({ exists: false, deck: { slides: [], size: '16:9' } })
    const r = await ops([{ op: 'addSlide', layout: 'title', title: 'Közgyűlés', body: '2026' }])
    expect(r.status).toBe(201)
    expect(r.body.created).toBe(true)
    // Boss TG 2929 (rule): the JSON sits next to the item -- a folderless item's place is the work-items box, never the root.
    const box = readdirSync(dir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)[0] || ''
    expect(readdirSync(dir()).filter((n) => n.endsWith('.json'))).toEqual([])
    expect(readdirSync(join(dir(), box))).toEqual(['kozgyules.deck.json'])
    const r2 = await ops([{ op: 'addSlide', layout: 'content', title: 'Napirend', body: 'Első' }])
    expect(r2.status).toBe(200)
    expect(r2.body.created).toBe(false)
    expect(r2.body.deck.slides).toHaveLength(2)
    expect(readdirSync(join(dir(), box))).toEqual(['kozgyules.deck.json'])
  })

  it('a slide is a picture: SVG with its text; an unknown slide is 404', async () => {
    await ops([{ op: 'addSlide', layout: 'title', title: 'Szia világ' }])
    const res = await callWorkbench(url('/slide/d1.svg'), 'GET')
    expect(res.status).toBe(200)
    expect(String(res.raw ?? res.text ?? JSON.stringify(res.body))).toContain('Szia világ')
    expect((await callWorkbench(url('/slide/nincs.svg'), 'GET')).status).toBe(404)
  })

  it('edits one slide with the canvas operations; undo and redo replay the step; the version button names a milestone', async () => {
    await ops([{ op: 'addSlide', layout: 'blank' }])
    await ops([{ op: 'slide', id: 'd1', ops: [{ op: 'add', type: 'rect', id: 'doboz', x: 10, y: 10, width: 100, height: 50, fill: '#ff0000' }] }])
    const u = await callWorkbench(url('/undo'), 'POST')
    expect(u.status).toBe(200)
    expect(u.body.deck.slides[0].canvas.objects).toEqual([])
    const re = await callWorkbench(url('/redo'), 'POST')
    expect(re.body.deck.slides[0].canvas.objects).toHaveLength(1)
    const v = await callWorkbench(url('/version'), 'POST', JSON.stringify({ label: 'első váz' }), json)
    expect(v.status).toBe(201)
    expect((await callWorkbench(url('/undo'), 'POST')).status).toBe(200)
    expect((await callWorkbench(url('/undo'), 'POST')).status).toBe(200)
    const none = await callWorkbench(url('/undo'), 'POST')
    expect(none.status).toBe(409)
    expect(none.body.message).toMatch(/Nincs mit visszavonni/)
  })

  it('bad operations are 400 with a human sentence; a non-presentation item has no deck', async () => {
    const bad = await ops([{ op: 'addSlide', layout: 'cirkusz' }])
    expect(bad.status).toBe(400)
    expect(bad.body.message).toMatch(/elrendezése/)
    const w = createWorkItem({ project_id: pid, title: 'Levél', type: 'document' })
    if (!w.ok) throw new Error('item')
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/deck`, 'GET')
    expect(r.status).toBe(409)
    expect(r.body.message).toMatch(/prezentáció típusú/)
  })

  it('exports a native PPTX as a NEW file; the picture and the notes are inside; a second export never overwrites', async () => {
    writeFileSync(join(dir(), 'logo.png'), PNG)
    await ops([{ op: 'addSlide', layout: 'title', title: 'Közgyűlés' }, { op: 'addSlide', layout: 'blank' }])
    await ops([
      { op: 'slide', id: 'd2', ops: [{ op: 'add', type: 'image', id: 'logo', src: 'logo.png', x: 100, y: 100, width: 400, height: 200 }] },
      { op: 'setNotes', id: 'd2', notes: 'Mondd el röviden' },
    ])
    const r = await callWorkbench(url('/export'), 'POST', JSON.stringify({ format: 'pptx' }), json)
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ format: 'pptx', slides: 2, warnings: [] })
    expect(r.body.file.name).toBe('kozgyules.pptx')
    const bytes = readFileSync(join(depot, r.body.file.rel))
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    const names = spawnSync('unzip', ['-Z1', join(depot, r.body.file.rel)]).stdout.toString()
    expect(names).toContain('ppt/slides/slide2.xml')
    expect(names).toContain('ppt/media/image1.png')
    expect(names).toContain('ppt/notesSlides/notesSlide2.xml')
    const again = await callWorkbench(url('/export'), 'POST', JSON.stringify({ format: 'pptx' }), json)
    expect(again.body.file.name).toBe('kozgyules (2).pptx')
  })

  it('a missing picture is named in the warnings, a grey box stands in; the export still works', async () => {
    await ops([{ op: 'addSlide', layout: 'blank' }])
    await ops([{ op: 'slide', id: 'd1', ops: [{ op: 'add', type: 'image', id: 'x', src: 'nincs.png', x: 0, y: 0, width: 100, height: 100 }] }])
    const r = await callWorkbench(url('/export'), 'POST', JSON.stringify({ format: 'pptx' }), json)
    expect(r.status).toBe(201)
    expect(r.body.warnings[0]).toContain('nincs.png')
  })

  it('refuses an empty deck and a bad format with a sentence', async () => {
    const empty = await callWorkbench(url('/export'), 'POST', JSON.stringify({ format: 'pptx' }), json)
    expect(empty.status).toBe(400)
    expect(empty.body.message).toMatch(/nincs dia/)
    await ops([{ op: 'addSlide' }])
    const bad = await callWorkbench(url('/export'), 'POST', JSON.stringify({ format: 'doc' }), json)
    expect(bad.status).toBe(400)
    expect(bad.body.message).toMatch(/PPTX/)
  })

  it.skipIf(!HAVE_IMPRESS)('exports a PDF with one page per slide (LibreOffice converts the same PPTX)', async () => {
    await ops([{ op: 'addSlide', layout: 'title', title: 'Egy' }, { op: 'addSlide', layout: 'content', title: 'Kettő', body: 'x' }, { op: 'addSlide', layout: 'blank' }])
    const r = await callWorkbench(url('/export'), 'POST', JSON.stringify({ format: 'pdf' }), json)
    expect(r.status).toBe(201)
    expect(r.body.file.name).toBe('kozgyules.pdf')
    const abs = join(depot, r.body.file.rel)
    expect(readFileSync(abs).subarray(0, 4).toString()).toBe('%PDF')
    const info = spawnSync('pdfinfo', [abs]).stdout.toString()
    if (info) expect(info).toMatch(/Pages:\s+3/)
  }, 120000)
})
