// #527 (Boss TG 8433 / 2792): the draft shows the original and its LIVE translation side by side; the owner can
// save exactly what is shown into the language version. (1) The preview translates one section and saves
// nothing. (2) The save puts the shown sections into the language version (made on the first save).
// (3) The page wires the panel, and every text it shows exists in both languages.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock, documentOutline } from '../workbench-docmodel.js'
import { listVariants, variantInfo } from '../workbench-doclang.js'
import {
  previewSectionTranslation, saveShownTranslation, setTranslateCallerForTest, resetTranslateJobsForTest, type TranslateCaller,
} from '../workbench-doclang-translate.js'

describe('side-by-side translation of a draft', () => {
  let src: WorkItemRow
  let secId = ''
  let calls = 0
  const model: TranslateCaller = async (req) => {
    calls++
    const u = JSON.parse(req.user)
    const blocks = u.blocks.map((b: { id: string }) => ({ id: b.id, text: 'Die Klage ist eingereicht.', claims: [] }))
    return { ok: true, text: JSON.stringify({ title: 'Sachverhalt', blocks }), account: 'test', model: 'test-model' }
  }

  beforeEach(() => {
    initDatabase(':memory:')
    resetTranslateJobsForTest()
    calls = 0
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Új bírósági beadvány', type: 'document' })
    if (!w.ok) throw new Error('item')
    src = w.item
    const s = addSection(src.id, 'Tényállás')
    if (!s.ok) throw new Error('section')
    secId = s.section.id
    const b = addBlock(src.id, secId, { text: 'A keresetet beadtuk.', author: 'agent' })
    if (!b.ok) throw new Error('block')
    setTranslateCallerForTest(model)
  })
  afterEach(() => { setTranslateCallerForTest(null); resetTranslateJobsForTest() })

  it('the preview translates one section and saves nothing: no language version appears', async () => {
    const r = await previewSectionTranslation(src, secId, 'de', 'hu')
    expect(r).toMatchObject({ ok: true, preview: { source_section: secId, title: 'Sachverhalt', blocks: [{ kind: 'paragraph', text: 'Die Klage ist eingereicht.' }] } })
    expect(calls).toBe(1)
    expect(listVariants(src.id)).toEqual([])
  })

  it('refuses a bad language code, an unknown section and a language version as the source', async () => {
    expect(await previewSectionTranslation(src, secId, 'deutsch', 'hu')).toMatchObject({ ok: false, code: 'bad_lang' })
    expect(await previewSectionTranslation(src, 'nincs', 'de', 'hu')).toMatchObject({ ok: false, code: 'not_found' })
    const saved = saveShownTranslation(src, 'de', [{ source_section: secId, title: 'Sachverhalt', blocks: [{ kind: 'paragraph', text: 'Text.' }] }], 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    expect(await previewSectionTranslation(saved.variant, secId, 'en', 'hu')).toMatchObject({ ok: false, code: 'is_variant' })
    expect(calls).toBe(0)
  })

  it('a provider stop is passed on in words, and nothing is saved', async () => {
    setTranslateCallerForTest(async () => ({ ok: false, code: 'no_provider', message: 'Nincs elérhető fiók.' }))
    expect(await previewSectionTranslation(src, secId, 'de', 'hu')).toEqual({ ok: false, code: 'no_provider', message: 'Nincs elérhető fiók.' })
    expect(listVariants(src.id)).toEqual([])
  })

  it('the save puts exactly the shown text into the language version, made on the first save, and the second save reuses it', async () => {
    const pv = await previewSectionTranslation(src, secId, 'de', 'hu')
    if (!pv.ok) throw new Error(pv.message)
    const r = saveShownTranslation(src, 'de', [pv.preview], 'owner')
    expect(r).toMatchObject({ ok: true, existing: false, saved: 1, failed: [] })
    if (!r.ok) return
    const out = documentOutline(r.variant.id)
    expect(out.sections.map((s) => s.title)).toEqual(['Sachverhalt'])
    expect(out.sections[0]!.blocks.map((b) => b.text)).toEqual(['Die Klage ist eingereicht.'])
    expect(variantInfo(r.variant.id)!.sections.map((s) => s.state)).toEqual(['current'])
    const again = saveShownTranslation(src, 'de', [pv.preview], 'owner')
    // #527 (Boss TG 2849): the same text again writes nothing and says so (saved 0, unchanged 1).
    expect(again).toMatchObject({ ok: true, existing: true, saved: 0, unchanged: 1 })
    expect(listVariants(src.id)).toHaveLength(1)
    // A changed text is written again, under the same variant.
    const changed = saveShownTranslation(src, 'de', [{ ...pv.preview, title: 'Sachverhalt 2' }], 'owner')
    expect(changed).toMatchObject({ ok: true, existing: true, saved: 1, unchanged: 0 })
    expect(documentOutline(r.variant.id).sections.map((x) => x.title)).toEqual(['Sachverhalt 2'])
  })

  it('a section that cannot be saved is reported, the others still are', () => {
    const r = saveShownTranslation(src, 'de', [
      { source_section: 'nincs', title: 'X', blocks: [] },
      { source_section: secId, title: 'Sachverhalt', blocks: [{ kind: 'paragraph', text: 'Text.' }] },
    ], 'owner')
    expect(r).toMatchObject({ ok: true, saved: 1, failed: [{ source_section: 'nincs' }] })
    expect(saveShownTranslation(src, 'de', [], 'owner')).toMatchObject({ ok: false, code: 'bad_input' })
  })
})

describe('the draft page wiring', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  const keys = [...js.matchAll(/t\('(workbench\.tw\.[a-z_]+)'/g)].map((m) => m[1]!)
  it('the Draft tab renders the side-by-side wrapper and the three actions are dispatched', () => {
    expect(js).toContain(': twWrapHtml(o, ro) + docExtrasHtml()')
    for (const a of ["a === 'tw-toggle'", "a === 'tw-run'", "a === 'tw-save'"]) expect(js).toContain(a)
    expect(js).toContain('/outline/translate-preview')
    expect(js).toContain('/outline/translation-save')
  })
  it('turning the side-by-side view on closes the tool panel, so the two columns are not squeezed to a few words a line', () => {
    const at = js.indexOf("a === 'tw-toggle'")
    const handler = js.slice(at, js.indexOf('render()', at))
    expect(handler).toContain("if (twS.on && WB.frTab) { WB.frTab = null; writePref('wb.fr.tab', '') }")
  })
  it('every text the panel shows exists in Hungarian and in English', () => {
    expect(new Set(keys).size).toBeGreaterThanOrEqual(8)
    for (const f of ['hu', 'en']) {
      const lang = readFileSync(join(__dirname, '..', '..', 'web', 'lang', f + '.js'), 'utf8')
      for (const k of new Set(keys)) expect(lang, f + ' ' + k).toContain('"' + k + '":')
    }
  })
})
