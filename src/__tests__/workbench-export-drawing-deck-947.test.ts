// #947: the Export / send menu must work for EVERY work item type.
//  - a drawing's picture was an inline <svg>, which Word / LibreOffice / RTF / EPUB drop: the file had no drawing;
//  - a presentation's export page only said "this page cannot show the file" (PDF, Word, mail, read-only link);
//  - the menu offered the internal .canvas.json / .deck.json as "the original file", and a TXT of a plain picture (empty).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { buildExportPage } from '../workbench-export.js'
import { commitCanvasChange } from '../workbench-canvas-store.js'
import { applyCanvasOps, emptyCanvas } from '../workbench-graphic.js'
import { applyDeckOps, deckStore, emptyDeck } from '../workbench-deck.js'
import { requestShare, shareToken, _setShareDeps } from '../workbench-share.js'
import { tryHandleWorkbenchShareView } from '../web/routes/workbench-share-view.js'
import type { RouteContext } from '../web/routes/types.js'

// The document page is rendered by LibreOffice in the real route; here its result is fixed, the wiring is what is tested.
vi.mock('../web/routes/workbench.js', () => ({
  // Like the real one: only a document-page item has such a page (a presentation / drawing has none).
  exportDocSource: async (id: string) => {
    const { getWorkItem: get } = await import('../workbench.js')
    return get(id)?.type === 'document' ? { docHtml: '<html><head><title>x</title></head><body><p>Szoveg-a-dokumentumbol</p></body></html>' } : {}
  },
}))

async function view(path: string): Promise<{ status: number; text: string }> {
  const chunks: Buffer[] = []
  const out = { status: 200 }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const done = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (st: number) => { out.status = st; return res }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const handled = await tryHandleWorkbenchShareView({ req, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext)
  if (handled) await done
  return { status: out.status, text: Buffer.concat(chunks).toString('utf-8') }
}

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

function svgImages(html: string): string[] {
  return [...html.matchAll(/<img src="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/g)].map((m) => Buffer.from(m[1] as string, 'base64').toString('utf-8'))
}

describe('the printable export page of a drawing and a presentation (#947)', () => {
  let depot = ''
  let pid = ''

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-exp947-'))
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Proba' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/teszt' }).ok) throw new Error('folder')
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a drawing is an <img> picture (Word/ODT keep it), never an inline <svg>', () => {
    const w = createWorkItem({ project_id: pid, title: 'Grafika', type: 'graphic' })
    if (!w.ok) throw new Error('item')
    const c = applyCanvasOps(emptyCanvas(800, 600), [{ op: 'add', type: 'rect', id: 'r', x: 50, y: 50, width: 300, height: 200, fill: '#3366cc' }])
    if (!c.ok) throw new Error('canvas')
    const saved = commitCanvasChange(w.item, c.doc, { source: 'owner', label: 'replace' })
    if (!saved.ok) throw new Error('save')
    const item = getWorkItem(w.item.id)!
    const page = buildExportPage(item, null, 'hu', { toolbar: false })
    expect(page.html).not.toMatch(/<svg\b/)
    const pics = svgImages(page.html)
    expect(pics).toHaveLength(1)
    expect(pics[0]).toContain('fill="#3366cc"')
  })

  it('a presentation page shows every slide, not the "cannot show the file" sentence', () => {
    const w = createWorkItem({ project_id: pid, title: 'Dia', type: 'presentation' })
    if (!w.ok) throw new Error('item')
    const r = applyDeckOps(emptyDeck(), [{ op: 'addSlide', layout: 'title', title: 'Cimdia', body: 'Alcim' }, { op: 'addSlide', layout: 'content', title: 'Masodik', body: 'Tartalom' }])
    if (!r.ok) throw new Error('deck')
    const sv = deckStore().save(w.item, r.doc, { createdBy: 'test' })
    if (!sv.ok) throw new Error('save ' + sv.code)
    const item = getWorkItem(w.item.id)!
    for (const lang of ['hu', 'en'] as const) {
      const page = buildExportPage(item, null, lang, { toolbar: false })
      expect(page.html).not.toContain('class="missing"')
      const pics = svgImages(page.html)
      expect(pics).toHaveLength(2)
      expect(pics[0]).toContain('Cimdia')
      expect(pics[1]).toContain('Masodik')
    }
  })

  it('the read-only link of a document shows the document text, not "no content yet"', async () => {
    _setShareDeps({ level: () => 3 })
    const w = createWorkItem({ project_id: pid, title: 'Dok', type: 'document' })
    if (!w.ok) throw new Error('item')
    const sh = requestShare({ kind: 'item', project_id: pid, work_item_id: w.item.id, days: 7, lang: 'hu', actor: 'teszt', owner: true })
    if (!sh.ok) throw new Error('share')
    const r = await view('/view/' + shareToken(sh.share.id))
    _setShareDeps()
    expect(r.status).toBe(200)
    expect(r.text).toContain('Szoveg-a-dokumentumbol')
    expect(r.text).not.toContain('még nincs tartalom')
  })

  it('the read-only link of a presentation shows the slides and offers no internal .deck.json download', async () => {
    _setShareDeps({ level: () => 3 })
    const w = createWorkItem({ project_id: pid, title: 'Dia', type: 'presentation' })
    if (!w.ok) throw new Error('item')
    const r0 = applyDeckOps(emptyDeck(), [{ op: 'addSlide', layout: 'title', title: 'Cimdia', body: 'Alcim' }])
    if (!r0.ok) throw new Error('deck')
    if (!deckStore().save(w.item, r0.doc, { createdBy: 'test' }).ok) throw new Error('save')
    const sh = requestShare({ kind: 'item', project_id: pid, work_item_id: w.item.id, days: 7, lang: 'hu', actor: 'teszt', owner: true })
    if (!sh.ok) throw new Error('share')
    const tok = shareToken(sh.share.id)
    const r = await view('/view/' + tok)
    const file = await view('/view/' + tok + '/file')
    _setShareDeps()
    expect(svgImages(r.text).some((x) => x.includes('Cimdia'))).toBe(true)
    expect(r.text).not.toContain('/file"')
    expect(file.status).not.toBe(200)
  })

  it('an empty presentation says it has no slides, not that the file cannot be shown', () => {
    const w = createWorkItem({ project_id: pid, title: 'Ures dia', type: 'presentation' })
    if (!w.ok) throw new Error('item')
    const page = buildExportPage(getWorkItem(w.item.id)!, null, 'hu', { toolbar: false })
    expect(page.html).not.toContain('nem tud megjeleníteni')
  })
})

describe('the Export / send menu offers only what works (#947)', () => {
  it('the "original file" link and the mail "original" attachment are not offered for the internal drawing / slide / timeline data', () => {
    expect(js).toMatch(/function exportHasOriginal\(/)
    const fn = /function exportHasOriginal\([\s\S]*?\n  \}/.exec(js)?.[0] ?? ''
    for (const k of ['canvas', 'deck', 'timeline']) expect(fn).toContain("'" + k + "'")
    // both uses go through the helper (the panel link and the mail attachment select)
    expect(js).toMatch(/\(exportHasOriginal\(p\) \? '<a class="btn-secondary" href="\/api\/life\/file/)
    expect(js).toMatch(/\(exportHasOriginal\(p\) \? '<option value="source"/)
  })

  it('a plain picture has no TXT export (it would be an empty file)', () => {
    expect(js).toMatch(/p\.kind === 'image'[^\n]*\? \['docx', 'odt', 'doc', 'rtf', 'epub'\]/)
  })
})
