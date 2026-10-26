// #720 (Boss TG 3877-3886, decision 1A + 2A): a Word file (.docx / .doc / .odt / .rtf) is read onto the court document's
// page once, the original file stays untouched as the previous version, and every later save writes the SAME .docx.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, getProject, updateProject } from '../projects.js'
import { lifeMoveCandidates } from '../workbench-life-move.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { hasDocModel, listSections } from '../workbench-docmodel.js'
import { textProfileOf } from '../workbench-textdoc.js'
import { importWordToOutline, isWordImported, isWordProfileCandidate, isWordStorePath, parseWordHtml, reimportWordFromFile, wordImportWarnings, wordStoreDir, dismissWordWarnings } from '../workbench-worddoc.js'
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
  it('#777 follow-up: "Preformatted Text" paragraphs (one <pre>, a line per paragraph) stay separate paragraphs', () => {
    // What LibreOffice makes of a .txt saved as Word: the four paragraphs and the empty ones between used to run into one line.
    const p = parseWordHtml('<body lang="en-US"><pre class="western" style="text-align: left">Antwort an die Polizei\n\nSehr geehrte <b>Damen</b> und Herren,\n\nMit freundlichen Gruessen</pre><p>Danach.</p></body>')
    const blocks = p.sections[0]?.blocks ?? []
    expect(blocks.map((b) => b.text)).toEqual(['Antwort an die Polizei', '​', 'Sehr geehrte Damen und Herren,', '​', 'Mit freundlichen Gruessen', 'Danach.'])
    expect(blocks[2]?.rich).toContain('<b>Damen</b>')
    // The one line end right after <pre> is not an empty paragraph (HTML drops it).
    expect(parseWordHtml('<body><pre>\nEgy\nKettő</pre></body>').sections[0]?.blocks.map((b) => b.text)).toEqual(['Egy', 'Kettő'])
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
    // #781 (decision 2B): the owner's folder holds ONLY the owner's file -- no "(2).docx" copy, no picture files beside it.
    expect(readdirSync(join(depot, dirRel))).toEqual(['Antwort.docx'])
    // The item keeps its own file; the page's render is written into it.
    const fresh = getWorkItem(it0.id)!
    expect(fresh.source_path).toBe(rel)
    expect(readFileSync(join(depot, rel)).equals(original)).toBe(false)
    expect(textProfileOf(fresh)).toBe(true)
    // The state before is the previous version: a byte-for-byte copy in Marveen's own place (the System branch).
    const versions = getDb().prepare('SELECT source_path, version_no FROM work_item_versions WHERE work_item_id = ? ORDER BY version_no').all(it0.id) as { source_path: string; version_no: number }[]
    expect(versions).toHaveLength(2)
    expect(isWordStorePath(versions[0].source_path)).toBe(true)
    expect(versions[0].source_path.startsWith(wordStoreDir(it0.id) + '/')).toBe(true)
    expect(readFileSync(join(depot, versions[0].source_path)).equals(original)).toBe(true)
    expect(versions[1].source_path).toBe(rel)
    // The signature picture is in the same store folder, and the page points at it.
    const store = readdirSync(join(depot, wordStoreDir(it0.id)))
    expect(store.some((n) => /\.png$/i.test(n))).toBe(true)
    const pics = listSections(it0.id).flatMap((s) => getDb().prepare("SELECT text FROM wb_doc_blocks WHERE section_id = ? AND kind = 'image'").all(s.id) as { text: string }[])
    expect(pics.length).toBe(1)
    expect(isWordStorePath(pics[0].text)).toBe(true)
    // the "move to the Life tree" list offers the owner's file, never Marveen's own copy of the earlier state
    const cands = lifeMoveCandidates(getProject(pid)!, fresh)
    if (cands.ok) expect(cands.files.some((f) => isWordStorePath(f.rel))).toBe(false)
    const count = listSections(it0.id).length
    const again = await importWordToOutline(fresh, 'owner')
    expect(again.ok && again.imported).toBe(false)
    expect(listSections(it0.id).length).toBe(count)
  }, 240_000)

  it('#781: a hand edit in Word is read again WITHOUT a copy beside it; the edited state is the previous version in the store', async () => {
    const rel = await mkDocx('Levél.docx', '<html><body><h1>Eins</h1><p>Erster Text.</p></body></html>')
    const it0 = mkItem(rel, 'Levél')
    const r = await importWordToOutline(it0, 'owner')
    expect(r.ok).toBe(true)
    // the owner edits the file in Word (here: another real .docx written over it)
    const editedHtml = join(depot, 'edited.html')
    writeFileSync(editedHtml, '<html><body><h1>Eins</h1><p>Von Hand geändert.</p></body></html>', 'utf-8')
    const conv = await sofficeConvertFile(editedHtml, 'docx:MS Word 2007 XML', { outExt: 'docx', infilter: 'HTML (StarWriter)' })
    if (!conv.ok) throw new Error(`soffice: ${conv.code}`)
    writeFileSync(join(depot, rel), conv.data)
    const again = await reimportWordFromFile(getWorkItem(it0.id)!, 'owner')
    expect(again.ok && again.imported).toBe(true)
    expect(readdirSync(join(depot, dirRel))).toEqual(['Levél.docx'])
    const fresh = getWorkItem(it0.id)!
    expect(fresh.source_path).toBe(rel)
    const versions = getDb().prepare('SELECT source_path FROM work_item_versions WHERE work_item_id = ? ORDER BY version_no').all(it0.id) as { source_path: string }[]
    expect(versions).toHaveLength(3)
    expect(isWordStorePath(versions[1].source_path)).toBe(true)
    expect(readFileSync(join(depot, versions[1].source_path)).equals(conv.data)).toBe(true)
    const text = JSON.stringify(listSections(it0.id).map((s) => getDb().prepare('SELECT text FROM wb_doc_blocks WHERE section_id = ?').all(s.id)))
    expect(text).toContain('Von Hand geändert.')
  }, 240_000)

  it('#781: restoring the original and deleting the current version write into the OWN file; the item never points into the store', async () => {
    const rel = await mkDocx('Kérelem.docx', '<html><body><h1>Kérelem</h1><p>Eredeti mondat.</p></body></html>')
    const original = readFileSync(join(depot, rel))
    const it0 = mkItem(rel, 'Kérelem')
    const r = await importWordToOutline(it0, 'owner')
    expect(r.ok).toBe(true)
    const pageText = (): string => JSON.stringify(listSections(it0.id).map((s) => getDb().prepare('SELECT text FROM wb_doc_blocks WHERE section_id = ?').all(s.id)))
    // the page is edited and written into the file (what the mirror does), so the file now differs from the original
    const sec = listSections(it0.id).find((s) => s.title === 'Kérelem')!
    getDb().prepare('UPDATE wb_doc_blocks SET text = ? WHERE section_id = ?').run('Átírt mondat.', sec.id)
    writeFileSync(join(depot, rel), Buffer.concat([original, Buffer.from('x')]))
    const vers = () => getDb().prepare('SELECT id, source_path, version_no FROM work_item_versions WHERE work_item_id = ? ORDER BY version_no').all(it0.id) as { id: string; source_path: string; version_no: number }[]
    const v1 = vers()[0]
    expect(isWordStorePath(v1.source_path)).toBe(true)

    // restore v1 (the original, kept in the store) through the route
    const res = await callWorkbench(`/api/workbench/items/${it0.id}/versions/${v1.id}/restore`, 'POST', {})
    expect(res.status).toBe(201)
    let fresh = getWorkItem(it0.id)!
    expect(fresh.source_path).toBe(rel)
    expect(readFileSync(join(depot, rel)).equals(original)).toBe(true)
    expect(pageText()).toContain('Eredeti mondat.')
    expect(readdirSync(join(depot, dirRel))).toEqual(['Kérelem.docx'])
    const after = vers()
    expect(after).toHaveLength(3)
    expect(after[2].source_path).toBe(rel)
    expect(isWordStorePath(after[1].source_path)).toBe(true) // the state before the restore, kept
    expect(readFileSync(join(depot, after[1].source_path)).equals(Buffer.concat([original, Buffer.from('x')]))).toBe(true)
    expect(res.body.versions.find((v: { id: string }) => v.id === after[2].id).restored_from_no).toBe(1)

    // delete the current one: the state below (kept in the store) comes back into the OWN file
    const del = await callWorkbench(`/api/workbench/items/${it0.id}/versions/${after[2].id}`, 'DELETE')
    expect(del.status).toBe(200)
    expect(del.body.loaded.id).toBe(after[1].id)
    fresh = getWorkItem(it0.id)!
    expect(fresh.source_path).toBe(rel)
    expect(fresh.current_version_id).toBe(after[1].id)
    expect(vers().find((v) => v.id === after[1].id)!.source_path).toBe(rel)
    expect(readFileSync(join(depot, rel)).equals(Buffer.concat([original, Buffer.from('x')]))).toBe(true)
    expect(readdirSync(join(depot, dirRel))).toEqual(['Kérelem.docx'])
    expect(del.body.page_reloaded).toBe(true)

    // "upload the edited file": it goes INTO the own file (no "Kérelem (2).docx"), and the page is read from it
    const upHtml = join(depot, 'up.html')
    writeFileSync(upHtml, '<html><body><h1>Kérelem</h1><p>Feltöltött mondat.</p></body></html>', 'utf-8')
    const up = await sofficeConvertFile(upHtml, 'docx:MS Word 2007 XML', { outExt: 'docx', infilter: 'HTML (StarWriter)' })
    if (!up.ok) throw new Error(`soffice: ${up.code}`)
    const before = vers().length
    const u = await callWorkbench(`/api/workbench/items/${it0.id}/document?name=${encodeURIComponent('Kérelem (szerkesztett).docx')}`, 'POST', up.data)
    expect(u.status).toBe(201)
    expect(u.body.page_reloaded).toBe(true)
    expect(readdirSync(join(depot, dirRel))).toEqual(['Kérelem.docx'])
    expect(getWorkItem(it0.id)!.source_path).toBe(rel)
    expect(readFileSync(join(depot, rel)).equals(up.data)).toBe(true)
    expect(pageText()).toContain('Feltöltött mondat.')
    expect(vers()).toHaveLength(before + 1)
    expect(isWordStorePath(vers()[before - 1].source_path)).toBe(true) // the state before the upload, kept
  }, 240_000)

  it('#781: a file of another type uploaded to a Word item takes the usual road (a new file, no page re-read)', async () => {
    const rel = await mkDocx('Levél3.docx', '<html><body><h1>Levél</h1><p>Szöveg.</p></body></html>')
    const it0 = mkItem(rel, 'Levél3')
    expect((await importWordToOutline(it0, 'owner')).ok).toBe(true)
    const u = await callWorkbench(`/api/workbench/items/${it0.id}/document?name=${encodeURIComponent('Levél3.pdf')}`, 'POST', Buffer.from('%PDF-1.4 x'))
    expect(u.status).toBe(201)
    expect(u.body.page_reloaded).toBeUndefined()
  }, 240_000)

  // The other three extensions the card names, each made by LibreOffice (the card's comment had measured only .docx).
  const FORMATS: Array<{ ext: string; filter: string }> = [
    { ext: 'odt', filter: 'odt:writer8' },
    { ext: 'rtf', filter: 'rtf:Rich Text Format' },
    { ext: 'doc', filter: 'doc:MS Word 97' },
  ]
  for (const f of FORMATS) {
    it(`a real .${f.ext} is read onto the page, the original stays, the new current version is a .docx`, async () => {
      const htmlAbs = join(depot, 'src.html')
      writeFileSync(htmlAbs, '<html><body><h1>Sachverhalt</h1><p><b>Fett</b> und normal.</p><h1>Antrag</h1><ul><li>erstens</li><li>zweitens</li></ul></body></html>', 'utf-8')
      const conv = await sofficeConvertFile(htmlAbs, f.filter, { outExt: f.ext, infilter: 'HTML (StarWriter)' })
      if (!conv.ok) throw new Error(`soffice: ${conv.code} ${conv.detail}`)
      const rel = `${dirRel}/Brief.${f.ext}`
      writeFileSync(join(depot, rel), conv.data)
      const original = readFileSync(join(depot, rel))
      const it0 = mkItem(rel, 'Brief')
      expect(isWordProfileCandidate(it0)).toBe(true)
      const r = await importWordToOutline(it0, 'owner')
      expect(r.ok && r.imported).toBe(true)
      expect(listSections(it0.id).map((s) => s.title)).toEqual(expect.arrayContaining(['Sachverhalt', 'Antrag']))
      expect(readFileSync(join(depot, rel)).equals(original)).toBe(true)
      const fresh = getWorkItem(it0.id)!
      expect(String(fresh.source_path)).toMatch(/\.docx$/)
      expect(existsSync(join(depot, fresh.source_path as string))).toBe(true)
    }, 240_000)
  }

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
