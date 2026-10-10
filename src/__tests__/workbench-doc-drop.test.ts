// #508 (Boss TG 2920/2925, decision TG 2943): a file dropped on a document's page is built in (picture, Excel
// -> table, Word/ODT/text -> its paragraphs) or attached as an annex; video/zip can only be an annex. A picture
// on the page keeps a width and an alignment the owner set.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, documentOutline, imageBlockParts, imageBlockPathOk } from '../workbench-docmodel.js'
import { BLANK_TABLE_TEXT, embedKind, fileToBlocks, gridToTableText } from '../workbench-docembed.js'
import { buildFodt, type RenderOutline } from '../workbench-docrender.js'
import { buildZip } from '../web/zip-writer.js'
import { blankXlsx, readTable, writeTable } from '../workbench-table.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

function docx(body: string): Buffer {
  return buildZip([{ name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}<w:sectPr/></w:body></w:document>` }])
}

describe('fileToBlocks', () => {
  it('knows what can be built in', () => {
    expect(embedKind('a.JPG')).toBe('image')
    expect(embedKind('k.xlsx')).toBe('table')
    expect(embedKind('l.docx')).toBe('text')
    expect(embedKind('v.mp4')).toBeNull()
    expect(embedKind('x.zip')).toBeNull()
  })
  it('a Word file becomes its paragraphs, lists and tables, in order', () => {
    const buf = docx('<w:p><w:r><w:t>Tisztelt </w:t></w:r><w:r><w:t xml:space="preserve">Hivatal &amp; Co!</w:t></w:r></w:p>'
      + '<w:p/><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>elso pont</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nev</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Osszeg</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>A|B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '<w:p><w:r><w:t>Udv</w:t><w:br/><w:t>Laci</w:t></w:r></w:p>')
    const r = fileToBlocks(buf, 'level.docx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.blocks).toEqual([
      { kind: 'paragraph', text: 'Tisztelt Hivatal & Co!' },
      { kind: 'list', text: 'elso pont' },
      { kind: 'table', text: 'Nev | Osszeg\nA/B | 10' },
      { kind: 'paragraph', text: 'Udv\nLaci' },
    ])
  })
  it('an Excel file becomes a table per non-empty sheet, edges trimmed', () => {
    const base = blankXlsx('Munka1')
    const w = writeTable(base, 'k.xlsx', [{ name: 'Munka1', rows: [['Tetel', 'Ar', ''], ['Kenyer', '500', ''], ['', '', '']] }])
    expect(w.ok).toBe(true)
    if (!w.ok) return
    expect(readTable(w.data, 'k.xlsx').ok).toBe(true)
    const r = fileToBlocks(w.data, 'koltseg.xlsx')
    expect(r.ok && r.blocks).toEqual([{ kind: 'table', text: 'Tetel | Ar\nKenyer | 500' }])
  })
  it('an empty Excel file is still a table: a blank grid to fill in (TG 2970)', () => {
    const r = fileToBlocks(blankXlsx('Munka1'), 'New Microsoft Excel-munkalap.xlsx')
    expect(r).toMatchObject({ ok: true, emptyTable: true, truncated: false })
    expect(r.ok && r.blocks).toEqual([{ kind: 'table', text: BLANK_TABLE_TEXT }])
    expect(BLANK_TABLE_TEXT.split('\n')).toHaveLength(3)
    expect(fileToBlocks(Buffer.from(''), 'ures.csv')).toMatchObject({ ok: true, emptyTable: true })
    expect(fileToBlocks(docx(''), 'ures.docx')).toMatchObject({ ok: false, code: 'embed_empty' })
  })
  it('csv and plain text', () => {
    const c = fileToBlocks(Buffer.from('a;b\n1;2\n'), 'x.csv')
    expect(c.ok && c.blocks).toEqual([{ kind: 'table', text: 'a | b\n1 | 2' }])
    const t = fileToBlocks(Buffer.from('elso bekezdes\nfolytatas\n\n\nmasodik'), 'j.txt')
    expect(t.ok && t.blocks).toEqual([{ kind: 'paragraph', text: 'elso bekezdes\nfolytatas' }, { kind: 'paragraph', text: 'masodik' }])
  })
  it('a long table is cut and says so; a broken file is unreadable, not a crash', () => {
    const rows = Array.from({ length: 250 }, (_, i) => [String(i)])
    expect(gridToTableText(rows).truncated).toBe(true)
    expect(fileToBlocks(Buffer.from('not a zip'), 'x.docx')).toMatchObject({ ok: false, code: 'embed_unreadable' })
    expect(fileToBlocks(Buffer.from(''), 'v.mp4')).toMatchObject({ ok: false, code: 'embed_unsupported' })
  })
})

describe('picture size and alignment', () => {
  it('parses the suffix and keeps old blocks as they were', () => {
    expect(imageBlockParts('P/a.png')).toEqual({ path: 'P/a.png', width: null, align: 'c', x: null, y: null })
    expect(imageBlockParts('P/a.png#w=40&a=r')).toEqual({ path: 'P/a.png', width: 40, align: 'r', x: null, y: null })
    expect(imageBlockParts('P/a.png#w=5')).toEqual({ path: 'P/a.png', width: 10, align: 'c', x: null, y: null })
    expect(imageBlockPathOk('P/a.png#w=40&a=l')).toBe(true)
    expect(imageBlockPathOk('P/a.mp4#w=40&a=l')).toBe(false)
  })
  it('the PDF/Word copy uses the width and the alignment', () => {
    const data = Buffer.alloc(1)
    const o: RenderOutline = { sections: [{ title: 'K', status: 'draft', blocks: [
      { kind: 'image', text: 'P/a.png#w=50&a=r', img: { data, width: 4000, height: 2000, mime: 'image/png' } },
    ] }] } as RenderOutline
    const x = buildFodt(o, { title: 'T', author: null, draft: true, lang: 'hu' })
    expect(x).toContain('text:style-name="ImagePR"')
    expect(x).toContain('svg:width="8.25cm"')
  })
})

describe('POST /outline/drop', () => {
  let depot = ''
  let itemId = ''
  let sec = ''
  const upl = () => join(depot, 'Projektek', 'Iroda', 'Feltöltések')
  const drop = (body: Record<string, unknown>) => callWorkbench(`/api/workbench/items/${itemId}/outline/drop`, 'POST', body)
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-docdrop-'))
    mkdirSync(upl(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Level', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    const s = addSection(itemId, 'Bevezetes')
    if (!s.ok) throw new Error('fejezet')
    sec = s.section.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a csv built in becomes a table block at the drop point', async () => {
    writeFileSync(join(upl(), 'k.csv'), 'Tetel;Ar\nKenyer;500\n')
    const r = await drop({ path: 'Projektek/Iroda/Feltöltések/k.csv', mode: 'embed', section: sec, position: 0 })
    expect(r.status).toBe(201)
    expect(r.body.added).toBe(1)
    const blocks = documentOutline(itemId).sections[0]!.blocks
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([['table', 'Tetel | Ar\nKenyer | 500']])
  })
  it('an empty spreadsheet dropped on the page puts a blank table there', async () => {
    writeFileSync(join(upl(), 'u.xlsx'), blankXlsx('Munka1'))
    const r = await drop({ path: 'Projektek/Iroda/Feltöltések/u.xlsx', mode: 'embed', section: sec, position: 0 })
    expect(r.status).toBe(201)
    expect(r.body.empty_table).toBe(true)
    expect(documentOutline(itemId).sections[0]!.blocks.map((b) => b.kind)).toEqual(['table'])
  })
  it('a picture built in is an image block', async () => {
    writeFileSync(join(upl(), 'f.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const r = await drop({ path: 'Projektek/Iroda/Feltöltések/f.jpg', mode: 'embed', section: sec, position: 0 })
    expect(r.status).toBe(201)
    expect(documentOutline(itemId).sections[0]!.blocks[0]).toMatchObject({ kind: 'image', text: 'Projektek/Iroda/Feltöltések/f.jpg' })
  })
  it('a video can only be an annex', async () => {
    writeFileSync(join(upl(), 'v.mp4'), 'x')
    const e = await drop({ path: 'Projektek/Iroda/Feltöltések/v.mp4', mode: 'embed', section: sec })
    expect(e.status).toBe(400)
    expect(String(e.body.message)).toBeTruthy()
    const a = await drop({ path: 'Projektek/Iroda/Feltöltések/v.mp4', mode: 'annex' })
    expect(a.status).toBe(201)
    const again = await drop({ path: 'Projektek/Iroda/Feltöltések/v.mp4', mode: 'annex' })
    expect(again.status).toBe(400)
  })
  it('a missing file and a path outside the depot are refused with a sentence', async () => {
    const r = await drop({ path: 'Projektek/Iroda/nincs.docx', mode: 'embed', section: sec })
    expect(r.status).toBe(404)
    const out = await drop({ path: '../../etc/passwd', mode: 'embed', section: sec })
    expect(out.status).toBe(404)
  })
})

describe('#508 table block on the page (source contract)', () => {
  const js = readFileSync(join(process.cwd(), 'web', 'workbench.js'), 'utf8')
  it('shows a built-in table as a grid and opens it for editing on click', () => {
    expect(js).toContain('function dpTableHtml(')
    expect(js).toContain("else if (a === 'dp-tbl-edit') dpTblEdit(bid)")
  })
  it('Enter in a table block starts a new row instead of splitting the block', () => {
    expect(js).toContain("if (e.key === 'Enter' && isTable) return")
  })
})
