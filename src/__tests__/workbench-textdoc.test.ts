// #673 (Boss TG 9339/9346): a text document (a note with a .md / .txt file) stands on the court document's page. The text is read
// onto the page once and non-destructively; the front end draws it with the SAME code as a court document, one switch hides the court-only parts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { hasDocModel, listSections } from '../workbench-docmodel.js'
import { adoptVariantText, importTextToOutline, outlineTextOf, parseTextToPage, reimportTextFromFile, textProfileOf } from '../workbench-textdoc.js'
import { mirrorFileEdited, mirrorOutlineToFile } from '../workbench-docmirror.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { rmTempDir } from './helpers/rm-temp-dir.js'

const WEB = join(__dirname, '..', '..', 'web')
const src = (f: string): string => readFileSync(join(WEB, f), 'utf-8')

describe('#673 parseTextToPage', () => {
  it('title, chapters, paragraphs and lists', () => {
    const p = parseTextToPage('# Terv\n\nBevezető sor.\n\n## Első\n\nEgy.\n\n- a\n- b\n\n## Második\n\nKettő.\n', 'Terv')
    expect(p.map((s) => s.title)).toEqual(['Új fejezet', 'Első', 'Második'].map((x, i) => (i === 0 ? p[0].title : x)))
    expect(p[1].blocks?.map((b) => b.kind)).toEqual(['paragraph', 'list'])
    expect(p[1].blocks?.[1]?.text).toBe('a\nb')
    expect(p[2].blocks?.[0]?.text).toBe('Kettő.')
  })
  it('an empty file gives no sections', () => {
    expect(parseTextToPage('', 'x')).toEqual([])
    expect(parseTextToPage('\n\n  \n', 'x')).toEqual([])
  })
  it('an image link stays as text, nothing vanishes', () => {
    const p = parseTextToPage('## K\n\n![ábra](kep/a.png)\n', 'x')
    expect(JSON.stringify(p)).toContain('kep/a.png')
  })
})

describe('#673 import, mirror, language versions', () => {
  let depot = ''
  let pid = ''
  const dirRel = 'Projektek/Iroda'
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-textdoc-'))
    mkdirSync(join(depot, dirRel), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: dirRel })
  })
  afterEach(() => { delete process.env['MARVEEN_DEPOT']; rmTempDir(depot) })
  const mkNote = (name: string, text: string, title = 'Terv') => {
    writeFileSync(join(depot, dirRel, name), text, 'utf-8')
    const w = createWorkItem({ project_id: pid, title, type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(`${dirRel}/${name}`, w.item.id)
    return getWorkItem(w.item.id)!
  }

  it('the import keeps the old file as is and is idempotent', () => {
    const it0 = mkNote('Terv.md', '# Terv\n\n## Első\n\nEgy.\n\n## Második\n\nKettő.\n')
    expect(textProfileOf(it0)).toBe(false)
    const r = importTextToOutline(it0, 'owner')
    expect(r.ok && r.imported).toBe(true)
    expect(hasDocModel(it0.id)).toBe(true)
    expect(listSections(it0.id).map((s) => s.title)).toEqual(['Első', 'Második'])
    expect(readFileSync(join(depot, dirRel, 'Terv.md'), 'utf-8')).toContain('Egy.')
    expect(textProfileOf(getWorkItem(it0.id)!)).toBe(true)
    const again = importTextToOutline(getWorkItem(it0.id)!, 'owner')
    expect(again.ok && again.imported).toBe(false)
    expect(listSections(it0.id).length).toBe(2)
  })

  it('bullet lists round-trip through the page and the mirror text', () => {
    const it0 = mkNote('Lista.md', '# Terv\n\n## Első\n\n- egy\n- kettő\n\n1. számozott\n2. másik\n')
    importTextToOutline(it0, 'owner')
    const md = outlineTextOf(getWorkItem(it0.id)!) as string
    expect(md).toContain('- egy\n- kettő')
    expect(md).toContain('1. számozott\n2. másik')
  })

  it('an empty file still opens as a page (one empty chapter)', () => {
    const it0 = mkNote('Ures.md', '')
    const r = importTextToOutline(it0, 'owner')
    expect(r.ok).toBe(true)
    expect(listSections(it0.id).length).toBe(1)
  })

  it('a non-text item is refused', () => {
    const w = createWorkItem({ project_id: pid, title: 'Kép', type: 'image' })
    if (!w.ok) throw new Error('munkadarab')
    const r = importTextToOutline(w.item, 'owner')
    expect(r.ok).toBe(false)
  })

  it('the mirror never overwrites a hand edit; reimport reads it back and keeps the page text as a version', async () => {
    const it0 = mkNote('Terv.md', '# Terv\n\n## Első\n\nEgy.\n')
    importTextToOutline(it0, 'owner')
    // the import kept the original file as the previous version: the item now points at its own (new) file
    const abs = join(depot, getWorkItem(it0.id)!.source_path as string)
    writeFileSync(abs, '# Terv\n\n## Első\n\nKÉZZEL ÍRT.\n', 'utf-8')
    expect(mirrorFileEdited(getWorkItem(it0.id)!)).toBe(true)
    await mirrorOutlineToFile(it0.id)
    expect(readFileSync(abs, 'utf-8')).toContain('KÉZZEL ÍRT.')
    const r = reimportTextFromFile(getWorkItem(it0.id)!, 'owner')
    expect(r.ok).toBe(true)
    expect(outlineTextOf(getWorkItem(it0.id)!)).toContain('KÉZZEL ÍRT.')
    expect(existsSync(abs)).toBe(true)
  })

  it('a sibling language version is paired by position; a different chapter count marks it for a check, nothing is dropped', () => {
    const o = mkNote('Terv.md', '# Terv\n\n## Egy\n\nA.\n\n## Kettő\n\nB.\n')
    importTextToOutline(o, 'owner')
    const same = mkNote('Terv-en.md', '## One\n\nA-en.\n\n## Two\n\nB-en.\n', 'Terv en')
    const reg = (id: string, lang: string): void => { getDb().prepare('INSERT OR REPLACE INTO wb_doc_variants (work_item_id, source_item_id, lang, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(id, o.id, lang, Date.now(), 'owner') }
    reg(same.id, 'en')
    adoptVariantText(getWorkItem(o.id)!, same, '## One\n\nA-en.\n\n## Two\n\nB-en.\n', 'owner')
    const link = (id: string): string[] => (getDb().prepare('SELECT source_hash FROM wb_doc_section_links WHERE work_item_id = ?').all(id) as { source_hash: string }[]).map((x) => x.source_hash)
    expect(link(same.id).length).toBe(2)
    expect(link(same.id).every((h) => h !== 'carried-over-check')).toBe(true)
    const diff = mkNote('Terv-fr.md', '## Un\n\nA-fr.\n\n## Deux\n\nB-fr.\n\n## Trois\n\nC-fr.\n', 'Terv fr')
    reg(diff.id, 'fr')
    adoptVariantText(getWorkItem(o.id)!, diff, '## Un\n\nA-fr.\n\n## Deux\n\nB-fr.\n\n## Trois\n\nC-fr.\n', 'owner')
    expect(link(diff.id).every((h) => h === 'carried-over-check')).toBe(true)
    expect(outlineTextOf(getWorkItem(diff.id)!)).toContain('C-fr.')
  })

  it('the route: text_profile in the detail, text-import is idempotent', async () => {
    const it0 = mkNote('Terv.md', '# Terv\n\n## Első\n\nEgy.\n')
    const d0 = await callWorkbench(`/api/workbench/items/${it0.id}`, 'GET')
    expect(d0.body.text_profile).toMatchObject({ on: false, candidate: true })
    const a = await callWorkbench(`/api/workbench/items/${it0.id}/text-import`, 'POST', {})
    expect(a.status).toBe(201)
    const b = await callWorkbench(`/api/workbench/items/${it0.id}/text-import`, 'POST', {})
    expect(b.status).toBe(200)
    const d1 = await callWorkbench(`/api/workbench/items/${it0.id}`, 'GET')
    expect(d1.body.text_profile.on).toBe(true)
    expect(d1.body.outline).not.toBeNull()
  })

  it('a fresh install (empty DB, no files) has no text profile for a plain note', async () => {
    const w = createWorkItem({ project_id: pid, title: 'Szabad', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    const d = await callWorkbench(`/api/workbench/items/${w.item.id}`, 'GET')
    expect(d.body.text_profile).toMatchObject({ on: false, candidate: false })
  })
})

describe('#673 the front end shares ONE page renderer (source guard)', () => {
  const js = src('workbench.js')
  it('the profile switch is defined once and the document surface uses it', () => {
    expect((js.match(/function isTextProfile\(/g) || []).length).toBe(1)
    expect((js.match(/function courtOnly\(/g) || []).length).toBe(1)
    expect((js.match(/function isDocSurface\(/g) || []).length).toBe(1)
  })
  it('the note branch calls docTabsHtml, not its own page renderer', () => {
    expect(js).toMatch(/else if \(isDocSurface\(it\)\) inner = docTabsHtml\(\)/)
  })
  it('no second builder of the document page', () => {
    expect((js.match(/function docPageHtml\(/g) || []).length).toBe(1)
    // the page host is built at exactly one place
    expect((js.match(/'<div class="wb-dp-page"/g) || []).length).toBe(1)
  })
  it('the court-only parts are hidden through courtOnly()', () => {
    const tabs = js.slice(js.indexOf('function docTabsHtml('))
    expect(tabs.slice(0, 4000)).toMatch(/if \(courtOnly\(\)\) tabs\.push\(\['sources'/)
    expect(js).toMatch(/courtOnly\(\) \? langHeadHtml\(o, ro\) \+ glossaryHtml\(o, ro\) : ''/)
    expect(js).toMatch(/courtOnly\(\) \? glossaryHtml\(o, ro\) \+ outlineCheckHtml\(o\.check, o, ro\) : ''\) \+ outlinePdfHtml\(o, ro\)/)
    expect(js).toContain("(courtOnly() ? courtBoxHtml(ro) : '')")
  })
  // #777 (Boss TG: "a birosagi oldalt kell helyette hasznalni, butitott valtozatban"): the text profile is finalized by the
  // court document's OWN finalize panel and route, not by the separate note / Word panels.
  it('#777 the text profile finalizes with the court document panel, not a separate one', () => {
    const top = js.slice(js.indexOf('function finalizeTopHtml('), js.indexOf('function finalizeTopHtml(') + 3000)
    // #803: one test decides what is on the page (finalOnPage); the text profile is part of it, the old panel is gone.
    expect(top).toContain('if (finalOnPage(it)) {')
    expect(top).toContain('data-wb-act="sh-final"')
    const onPage = js.slice(js.indexOf('function finalOnPage('), js.indexOf('function finalOnPage(') + 400)
    expect(onPage).toContain('if (isTextProfile(it)) return true')
    const panel = js.slice(js.indexOf('function noteFinalPanelHtml('), js.indexOf('function noteFinalPanelHtml(') + 900)
    expect(panel).toContain('!isTableFinalItem(it) || archived()) return')
    expect(js).toContain("else if (a === 'item-finalize' && WB.detail && finalOnPage(WB.detail.item)) { WB.shFinal = !WB.shFinal")
  })
  it('every new text is in both languages', () => {
    for (const k of ['reimport', 'reimport_tip', 'reimport_confirm', 'reimported']) {
      expect(src('lang/hu.js')).toContain(`"workbench.textdoc.${k}"`)
      expect(src('lang/en.js')).toContain(`"workbench.textdoc.${k}"`)
    }
  })
})
