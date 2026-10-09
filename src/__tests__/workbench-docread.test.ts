// #441 (v4 spec 1/A, K-1.1 ... K-1.6): az iratok oldalankenti olvasasa.
// Eddig a Munkapad agentje csak sima szoveget olvasott; a szovegfelismeres
// csak a Beerkezo iratrendezoben futott, ott is csak a PDF elso 2 oldalan.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import {
  docKind, tsvConfidence, meaningfulChars, startDocRead, getDocPages, docReadSummary, ensureDocReadTables,
  documentOverview, documentPagesText, sha256OfFile, DOCREAD_VERSION, DOCUMENT_READ_MAX_CHARS, LONG_DOCUMENT_PAGES,
} from '../workbench-docread.js'
import { attachAsset, listWorkItemAssets, unlinkAsset, listWorkItemAssetsSynced } from '../workbench-assets.js'
import { which } from '../life-inbox-systools.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { buildContext } from '../workbench-agent/context.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const FIXTURE = join(__dirname, 'fixtures', 'docread-mixed.pdf')
const haveReader = !!(which('pdftotext') && which('pdfinfo') && which('pdftoppm') && which('tesseract'))

/** Egy kesz olvasas beirasa kozvetlenul (a lapozast es a jeloleseket kulso program nelkul teszteljuk). */
function seedRead(abs: string, name: string, pages: { text: string; method?: string; confidence?: number | null; low?: boolean }[]): string {
  ensureDocReadTables()
  const sha = sha256OfFile(abs)
  const db = getDb()
  db.prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
    VALUES (?, ?, 'pdf', 'done', ?, ?, NULL, ?, 0)`).run(sha, name, pages.length, pages.length, DOCREAD_VERSION)
  pages.forEach((p, i) => db.prepare('INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha, i + 1, p.text, p.method || 'text', p.confidence ?? null, p.low ? 1 : 0))
  return sha
}

describe('segedfuggvenyek', () => {
  it('fajtankent: PDF, irodai fajl, fotozott irat, e-mail; a sima szoveg nem ide tartozik', () => {
    expect(docKind('level.pdf')).toBe('pdf')
    expect(docKind('Szerzodes.DOCX')).toBe('office')
    expect(docKind('beadvany.odt')).toBe('office')
    expect(docKind('foto.jpg')).toBe('image')
    expect(docKind('level.eml')).toBe('email')
    expect(docKind('jegyzet.md')).toBe(null)
    expect(docKind('film.mp4')).toBe(null)
  })

  it('a tesseract TSV-bol hosszal sulyozott atlagos megbizhatosag; a -1 (nem szo) sor nem szamit', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t',
      '5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t90\tTermin',
      '5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t30\tam',
    ].join('\n')
    expect(tsvConfidence(tsv)).toBe(Math.round(((90 * 6 + 30 * 2) / 8) * 10) / 10)
    expect(tsvConfidence('fejlec\n')).toBe(null)
    expect(meaningfulChars(' -- . , ')).toBe(0)
    expect(meaningfulChars('Árvíztűrő 12')).toBe(11)
  })
})

describe('olvasas es nezet', () => {
  let dir = ''
  beforeEach(() => {
    initDatabase(':memory:')
    dir = mkdtempSync(join(tmpdir(), 'marveen-docread-'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it.skipIf(!haveReader)('K-1.1/K-1.2: vegyes PDF -- a szoveges oldal a szovegretegbol, a szkennelt oldal szovegfelismeressel, oldalankent, megbizhatosaggal', async () => {
    const abs = join(dir, 'idezes.pdf')
    copyFileSync(FIXTURE, abs)
    const s = startDocRead(abs, 'idezes.pdf')
    expect(s.ok).toBe(true)
    if (!s.ok) return
    await s.done
    const pages = getDocPages(s.sha)
    expect(pages.map((p) => p.method)).toEqual(['text', 'ocr'])
    expect(pages[0].text).toContain('Die Klage wird abgewiesen.')
    expect(pages[1].text).toMatch(/17\. M.rz 2027 um 10:30 Uhr/)
    expect(pages[1].text).toContain('március 17')
    expect(pages[1].confidence).toBeGreaterThan(70)
    expect(docReadSummary(s.sha)).toMatchObject({ status: 'done', pages_total: 2, pages_done: 2, ocr_pages: 1, low_pages: [] })
    // Masodszor nem dolgozza fel ujra (ugyanaz a tartalom).
    const again = startDocRead(abs, 'idezes.pdf')
    expect(again.ok && again.started).toBe(false)
    // Atnevezve is ugyanaz az eredmeny: a tartalom szamit, nem a nev.
    const moved = join(dir, 'masik nev.pdf')
    copyFileSync(abs, moved)
    const m = startDocRead(moved, 'masik nev.pdf')
    expect(m.ok && m.started).toBe(false)
  }, 120_000)

  it('ami nem irat, azt nem veszi at (a sima szoveg a file.read-e); a hianyzo fajl megnevezett hiba', () => {
    writeFileSync(join(dir, 'a.md'), '# x')
    expect(startDocRead(join(dir, 'a.md'), 'a.md')).toEqual({ ok: false, code: 'not_a_document' })
    expect(startDocRead(join(dir, 'nincs.pdf'), 'nincs.pdf')).toEqual({ ok: false, code: 'missing' })
  })

  it('K-1.2: az oldalak szo szerint, [fajl:oldal] jelolessel; a keret felett a next_page mondja, honnan folytassa', () => {
    const abs = join(dir, 'hosszu.pdf')
    writeFileSync(abs, 'PDF-1')
    seedRead(abs, 'hosszu.pdf', [{ text: 'elso oldal' }, { text: 'x'.repeat(DOCUMENT_READ_MAX_CHARS - 12) }, { text: 'harmadik' }])
    const r = documentPagesText(abs, 'hosszu.pdf', 1, 3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = r.data as { page_texts: { ref: string; text: string }[]; next_page: number | null; to: number }
    expect(d.page_texts.map((p) => p.ref)).toEqual(['[hosszu.pdf:1]', '[hosszu.pdf:2]'])
    expect(d.page_texts[0].text).toBe('elso oldal')
    expect(d.next_page).toBe(3)
    const tail = documentPagesText(abs, 'hosszu.pdf', 3, 3)
    expect(tail.ok && (tail.data as { page_texts: { text: string }[] }).page_texts[0].text).toBe('harmadik')
    const over = documentPagesText(abs, 'hosszu.pdf', 9, 9)
    expect(over).toMatchObject({ ok: false, code: 'bad_input' })
  })

  it('K-1.3: a gyenge oldal figyelmeztetest kap, es az attekintes megnevezi', () => {
    const abs = join(dir, 'rossz.pdf')
    writeFileSync(abs, 'PDF-2')
    seedRead(abs, 'rossz.pdf', [{ text: 'jo oldal' }, { text: 'h4l0 v4n', method: 'ocr', confidence: 41, low: true }])
    const o = documentOverview(abs, 'rossz.pdf')
    expect(o.ok && o.data).toMatchObject({ pages: 2, low_confidence_pages: [2] })
    expect(o.ok && String(o.data.note)).toContain('pages 2 are hard to read')
    const t = documentPagesText(abs, 'rossz.pdf', 2, 2)
    const p = t.ok ? (t.data as { page_texts: { warning?: string }[] }).page_texts[0] : null
    expect(p?.warning).toMatch(/Do NOT use it as a source of facts/)
  })

  it('K-1.6: hosszu iratnal az attekintes tartalomjegyzek (rovid kezdosorok), es ezt ki is mondja', () => {
    const abs = join(dir, 'nagy.pdf')
    writeFileSync(abs, 'PDF-3')
    seedRead(abs, 'nagy.pdf', Array.from({ length: LONG_DOCUMENT_PAGES + 5 }, (_, i) => ({ text: `${i + 1}. oldal ` + 'szo '.repeat(100) })))
    const o = documentOverview(abs, 'nagy.pdf')
    expect(o.ok).toBe(true)
    if (!o.ok) return
    const list = o.data.page_list as { starts_with: string }[]
    expect(list).toHaveLength(LONG_DOCUMENT_PAGES + 5)
    expect(list.every((p) => p.starts_with.length <= 80)).toBe(true)
    expect(String(o.data.note)).toContain('table of contents')
  })

  it('amig olvassa, azt mondja, hogy folyamatban -- nem ad ures szoveget', async () => {
    const abs = join(dir, 'uj.pdf')
    writeFileSync(abs, 'nem igazi pdf')
    const o = documentOverview(abs, 'uj.pdf')
    expect(o).toMatchObject({ ok: false, code: 'processing' })
    // A hibas fajl utana megnevezett hibaval all meg, nem ragad be.
    const s = startDocRead(abs, 'uj.pdf')
    if (s.ok) await s.done.catch(() => undefined)
    await vi.waitFor(() => expect(docReadSummary(sha256OfFile(abs)).status).toBe('failed'))
    const f = documentOverview(abs, 'uj.pdf')
    expect(f).toMatchObject({ ok: false, code: 'failed' })
  })
})

describe('a munkadarab anyagai es az agent', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-docread-'))
    mkdirSync(projDir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    project = getProject(pid) as ProjectRow
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function newItem(title = 'Birosagi level') {
    const w = createWorkItem({ project_id: pid, title, type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    return w.item
  }

  it('a PDF mostantol "olvashato", a lista az olvasas allapotat is adja; egy logo nem indul magatol irat-olvasasra', async () => {
    const item = newItem()
    attachAsset(item, 'level.pdf', Buffer.from('PDF-a'))
    attachAsset(item, 'logo.png', Buffer.from('PNG'))
    const abs = join(projDir(), 'Munkadarabok', 'Birosagi level', 'level.pdf')
    seedRead(abs, 'level.pdf', [{ text: 'a' }, { text: 'b', method: 'ocr', confidence: 50, low: true }])
    const r = await callWorkbench(`/api/workbench/items/${item.id}/assets`, 'GET')
    const pdf = r.body.assets.find((a: { name: string }) => a.name === 'level.pdf')
    expect(pdf.support).toBe('readable')
    expect(pdf.doc).toMatchObject({ status: 'done', pages_total: 2, low_pages: [2] })
    const logo = r.body.assets.find((a: { name: string }) => a.name === 'logo.png')
    expect(logo.doc).toBe(null)
  })

  it('document.pages / document.read: olvaso eszkozok, [fajl:oldal] hivatkozassal; a kontextus mondja az oldalszamot', async () => {
    expect(getTool('document.pages')?.autonomyCategory).toBe(null)
    expect(getTool('document.read')?.autonomyCategory).toBe(null)
    const item = newItem()
    attachAsset(item, 'level.pdf', Buffer.from('PDF-b'))
    seedRead(join(projDir(), 'Munkadarabok', 'Birosagi level', 'level.pdf'), 'level.pdf', [{ text: 'Termin: 17. Maerz 2027' }, { text: 'Seite zwei' }])
    const ctx = { projectId: pid, workItemId: item.id, lang: 'hu' as const }
    const o = executeTool('document.pages', { path: 'Munkadarabok/Birosagi level/level.pdf' }, ctx)
    expect(o.ok && o.data).toMatchObject({ pages: 2, path: 'Munkadarabok/Birosagi level/level.pdf' })
    const t = executeTool('document.read', { path: 'Munkadarabok/Birosagi level/level.pdf', from: 2 }, ctx)
    expect(t.ok && (t.data as { page_texts: { ref: string; text: string }[] }).page_texts).toEqual([
      expect.objectContaining({ ref: '[level.pdf:2]', text: 'Seite zwei' }),
    ])
    const out = executeTool('document.read', { path: '../../titok.pdf' }, ctx)
    expect(out.ok).toBe(false)
    const c = await buildContext(project, item, 'hu')
    expect(c.contextText).toContain('Munkadarabok/Birosagi level/level.pdf [readable, document: 2 page(s)')
  })

  it('a teljes erteku ugynok vegpontja: ugyanaz a szoveg; a projekt mappajan kivulre nem visz', async () => {
    const item = newItem()
    attachAsset(item, 'level.pdf', Buffer.from('PDF-c'))
    seedRead(join(projDir(), 'Munkadarabok', 'Birosagi level', 'level.pdf'), 'level.pdf', [{ text: 'egy' }])
    const p = encodeURIComponent('Munkadarabok/Birosagi level/level.pdf')
    const ov = await callWorkbench(`/api/workbench/items/${item.id}/document?path=${p}`, 'GET')
    expect(ov.status).toBe(200)
    expect(ov.body.pages).toBe(1)
    const tx = await callWorkbench(`/api/workbench/items/${item.id}/document?path=${p}&from=1`, 'GET')
    expect(tx.body.page_texts[0]).toMatchObject({ ref: '[level.pdf:1]', text: 'egy' })
    writeFileSync(join(depot, 'titok.pdf'), 'x')
    const bad = await callWorkbench(`/api/workbench/items/${item.id}/document?path=${encodeURIComponent('../../titok.pdf')}`, 'GET')
    expect(bad.status).toBeGreaterThanOrEqual(400)
  })

  it('HIBAJAVITAS: a levett anyag a kovetkezo listazasnal NEM kerul vissza a mappa-szinkronnal; ujra csatolva visszajon', () => {
    const item = newItem()
    const a = attachAsset(item, 'jegyzet.md', Buffer.from('# j'))
    if (!a.ok) throw new Error('csatolas')
    expect(unlinkAsset(item.id, a.asset.id)).toBe(true)
    expect(listWorkItemAssetsSynced(item.id)).toEqual([])
    expect(listWorkItemAssets(item.id)).toEqual([])
    const again = attachAsset(item, 'masik.md', Buffer.from('# m'))
    expect(again.ok).toBe(true)
    expect(listWorkItemAssetsSynced(item.id).map((x) => x.name)).toEqual(['masik.md'])
  })
})

describe('a felulet: az irat allapota a fajl mellett', () => {
  it('kesz irat: oldalszam es a gyenge oldalak; folyamatban: "olvasas 3/30"; hiba: megnevezve', async () => {
    const h = workbenchHarness()
    const ITEM = { id: 'w1', title: 'Level', type: 'note', status: 'draft', current_version_id: 'v1', folder: 'Level', source_path: null }
    const base = { path: 'P/Level/x', present: true, shared: false, support: 'readable' }
    const ASSETS = [
      { ...base, id: 'a1', name: 'kesz.pdf', doc: { status: 'done', pages_total: 12, pages_done: 12, low_pages: [4, 7], ocr_pages: 3, error: null } },
      { ...base, id: 'a2', name: 'fut.pdf', doc: { status: 'running', pages_total: 30, pages_done: 3, low_pages: [], ocr_pages: 0, error: null } },
      { ...base, id: 'a3', name: 'hibas.pdf', doc: { status: 'failed', pages_total: 0, pages_done: 0, low_pages: [], ocr_pages: 0, error: 'pdfinfo: broken' } },
    ]
    h.respond((url) => {
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: ASSETS } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-assets-block'))
    const html = h.html()
    expect(html).toContain('workbench.doc.pages')
    expect(html).toContain('workbench.doc.low')
    expect(html).toContain('workbench.doc.reading_n')
    expect(html).toContain('workbench.doc.failed')
    expect(html).toContain('title="pdfinfo: broken"')
  })
})
