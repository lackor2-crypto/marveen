// #720 (Boss TG 3877-3886, decision 1A + 2A): a Word file (.docx / .doc / .odt / .rtf) is read onto the court document's
// page once, the original file stays untouched as the previous version, and every later save writes the SAME .docx.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { hasDocModel, listSections } from '../workbench-docmodel.js'
import { textProfileOf } from '../workbench-textdoc.js'
import { importWordToOutline, isWordImported, isWordProfileCandidate, parseWordHtml, wordImportWarnings, dismissWordWarnings } from '../workbench-worddoc.js'
import { sofficeConvertFile } from '../office-convert.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { rmTempDir } from './helpers/rm-temp-dir.js'

const WEB = join(__dirname, '..', '..', 'web')
const src = (f: string): string => readFileSync(join(WEB, f), 'utf-8')
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('#720 parseWordHtml', () => {
  it('headings become chapters, paragraphs keep bold and alignment', () => {
    const p = parseWordHtml('<html><body><p>Előtte.</p><h1>Első</h1><p align="center"><b>Vastag</b> szöveg</p><h2>Második</h2><p>Kettő.</p></body></html>')
    expect(p.sections.map((s) => s.title).slice(1)).toEqual(['Első', 'Második'])
    expect(p.sections[0]?.blocks[0]?.text).toBe('Előtte.')
    const b = p.sections[1]?.blocks[0]
    expect(b?.text).toBe('Vastag szöveg')
    expect(b?.align).toBe('c')
    expect(b?.rich).toContain('<b>Vastag</b>')
    expect(p.warnings).toEqual([])
  })
  it('numbered and bullet lists, tables', () => {
    const p = parseWordHtml('<body><h1>K</h1><ol><li><p>egy</p></li><li><p>kettő</p></li></ol><ul><li>a</li><li>b</li></ul>'
      + '<table><tr><td><p>A1</p></td><td><p>B1</p></td></tr><tr><td>A2</td><td>B2</td></tr></table></body>')
    const blocks = p.sections[0]?.blocks ?? []
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'list', 'table'])
    expect(blocks[0]?.text).toBe('1. egy\n2. kettő')
    expect(blocks[1]?.text).toBe('a\nb')
    expect(blocks[2]?.text).toBe('A1 | B1\nA2 | B2')
  })
  it('a picture comes with its bytes; an unknown picture is a warning, not a silent loss', () => {
    const p = parseWordHtml(`<body><p>Név <img src="data:image/png;base64,${PNG}" style="width: 4cm"></p><p><img src="data:image/x-wmf;base64,AAAA"></p></body>`)
    const blocks = p.sections[0]?.blocks ?? []
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'image'])
    expect(blocks[1]?.picture?.mime).toBe('image/png')
    expect(blocks[1]?.picture?.widthCm).toBeCloseTo(4)
    expect(p.warnings).toContain('images_skipped')
  })
  it('header / footer and footnotes are left out and named', () => {
    const p = parseWordHtml('<body><div title="header"><p>FEJ</p></div><p>Törzs<a class="sdfootnoteanc" href="#sdfootnote1sym"><sup>1</sup></a></p>'
      + '<div id="sdfootnote1"><p>Lábjegyzet</p></div><div title="footer"><p>LÁB</p></div></body>')
    const all = JSON.stringify(p.sections)
    expect(all).toContain('Törzs')
    expect(all).not.toContain('FEJ')
    expect(all).not.toContain('LÁB')
    expect(p.warnings).toEqual(expect.arrayContaining(['header_footer', 'footnotes']))
  })
  it('an empty document gives no sections', () => {
    expect(parseWordHtml('<html><body></body></html>').sections).toEqual([])
  })
})

describe('#720 import of a real Word file (LibreOffice)', () => {
  let depot = ''
  let pid = ''
  const dirRel = 'Projektek/Iroda'
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-worddoc-'))
    mkdirSync(join(depot, dirRel), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: dirRel })
  })
  afterEach(() => { delete process.env['MARVEEN_DEPOT']; rmTempDir(depot) })

  /** A real .docx made by LibreOffice from HTML (CI installs libreoffice-writer-nogui). */
  const mkDocx = async (name: string, html: string): Promise<string> => {
    const htmlAbs = join(depot, 'src.html')
    writeFileSync(htmlAbs, html, 'utf-8')
    const r = await sofficeConvertFile(htmlAbs, 'docx:MS Word 2007 XML', { outExt: 'docx', infilter: 'HTML (StarWriter)' })
    if (!r.ok) throw new Error(`soffice: ${r.code} ${r.detail}`)
    writeFileSync(join(depot, dirRel, name), r.data)
    return `${dirRel}/${name}`
  }
  const mkItem = (rel: string, title = 'Antwort') => {
    const w = createWorkItem({ project_id: pid, title, type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(rel, w.item.id)
    return getWorkItem(w.item.id)!
  }

  it('reads the chapters onto the page, keeps the original, is idempotent', async () => {
    const rel = await mkDocx('Antwort.docx', '<html><body><h1>Sachverhalt</h1><p><b>Fett</b> und normal.</p>'
      + `<p>Unterschrift: <img src="data:image/png;base64,${PNG}" width="80"></p><h1>Antrag</h1><ol><li>erstens</li><li>zweitens</li></ol></body></html>`)
    const original = readFileSync(join(depot, rel))
    const it0 = mkItem(rel)
    expect(isWordProfileCandidate(it0)).toBe(true)
    expect(textProfileOf(it0)).toBe(false)
    const r = await importWordToOutline(it0, 'owner')
    expect(r.ok && r.imported).toBe(true)
    expect(hasDocModel(it0.id)).toBe(true)
    expect(isWordImported(it0.id)).toBe(true)
    const titles = listSections(it0.id).map((s) => s.title)
    expect(titles).toEqual(expect.arrayContaining(['Sachverhalt', 'Antrag']))
    // The original file is byte-for-byte untouched; the item now points at its own new .docx next to it.
    expect(readFileSync(join(depot, rel)).equals(original)).toBe(true)
    const fresh = getWorkItem(it0.id)!
    expect(fresh.source_path).not.toBe(rel)
    expect(String(fresh.source_path)).toMatch(/\.docx$/)
    expect(existsSync(join(depot, fresh.source_path as string))).toBe(true)
    expect(textProfileOf(fresh)).toBe(true)
    // The signature picture landed next to the file as a picture file.
    expect(readdirSync(join(depot, dirRel)).some((n) => /\.png$/i.test(n))).toBe(true)
    const count = listSections(it0.id).length
    const again = await importWordToOutline(fresh, 'owner')
    expect(again.ok && again.imported).toBe(false)
    expect(listSections(it0.id).length).toBe(count)
  }, 240_000)

  it('the route: text_profile.word, text-import 201 then 200, warnings can be closed', async () => {
    const rel = await mkDocx('Brief.docx', '<html><body><h1>Brief</h1><p>Text.</p></body></html>')
    const it0 = mkItem(rel, 'Brief')
    const d0 = await callWorkbench(`/api/workbench/items/${it0.id}`, 'GET')
    expect(d0.body.text_profile).toMatchObject({ on: false, candidate: true, word: true })
    const a = await callWorkbench(`/api/workbench/items/${it0.id}/text-import`, 'POST', {})
    expect(a.status).toBe(201)
    const b = await callWorkbench(`/api/workbench/items/${it0.id}/text-import`, 'POST', {})
    expect(b.status).toBe(200)
    const d1 = await callWorkbench(`/api/workbench/items/${it0.id}`, 'GET')
    expect(d1.body.text_profile).toMatchObject({ on: true, word: true })
    expect(d1.body.outline).not.toBeNull()
    getDb().prepare(`UPDATE wb_word_import SET warnings = '["header_footer"]' WHERE work_item_id = ?`).run(it0.id)
    expect(wordImportWarnings(it0.id)).toEqual(['header_footer'])
    const c = await callWorkbench(`/api/workbench/items/${it0.id}/text-import`, 'POST', { dismiss_warnings: true })
    expect(c.status).toBe(200)
    expect(wordImportWarnings(it0.id)).toEqual([])
    dismissWordWarnings(it0.id)
  }, 240_000)

  it('a missing file is a readable error, nothing changes', async () => {
    const it0 = mkItem(`${dirRel}/Nincs.docx`)
    const r = await callWorkbench(`/api/workbench/items/${it0.id}/text-import`, 'POST', {})
    expect(r.status).toBe(404)
    expect(String(r.body.message || '')).not.toBe('')
    expect(hasDocModel(it0.id)).toBe(false)
  })

  it('a fresh install: a court document without a file is not a Word candidate', () => {
    const w = createWorkItem({ project_id: pid, title: 'Beadvány', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    expect(isWordProfileCandidate(getWorkItem(w.item.id)!)).toBe(false)
  })
})

describe('#720 front end (source guard)', () => {
  const js = src('workbench.js')
  it('a Word item not yet on the page shows the reading note, not the old Word editor', () => {
    expect(js).toMatch(/wtp && wtp\.word && wtp\.candidate && !wtp\.on/)
    expect(js).toContain("data-wb-act=\"word-warn-dismiss\"")
  })
  it('every new text is in both languages', () => {
    const keys = ['reading', 'warn_lead', 'warn_original', 'warn_ok', 'warn.header_footer', 'warn.text_box', 'warn.columns',
      'warn.footnotes', 'warn.images_skipped', 'warn.nested_tables', 'warn.too_long']
    for (const k of keys) {
      expect(src('lang/hu.js')).toContain(`"workbench.worddoc.${k}"`)
      expect(src('lang/en.js')).toContain(`"workbench.worddoc.${k}"`)
    }
  })
})
