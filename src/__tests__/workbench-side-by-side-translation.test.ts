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
import { addSection, addBlock, addClaim, documentOutline, listBlocks, updateBlock, type SourceWorld } from '../workbench-docmodel.js'
import { createVariant, listVariants, variantInfo } from '../workbench-doclang.js'
import {
  previewSectionTranslation, savedTranslationFor, saveShownTranslation, setTranslateCallerForTest, resetTranslateJobsForTest, startVariantTranslation, translateJobState, waitForTranslationForTest, usableRich, type TranslateCaller,
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

  // #558 (Boss TG 8773): "the translation must look like the original" -- the saved translation inherits the look of
  // the source block at the same place.
  it('#558: the saved translation keeps alignment, paragraph format, a one-piece text format, and a mixed one is left plain', () => {
    const fmt = addBlock(src.id, secId, { rich: '<span style="color:#ff0000"><b><u>Fontos mondat.</u></b></span>', align: 'c', pfmt: { h: 1, ls: 1.5 }, author: 'owner' })
    const mixed = addBlock(src.id, secId, { rich: 'Sima <b>kiemelt</b> vege.', align: 'r', author: 'owner' })
    if (!fmt.ok || !mixed.ok) throw new Error('blocks')
    const srcBlocks = listBlocks(src.id)
    expect(srcBlocks).toHaveLength(3)
    const shown = [{ source_section: secId, title: 'Sachverhalt', blocks: [
      { kind: 'paragraph', text: 'Die Klage ist eingereicht.' },
      { kind: 'paragraph', text: 'Wichtiger Satz.' },
      { kind: 'paragraph', text: 'Schlicht betont Ende.' },
    ] }]
    const saved = saveShownTranslation(src, 'de', shown, 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    expect(saved.saved).toBe(1)
    const out = listBlocks(saved.variant.id)
    expect(out.map((b) => b.text)).toEqual(['Die Klage ist eingereicht.', 'Wichtiger Satz.', 'Schlicht betont Ende.'])
    // the plain source block: nothing to inherit
    expect([out[0]!.align ?? null, out[0]!.pfmt ?? null, out[0]!.rich ?? null]).toEqual([null, null, null])
    // one-piece format: the same colour, bold and underline on the whole translated text; centred; heading 1 + line spacing
    expect(out[1]!.align).toBe('c')
    expect(JSON.parse(String(out[1]!.pfmt))).toEqual(JSON.parse(String(srcBlocks[1]!.pfmt)))
    expect(out[1]!.rich).toBe(String(srcBlocks[1]!.rich).replace('Fontos mondat.', 'Wichtiger Satz.'))
    // mixed format: which word is bold cannot be told without the translator -- plain text, but the alignment stays
    expect(out[2]!.align).toBe('r')
    expect(out[2]!.rich ?? null).toBeNull()
    // the same translation again: nothing to write
    const again = saveShownTranslation(src, 'de', shown, 'owner')
    expect(again).toMatchObject({ ok: true, saved: 0, unchanged: 1 })
  })

  it('#558: the preview carries the look too, so the side column can draw what will be saved', async () => {
    const fmt = addBlock(src.id, secId, { rich: '<b>Fontos.</b>', align: 'c', pfmt: { h: 2 }, author: 'owner' })
    if (!fmt.ok) throw new Error('block')
    const r = await previewSectionTranslation(src, secId, 'de', 'hu')
    if (!r.ok) throw new Error(r.message)
    expect(r.preview.blocks).toHaveLength(2)
    expect(r.preview.blocks[0]).not.toHaveProperty('align')
    expect(r.preview.blocks[1]).toMatchObject({ text: 'Die Klage ist eingereicht.', align: 'c', pfmt: { h: 2 }, rich: '<b>Die Klage ist eingereicht.</b>' })
    // the page draws it with the page's own classes, and no longer drops a picture
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const fn = js.slice(js.indexOf('function twBlockHtml(b)'), js.indexOf('function twPanelInnerHtml(o, ro)'))
    expect(fn).toContain("if (b.kind === 'image')")
    expect(fn).toContain('dpImageParts(b.text)')
    expect(fn).toContain('dpAlignAttrs(b.align).cls')
    // #534: the column is ONE continuous page now; a picture is an island inside it, drawn by twBlockHtml
    const page = js.slice(js.indexOf('function twPageHtml(o, ro)'), js.indexOf('function twCollect()'))
    expect(page).toContain('twBlockHtml(b)')
    expect(page).toContain('data-tw="island"')
    expect(js).not.toContain("return b.kind === 'image' ? '' :")
  })

  it('#558: a different number of blocks is not paired (no format on the wrong block)', () => {
    const fmt = addBlock(src.id, secId, { rich: '<b>Fontos.</b>', align: 'c', author: 'owner' })
    if (!fmt.ok) throw new Error('block')
    const saved = saveShownTranslation(src, 'de', [{ source_section: secId, title: 'Sachverhalt', blocks: [{ kind: 'paragraph', text: 'Alles in einem.' }] }], 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    const out = listBlocks(saved.variant.id)
    expect(out).toHaveLength(1)
    expect([out[0]!.align ?? null, out[0]!.rich ?? null]).toEqual([null, null])
  })

  // #616 (Boss TG 3473): the whole original was justified, the translation (more paragraphs than the original) lost it.
  it('#616: a uniformly justified original stays justified in the saved translation even when the paragraph counts differ', () => {
    const second = addBlock(src.id, secId, { text: 'Masodik bekezdes.', author: 'owner' })
    if (!second.ok) throw new Error('block')
    for (const b of listBlocks(src.id)) updateBlock(src.id, b.id, { align: 'j', author: 'owner' })
    const shown = [{ source_section: secId, title: 'Sachverhalt', blocks: [
      { kind: 'paragraph', text: 'Eins.' }, { kind: 'paragraph', text: 'Zwei.' }, { kind: 'paragraph', text: 'Drei.' },
    ] }]
    const saved = saveShownTranslation(src, 'de', shown, 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    expect(listBlocks(saved.variant.id).map((b) => b.align)).toEqual(['j', 'j', 'j'])
    // saving the same again writes nothing (translationAlreadySaved agrees with what was saved)
    expect(saveShownTranslation(src, 'de', shown, 'owner')).toMatchObject({ ok: true, saved: 0, unchanged: 1 })
  })

  it('#616: with a different paragraph count, mixed alignments in the original are not guessed onto the translation', () => {
    const second = addBlock(src.id, secId, { text: 'Masodik bekezdes.', align: 'c', author: 'owner' })
    if (!second.ok) throw new Error('block')
    const [first] = listBlocks(src.id)
    updateBlock(src.id, first!.id, { align: 'j', author: 'owner' })
    const shown = [{ source_section: secId, title: 'Sachverhalt', blocks: [{ kind: 'paragraph', text: 'Alles in einem.' }] }]
    const saved = saveShownTranslation(src, 'de', shown, 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    expect(listBlocks(saved.variant.id).map((b) => b.align ?? null)).toEqual([null])
  })

  it('#534 fix: the look the owner left on an edited paragraph is saved, not the one guessed from the position', () => {
    // two source blocks, the translation has THREE (Enter split one): no positional pairing is possible, so only the
    // look the page sent can reach the language version
    const shown = [{ source_section: secId, title: 'Sachverhalt', blocks: [
      { kind: 'paragraph', text: 'Die Klage ist eingereicht.' },
      { kind: 'paragraph', text: 'Zentriert und fett.', align: 'c', pfmt: { h: 2 }, rich: '<b>Zentriert und fett.</b>' },
      { kind: 'paragraph', text: 'Rechts.', align: 'r' },
    ] }]
    const saved = saveShownTranslation(src, 'de', shown, 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    const out = listBlocks(saved.variant.id)
    expect(out).toHaveLength(3)
    expect(out[1]).toMatchObject({ align: 'c', rich: '<b>Zentriert und fett.</b>' })
    expect(JSON.parse(String(out[1]!.pfmt))).toEqual({ h: 2 })
    expect(out[2]!.align).toBe('r')
    // the same page saved again says it is already there
    expect(saveShownTranslation(src, 'de', shown, 'owner')).toMatchObject({ ok: true, saved: 0, unchanged: 1 })
    // a rich text that does not match its own plain text is not trusted
    const bad = saveShownTranslation(src, 'de', [{ source_section: secId, title: 'Sachverhalt', blocks: [{ kind: 'paragraph', text: 'Eins.', rich: '<b>Ganz anders</b>' }] }], 'owner')
    if (!bad.ok) throw new Error(bad.detail)
    expect(listBlocks(bad.variant.id)[0]!.rich ?? null).toBeNull()
  })

  // #558 B/D/E: a word bold INSIDE a paragraph survives the translation when the model keeps the tags; a model that
  // dropped or invented a format is not believed (plain text, counted); the block count is in the instruction.
  const mixedSrc = (): void => {
    const m = addBlock(src.id, secId, { rich: 'Sima <b>kiemelt</b> vege.', align: 'r', author: 'owner' })
    if (!m.ok) throw new Error('block')
  }
  const answering = (rich: string | undefined): TranslateCaller => async (req) => {
    calls++
    const u = JSON.parse(req.user)
    const blocks = u.blocks.map((b: { id: string; rich?: string }) => (b.rich
      ? { id: b.id, text: 'Schlicht betont Ende.', ...(rich !== undefined ? { rich } : {}), claims: [] }
      : { id: b.id, text: 'Die Klage ist eingereicht.', claims: [] }))
    return { ok: true, text: JSON.stringify({ title: 'Sachverhalt', blocks }), account: 'test', model: 'test-model' }
  }

  it('#558 B: the formatted translation the model keeps is shown and saved; the word that was bold stays bold', async () => {
    mixedSrc()
    setTranslateCallerForTest(answering('Schlicht <b>betont</b> Ende.'))
    const r = await previewSectionTranslation(src, secId, 'de', 'hu')
    if (!r.ok) throw new Error(r.message)
    expect(r.preview.format_fallback).toBe(0)
    expect(r.preview.blocks[1]).toMatchObject({ text: 'Schlicht betont Ende.', rich: 'Schlicht <b>betont</b> Ende.', align: 'r' })
    const saved = saveShownTranslation(src, 'de', [{ source_section: secId, title: r.preview.title, blocks: r.preview.blocks }], 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    const out = listBlocks(saved.variant.id)
    expect(out[1]!.rich).toBe('Schlicht <b>betont</b> Ende.')
    expect(out[1]!.align).toBe('r')
  })

  it('#558 B: a model answer that lost the tag, invented one or changed the words stays plain text, and is counted', async () => {
    mixedSrc()
    for (const bad of ['Schlicht betont Ende.', 'Schlicht <i>betont</i> Ende.', 'Ganz <b>anders</b> hier.', undefined]) {
      setTranslateCallerForTest(answering(bad))
      const r = await previewSectionTranslation(src, secId, 'de', 'hu')
      if (!r.ok) throw new Error(r.message)
      expect(r.preview.format_fallback).toBe(1)
      expect(r.preview.blocks[1]!.rich ?? null).toBeNull()
      expect(r.preview.blocks[1]!.align).toBe('r')
    }
    expect(usableRich('Sima <b>kiemelt</b> vege.', 'Schlicht <b>betont</b> Ende.', 'Schlicht betont Ende.')).toBe('Schlicht <b>betont</b> Ende.')
    expect(usableRich('Sima <b>kiemelt</b> vege.', '<script>x</script>Schlicht', 'Schlicht')).toBe('')
  })

  it('#558 fix: a formatted paragraph that comes back plain is marked and counted -- in the preview, in the save and in the whole-document job', async () => {
    mixedSrc()
    // the model keeps the tags: nothing is lost
    setTranslateCallerForTest(answering('Schlicht <b>betont</b> Ende.'))
    const kept = await previewSectionTranslation(src, secId, 'de', 'hu')
    if (!kept.ok) throw new Error(kept.message)
    expect(kept.preview.format_lost).toBe(0)
    expect(kept.preview.blocks.some((b) => b.format_lost)).toBe(false)
    // the model drops the tags: the paragraph is marked, the plain one beside it is not
    setTranslateCallerForTest(answering('Schlicht betont Ende.'))
    const r = await previewSectionTranslation(src, secId, 'de', 'hu')
    if (!r.ok) throw new Error(r.message)
    expect(r.preview.format_lost).toBe(1)
    expect(r.preview.blocks.map((b) => b.format_lost ?? false)).toEqual([false, true])
    const saved = saveShownTranslation(src, 'de', [{ source_section: secId, title: r.preview.title, blocks: r.preview.blocks }], 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    expect(saved.format_lost).toBe(1)
    // the owner formatted it by hand on the page (the block comes back with a rich value): not lost any more
    const again = saveShownTranslation(src, 'de', [{ source_section: secId, title: 'Sachverhalt 2', blocks: r.preview.blocks.map((b, i) => (i === 1 ? { ...b, rich: 'Schlicht <b>betont</b> Ende.' } : b)) }], 'owner')
    if (!again.ok) throw new Error(again.detail)
    expect(again.format_lost).toBe(0)
    // the whole-document job reports it too
    const v = createVariant(src, 'en', 'owner')
    if (!v.ok) throw new Error(v.detail)
    setTranslateCallerForTest(answering('Schlicht betont Ende.'))
    startVariantTranslation(v.item.id, { lang: 'hu', by: 'owner' })
    await waitForTranslationForTest(v.item.id)
    expect(translateJobState(v.item.id)).toMatchObject({ done: 1, format_lost: 1 })
  })

  it('#558 fix: the translation page says which paragraphs lost their format and the hand-made format of an unchanged paragraph is kept', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain("t('workbench.tw.format_lost'")
    expect(js).toContain("t('workbench.doclang.job_format_lost'")
    expect(js).toContain('data-tw-fmtlost')
    expect(js).toContain('delete kept.format_lost')
    for (const lang of ['hu', 'en']) {
      const l = readFileSync(join(__dirname, '..', '..', 'web', 'lang', `${lang}.js`), 'utf8')
      for (const k of ['workbench.tw.format_lost', 'workbench.tw.format_lost_mark', 'workbench.doclang.job_format_lost']) expect(l).toContain(`"${k}"`)
    }
  })

  it('#558 B/E: the instruction names the formatted text and the block count, and a second attempt is told what was wrong', async () => {
    mixedSrc()
    const seen: { system: string; user: string }[] = []
    let n = 0
    setTranslateCallerForTest(async (req) => {
      seen.push({ system: req.system, user: req.user })
      const u = JSON.parse(req.user)
      // first answer: one block short (a merged block); second: right
      const blocks = u.blocks.map((b: { id: string }) => ({ id: b.id, text: 'Text.', claims: [] }))
      return { ok: true, text: JSON.stringify({ title: 'T', blocks: n++ === 0 ? blocks.slice(0, 1) : blocks }), account: 'test', model: 'm' }
    })
    const r = await previewSectionTranslation(src, secId, 'de', 'hu')
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(2)
    expect(JSON.parse(seen[0]!.user).blocks[1].rich).toBe('Sima <b>kiemelt</b> vege.')
    expect(seen[0]!.system).toContain('exactly 2 block(s)')
    expect(seen[0]!.system).not.toContain('previous answer was rejected')
    expect(seen[1]!.system).toContain('previous answer was rejected')
    expect(seen[1]!.system).toContain('2 block(s), the translation 1')
  })

  it('#558 D: the whole-document translation saves the formatted translation, the look of the paragraph and the picture unchanged', async () => {
    mixedSrc()
    const img = addBlock(src.id, secId, { kind: 'image', text: 'Projektek/teszt/logo.png#w=40&a=l', author: 'owner' })
    if (!img.ok) throw new Error('image')
    setTranslateCallerForTest(async (req) => {
      const u = JSON.parse(req.user)
      const blocks = u.blocks.map((b: { id: string; kind: string; text: string; rich?: string }) => (
        b.kind === 'image' ? { id: b.id, text: b.text, claims: [] }
          : b.rich ? { id: b.id, text: 'Schlicht betont Ende.', rich: 'Schlicht <b>betont</b> Ende.', claims: [] }
            : { id: b.id, text: 'Die Klage ist eingereicht.', claims: [] }))
      return { ok: true, text: JSON.stringify({ title: 'Sachverhalt', blocks }), account: 'test', model: 'm' }
    })
    const v = createVariant(src, 'de', 'owner')
    if (!v.ok) throw new Error(v.detail)
    expect(startVariantTranslation(v.item.id, { lang: 'hu', by: 'owner' })).toMatchObject({ ok: true, started: true })
    await waitForTranslationForTest(v.item.id)
    const out = listBlocks(v.item.id)
    expect(out.map((b) => b.kind)).toEqual(['paragraph', 'paragraph', 'image'])
    expect(out[1]).toMatchObject({ text: 'Schlicht betont Ende.', rich: 'Schlicht <b>betont</b> Ende.', align: 'r' })
    expect(out[2]!.text).toBe('Projektek/teszt/logo.png#w=40&a=l')
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
  it('a finished translation run saves the language version by itself (the preview alone never made the work item appear in the list)', () => {
    // the end of the run (all sections done, still on the same item) calls the save; a provider stop does not reach it
    expect(js).toMatch(/if \(i >= todo\.length && WB\.selectedId === id\) twSave\(true\)/)
    expect(js).toContain("a === 'tw-save') twSave()")
    expect(js).toContain("auto === true ? 'workbench.tw.autosaved' : 'workbench.tw.saved'")
    for (const f of ['hu', 'en']) expect(readFileSync(join(__dirname, '..', '..', 'web', 'lang', f + '.js'), 'utf8')).toContain('"workbench.tw.autosaved"')
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

  it('#534: the translation column is one continuous editable page -- no per-chapter boxes, no add buttons', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const page = js.slice(js.indexOf('function twPageHtml(o, ro)'), js.indexOf('function twCollect()'))
    expect(page).toContain('id="wbTwPage"')
    expect(page).toContain('contenteditable')
    // the heading is the chapter border; there is no per-chapter card and no insert / add control on the page
    expect(page).toContain('data-tw="title"')
    expect(page).not.toContain('wb-tw-sec')
    expect(page).not.toContain('wb-dp-plus')
    expect(page).not.toContain('outline-add')
    // what was typed is read back before every redraw and before the save, and only from a page drawn for this language
    expect(js).toMatch(/function twRefresh\(\)[\s\S]{0,400}twCollect\(\)/)
    expect(js).toMatch(/function twSave\(auto\)[\s\S]{0,500}twCollect\(\)/)
    expect(js).toContain('data-tw-shown')
    // Enter makes a paragraph by hand (Chromium would clone the element and its attributes)
    expect(js).toContain('function twSplitAtCaret(plain)')
    // Enter on the empty last item of a list leaves the list for a plain paragraph
    expect(js).toContain('function twExitListAtCaret(host)')
    expect(js).toContain("e.inputType === 'insertParagraph' && twExitListAtCaret(host)")
  })

  it('#534: a language version page has no gutter "+" and no "new chapter" button', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const g = js.slice(js.indexOf('function dpGutterHtml'), js.indexOf('function dpGutterHtml') + 400)
    expect(g).not.toContain('wb-dp-plus')
    expect(g).not.toContain('dp-handle')
  })

  it('#534: no "+" gutter button on any page; no move / delete handle (the check view is gone); list and signature are on the toolbar', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const g = js.slice(js.indexOf('function dpGutterHtml'), js.indexOf('function dpGutterHtml') + 900)
    expect(g).not.toContain('wb-dp-plus')
    expect(g).not.toContain("dpMenuHtml('add'")
    expect(g).not.toContain('dp-handle')
    expect(js).not.toContain('dpCheckView')
    expect(js).toContain("btn('sign', t('workbench.dp.ins_sign')")
    expect(js).toContain("if (f === 'sign')")
    expect(js).toContain("['list', '&#8226;&#8801;', 'fmt_list']")
  })

  it('#534 (c): the chapter border is a Heading 1 paragraph -- no "new chapter" button or menu item, split and join on save', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const menu = js.slice(js.indexOf("if (kind === 'add') {"), js.indexOf("if (kind === 'add') {") + 600)
    expect(menu).not.toContain('dp-ins-section')
    expect(js).not.toContain('data-wb-act="dp-add-section"')
    // a paragraph made Heading 1 is marked, and the page model turns it into the title of a new chapter
    expect(js).toContain("el.setAttribute('data-wb-split', '1')")
    expect(js).toContain("n.getAttribute('data-wb-split') === '1'")
    // a chapter title made Normal is joined to the chapter above
    expect(js).toContain("el.setAttribute('data-wb-demote', '1')")
    expect(js).toContain("n.getAttribute('data-wb-demote') === '1'")
    // the page is drawn again from the server's outline after a structural save
    expect(js).toContain('if (model.structural)')
  })

  it('#534 (d): the chapters stand in an outline beside the page, and the chapter status lives there, not on the title line', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain('function dpOutlineHtml(secs, ro)')
    expect(js).toContain('data-wb-act="dp-outline-go"')
    const from = js.indexOf('function dpSectionHtml')
    const sec = js.slice(from, js.indexOf("'</section>'", from))
    expect(sec).not.toContain('outline-sec-status')
  })

  it('the Headings button never looks dead: with no titled chapter the panel says so and points to the Style list', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const from = js.indexOf('function dpOutlineHtml(secs, ro)')
    const fn = js.slice(from, js.indexOf('function docPageHtml', from))
    expect(fn).not.toContain("if (!secs.length) return ''")
    expect(fn).toContain('workbench.dp.outline_empty')
    for (const lang of ['hu', 'en']) {
      const dict = readFileSync(join(__dirname, '..', '..', 'web', 'lang', lang + '.js'), 'utf8')
      expect(dict).toContain('"workbench.dp.outline_empty"')
    }
  })

  it('#589: the Headings panel lists every Heading 1 / 2 / 3 paragraph, not only the chapter titles (Boss TG 3229)', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const from = js.indexOf('function dpOutlineItems(secs)')
    const fn = js.slice(from, js.indexOf('function dpOutlineHtml', from))
    // eslint-disable-next-line no-new-func
    const items = new Function(fn + '; return dpOutlineItems')() as (s: unknown[]) => { level: number; text: string }[]
    const secs = [
      { id: 's1', title: 'Elso', untitled: false, blocks: [
        { id: 'b1', kind: 'paragraph', text: 'sima szoveg', pfmt: {} },
        { id: 'b2', kind: 'paragraph', text: 'Masodik cim\nmasodik sor', pfmt: { h: 2 } },
        { id: 'b3', kind: 'paragraph', text: 'Harmadik cim', pfmt: { h: 3 } },
        { id: 'b4', kind: 'paragraph', text: '   ', pfmt: { h: 2 } },
      ] },
      { id: 's2', title: '', untitled: true, blocks: [{ id: 'b5', kind: 'paragraph', text: 'Cim cim nelkuli fejezetben', pfmt: { h: 2 } }] },
    ]
    expect(items(secs).map((i) => [i.level, i.text])).toEqual([[1, 'Elso'], [2, 'Masodik cim'], [3, 'Harmadik cim'], [2, 'Cim cim nelkuli fejezetben']])
    expect(js).toContain("document.getElementById(bid ? 'wbDpB_' + bid : 'wbDpS_' + sid)")
  })

  it('#591: a Heading 2 / 3 saved without a redraw shows up in the open Headings panel at once (it was drawn once and never again)', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const from = js.indexOf('function dpOutlineRefresh()')
    const fn = js.slice(from, js.indexOf('function docPageHtml', from))
    const oldNav = { tag: 'old' }
    const replaced: unknown[][] = []
    const wrap = {
      querySelector: (sel: string) => (sel === '.wb-dp-outline' ? oldNav : null),
      replaceChild: (n: unknown, o: unknown) => { replaced.push([n, o]) },
    }
    const run = (nav: boolean, outline: unknown) => {
      replaced.length = 0
      const WB = { detail: { outline } }
      const doc = { createElement: () => { const b: { innerHTML: string; firstChild: unknown } = { innerHTML: '', firstChild: null }; return Object.defineProperty(b, 'innerHTML', { set(v: string) { b.firstChild = v ? { html: v } : null }, get: () => '' }) } }
      const page = { parentNode: nav ? wrap : { querySelector: () => null } }
      // eslint-disable-next-line no-new-func
      new Function('WB', 'document', 'dpRoot', 'dpOutlineHtml', fn + '; dpOutlineRefresh()')(
        WB, doc, () => page, (secs: { title: string }[]) => (secs.length ? '<nav>' + secs.map((x) => x.title).join(',') + '</nav>' : ''),
      )
    }
    run(true, { sections: [{ title: 'Elso' }] })
    expect(replaced).toEqual([[{ html: '<nav>Elso</nav>' }, oldNav]])
    run(false, { sections: [{ title: 'Elso' }] }) // panel closed (no nav on the page): nothing to refresh
    expect(replaced).toEqual([])
    run(true, null) // no outline loaded: nothing to refresh
    expect(replaced).toEqual([])
    // the non-structural save path calls it; the structural one draws the whole page again and needs no call
    const save = js.slice(js.indexOf('function dpPageSave()'), js.indexOf('function dpSave()'))
    const iStruct = save.indexOf('if (model.structural)')
    const iRefresh = save.indexOf('dpOutlineRefresh()')
    expect(iRefresh).toBeGreaterThan(save.indexOf('render()', iStruct))
    expect(iRefresh).toBeLessThan(save.indexOf('docStepsRefresh()'))
  })

  it('#534 fix: nothing typed on the translation page is thrown away by a redraw, a bare text node or an emptied page', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    // a full redraw of the Draft tab reads the page first
    expect(js).toMatch(/var ro = docLocked\(\)\n    twCollect\(\) \/\/ #534: any redraw/)
    const col = js.slice(js.indexOf('function twCollect()'), js.indexOf('function twPanelInnerHtml(o, ro)'))
    // text standing directly in the host is a paragraph
    expect(col).toContain('host.childNodes')
    expect(col).toContain('el.nodeType === 3')
    // the look is read off the element
    expect(col).toContain('dpFmtOf(el)')
    expect(col).toContain("getAttribute('data-wb-align')")
    expect(col).toContain('dpPfmtOf(el)')
    // an emptied page keeps the translations and says so; a deleted heading is counted and shown
    expect(col).toContain("t('workbench.tw.emptied_kept')")
    expect(col).toContain('tw.dropped')
    expect(js).toContain("t('workbench.tw.dropped'")
    // Enter in a table / list is a line break inside the block, not a new block
    expect(js).toContain('function twLineBreakAtCaret()')
    expect(js).toContain("/^(table|list)$/.test(host.getAttribute('data-tw-kind')")
  })

  it('#619: a retranslation that arrives is not overwritten by the older text still on the page', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    // the arriving preview is marked fresh, twCollect skips a fresh section, and the draw clears the mark
    expect(js).toMatch(/pv\.sig = sig\n\s+pv\.fresh = true/)
    expect(js).toMatch(/if \(!pv \|\| pv\.fresh \|\| shownIds\.indexOf\(sec\.id\) < 0\) return/)
    expect(js).toContain('pv.fresh = false')
  })
  it('#619 (run, not text): twCollect leaves an arrived retranslation alone until the page shows it, then reads the page again', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const from = js.indexOf('function twCollect()')
    const fn = js.slice(from, js.indexOf('function twPanelInnerHtml', from))
    const el = (attrs: Record<string, string>, text: string) => ({
      nodeType: 1, innerText: text, textContent: text, classList: { contains: () => false },
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    })
    // the page was drawn from the OLD preview: one chapter, one old paragraph
    const page = {
      childNodes: [el({ 'data-tw': 'title', 'data-tw-sec': 's1' }, 'Alter Titel'), el({ 'data-tw': 'block', 'data-tw-sec': 's1', 'data-tw-kind': 'paragraph' }, 'alter Text')],
      getAttribute: (k: string) => (k === 'data-tw-shown' ? 'w1:de|s1' : null),
    }
    const collect = (src: string, tw: { lang: string; prev: Record<string, Record<string, unknown>>; note: string }) => {
      // eslint-disable-next-line no-new-func
      new Function('document', 'WB', 'twState', 'twKey', 't', 'dpFmtOf', 'dpPfmtOf', 'DP_ALIGNS', 'dpTableParts', 'dpTableText', 'twTableLines', src + '; twCollect()')(
        { getElementById: () => page }, { detail: { outline: { sections: [{ id: 's1' }] } }, selectedId: 'w1' }, () => tw,
        (id: string) => 'w1:de:' + id, (k: string) => k, () => ({}), () => ({}), [], (x: string) => ({ text: x }), (x: string) => x, () => null,
      )
    }
    const arrived = () => ({ lang: 'de', note: '', prev: { 'w1:de:s1': {
      title: 'Neuer Titel', sig: 'x', fresh: true,
      blocks: [{ kind: 'paragraph', text: 'neuer Text' }, { kind: 'table', text: 'Absender | Empfaenger' }, { kind: 'image', text: 'bild.png' }],
    } } })
    // the fix: the arrived translation (table, picture and all) survives a read-back of the older page
    const tw = arrived()
    collect(fn, tw)
    expect(tw.prev['w1:de:s1'].title).toBe('Neuer Titel')
    expect((tw.prev['w1:de:s1'].blocks as { kind: string }[]).map((b) => b.kind)).toEqual(['paragraph', 'table', 'image'])
    // once the page shows it (the draw clears the mark), what stands on the page is read back as before
    tw.prev['w1:de:s1'].fresh = false
    collect(fn, tw)
    expect(tw.prev['w1:de:s1'].title).toBe('Alter Titel')
    // without the guard the old page text wins -- the bug this test must catch
    const bad = arrived()
    collect(fn.replace('pv.fresh || ', ''), bad)
    expect((bad.prev['w1:de:s1'].blocks as unknown[]).length).toBe(1)
  })
  it('#620: a table block of the translation page is drawn as a real table and read back as " | " lines', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain('function twTableHtml(text)')
    expect(js).toContain('function twTableLines(el)')
    expect(js).toContain("b.kind === 'table' ? twTableHtml(b.text)")
    expect(js).toContain("twTableLines(el) : null")
    expect(readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')).toContain('.wb-tw-tbl th, .wb-tw-tbl td')
  })
  // #621: the #620 draw / read-back pair is RUN here (the real functions cut out of workbench.js, a small fake table for the
  // read-back) -- and was also run in a real Chromium: the "Absender | Empfänger" table is two rows of cells, not two paragraphs.
  describe('#621: the translation page table, run for real', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const cut = (from: string, to: string): string => js.slice(js.indexOf(from), js.indexOf(to, js.indexOf(from)))
    const fns = new Function('esc', [cut('function dpFree(', 'function dpFreeSuffix'), cut('function dpTableParts', 'function dpTableText'), cut('function twTableHtml', 'function twTableRowAtCaret')].join('\n') + '; return { twTableHtml, twTableLines }')(
      (x: unknown) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;')) as { twTableHtml: (t: string) => string; twTableLines: (el: unknown) => string | null }
    /** A drawn table as the page holds it: rows of cells, each cell a list of text / <br> nodes. */
    const fakeTable = (rows: (string | null)[][][]): unknown => {
      const node = (n: string | null) => (n === null ? { nodeName: 'BR', textContent: '' } : { nodeName: '#text', textContent: n })
      const trs = rows.map((cells) => ({ children: cells.map((c) => ({ childNodes: c.map(node), textContent: c.map((n) => n ?? '').join('') })) }))
      return { querySelectorAll: (sel: string) => (sel === 'tr' ? trs : []) }
    }

    it('a table block is drawn as a real table: one row per line, one cell per "|", the first row as header, the size line hidden', () => {
      const html = fns.twTableHtml('Absender: | Anna Kovács\nEmpfänger: | Amtsgericht Köln\n#w=100&a=c')
      expect(html).toBe('<table class="wb-tw-tbl"><tr><th>Absender:</th><th>Anna Kovács</th></tr><tr><td>Empfänger:</td><td>Amtsgericht Köln</td></tr></table>')
      expect(html).not.toContain('#w=')
    })

    it('what the page holds reads back as the same lines; an edited cell, a typed "|" and a line break in a cell are handled', () => {
      expect(fns.twTableLines(fakeTable([[['Absender:'], ['Anna Kovács']], [['Empfänger:'], ['Amtsgericht Köln']]]))).toBe('Absender: | Anna Kovács\nEmpfänger: | Amtsgericht Köln')
      // a "|" typed into a cell must not add a column on the next read
      expect(fns.twTableLines(fakeTable([[['a|b'], ['c']]]))).toBe('a/b | c')
      // Shift+Enter inside a cell reads as a space, not as glued words; the caret's trailing break adds nothing
      expect(fns.twTableLines(fakeTable([[['Amtsgericht', null, 'Köln', null], ['x']]]))).toBe('Amtsgericht Köln | x')
      // a new empty row (Enter) keeps its empty cells, so the row stays in the saved lines
      expect(fns.twTableLines(fakeTable([[['a'], ['b']], [[null], [null]]]))).toBe('a | b\n | ')
      // the table gone from the block: null, so the caller falls back to the block's plain text
      expect(fns.twTableLines({ querySelectorAll: () => [] })).toBeNull()
    })

    it('Enter in a table cell adds a row under it (not a line break in the cell); a break at the end of a cell stays in that cell', () => {
      expect(js).toContain('function twTableRowAtCaret()')
      expect(js).toMatch(/e\.inputType === 'insertParagraph' && host && host\.getAttribute\('data-tw-kind'\) === 'table' && twTableRowAtCaret\(\)\) return/)
      // the trailing break goes into the cell the break stands in, and an empty text node left by the split does not count as "something follows"
      expect(js).toContain("if (!after) br.parentNode.appendChild(document.createElement('br'))")
      expect(js).toContain('after.nodeType === 3 && !after.nodeValue')
    })
  })
})

// Boss, 2026-10-15 (screenshot after F5): the right column stood empty ("Még nincs lefordítva") although the German
// version was saved -- the preview lives only in the browser tab. The saved translation is read back from the server.
describe("the saved translation comes back after a reload", () => {
  let src: WorkItemRow
  let secId = ""
  beforeEach(() => {
    initDatabase(":memory:")
    const p = createProject({ name: "Iroda" })
    if (!p.ok) throw new Error("project")
    const w = createWorkItem({ project_id: p.project.id, title: "Új bírósági beadvány", type: "document" })
    if (!w.ok) throw new Error("item")
    src = w.item
    const s = addSection(src.id, "Tényállás")
    if (!s.ok) throw new Error("section")
    secId = s.section.id
    const b = addBlock(src.id, secId, { text: "A keresetet beadtuk.", author: "agent" })
    if (!b.ok) throw new Error("block")
  })

  it('no language version yet: found false (the normal first state), not an error', () => {
    expect(savedTranslationFor(src, 'de')).toEqual({ ok: true, found: false })
  })

  it('a bad language code and a language version itself are refused with a code, not answered with "nothing"', () => {
    expect(savedTranslationFor(src, 'deutsch')).toMatchObject({ ok: false, code: 'bad_lang' })
    const saved = saveShownTranslation(src, 'de', [{ source_section: secId, title: 'Sachverhalt', blocks: [{ kind: 'paragraph', text: 'Die Klage ist eingereicht.' }] }], 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    expect(savedTranslationFor(saved.variant, 'de')).toMatchObject({ ok: false, code: 'is_variant' })
  })

  it('after a save the same title, blocks and look come back, marked current; another language is still "not found"', () => {
    const fmt = addBlock(src.id, secId, { rich: '<b>Fontos mondat.</b>', align: 'c', pfmt: { h: 1 }, author: 'owner' })
    if (!fmt.ok) throw new Error('block')
    const shown = [{ source_section: secId, title: 'Sachverhalt', blocks: [
      { kind: 'paragraph', text: 'Die Klage ist eingereicht.' },
      { kind: 'paragraph', text: 'Wichtiger Satz.' },
    ] }]
    const saved = saveShownTranslation(src, 'de', shown, 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    const r = savedTranslationFor(src, 'de')
    if (!r.ok || !r.found) throw new Error('expected a saved translation')
    expect(r.variant.id).toBe(saved.variant.id)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0]).toMatchObject({ source_section: secId, state: 'current', title: 'Sachverhalt' })
    expect(r.sections[0]!.blocks.map((b) => b.text)).toEqual(['Die Klage ist eingereicht.', 'Wichtiger Satz.'])
    expect(r.sections[0]!.blocks[1]).toMatchObject({ align: 'c', rich: '<b>Wichtiger Satz.</b>', pfmt: { h: 1 } })
    expect(savedTranslationFor(src, 'en')).toEqual({ ok: true, found: false })
    // what comes back is exactly what a save of it again treats as "already there": nothing is rewritten
    const again = saveShownTranslation(src, 'de', r.sections.map((s) => ({ source_section: s.source_section, title: s.title, blocks: s.blocks })), 'owner')
    if (!again.ok) throw new Error(again.detail)
    expect([again.saved, again.unchanged]).toEqual([0, 1])
  })

  it('a section whose original changed after the translation comes back marked stale, and a section never translated is not listed', () => {
    const s2 = addSection(src.id, 'Kérelem')
    if (!s2.ok) throw new Error('section')
    addBlock(src.id, s2.section.id, { text: 'Kérjük a keresetet elfogadni.', author: 'agent' })
    const saved = saveShownTranslation(src, 'de', [{ source_section: secId, title: 'Sachverhalt', blocks: [{ kind: 'paragraph', text: 'Die Klage ist eingereicht.' }] }], 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    addBlock(src.id, secId, { text: 'Új mondat az eredetiben.', author: 'owner' })
    const r = savedTranslationFor(src, 'de')
    if (!r.ok || !r.found) throw new Error('expected a saved translation')
    expect(r.sections.map((s) => [s.source_section, s.state])).toEqual([[secId, 'stale']])
  })

  it('a claim carried into the language version is paired back to its original, so saving the section again keeps it', () => {
    const blockRow = listBlocks(src.id)[0]!
    const world = { resolveFile: () => null, ownerMessages: () => [] } as unknown as SourceWorld
    const c = addClaim(src.id, blockRow.id, 'A keresetet', [{ kind: 'owner', said: 'A keresetet beadtuk.' }], world, 'owner')
    if (!c.ok) throw new Error(c.detail)
    const shown = [{ source_section: secId, title: 'Sachverhalt', blocks: [{ kind: 'paragraph', text: 'Die Klage ist eingereicht.', claims: [{ source_claim: c.claim.id, text: 'Die Klage' }] }] }]
    const saved = saveShownTranslation(src, 'de', shown, 'owner')
    if (!saved.ok) throw new Error(saved.detail)
    expect(saved.claims_not_carried).toBe(0)
    const r = savedTranslationFor(src, 'de')
    if (!r.ok || !r.found) throw new Error('expected a saved translation')
    expect(r.sections[0]!.blocks[0]!.claims).toEqual([{ source_claim: c.claim.id, text: 'Die Klage' }])
  })

  it('the page asks the server once per document and language, never takes a failed request for "nothing saved", and a newer preview wins', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const fn = js.slice(js.indexOf('function twEnsureLoaded()'), js.indexOf('/** What the left column holds of a section right now'))
    expect(fn).toContain("'/outline/translation?to='")
    // the server route the page asks: a read (also in an archived project), the language in `to`
    const route = readFileSync(join(__dirname, "..", "web", "routes", "workbench.ts"), "utf8")
    expect(route).toContain("segs[2] === 'translation' && method === 'GET'")
    expect(route).toContain("savedTranslationFor(item, String(url.searchParams.get('to') ?? ''))")
    expect(fn).toContain('if (tw.loaded[lk]) return')
    expect(fn).toContain("tw.loaded[lk] = 'failed'")
    expect(fn).toContain("t('workbench.tw.load_failed'")
    expect(fn).toContain('t(\'workbench.tw.load_failed_unknown\')')
    expect(fn).toContain('|| tw.prev[key]')
    // current -> the page's own signature (shown as translated); stale -> empty signature (the page marks it as out of date)
    expect(fn).toContain("s.state === 'current' ? twSig(sec) : ''")
    // drawn from the open page, and again when the language is changed
    expect(js).toContain('if (showTw) twEnsureLoaded()')
    expect(js).toMatch(/writePref\('wb\.tw\.lang', tw\.lang\)\n\s+twEnsureLoaded\(\)/)
    for (const lang of ['hu', 'en']) {
      const dict = readFileSync(join(__dirname, '..', '..', 'web', 'lang', lang + '.js'), 'utf8')
      for (const k of ['workbench.tw.loaded_saved', 'workbench.tw.load_failed', 'workbench.tw.load_failed_unknown']) expect(dict).toContain('"' + k + '"')
    }
  })

  // Boss 2026-10-31 (kártya b431fa22): the assistant corrected the German language version, but the open right column kept
  // the text it read once; a save from it would have written the old text back. The column now follows the saved translation.
  it('the right column follows the saved translation: re-read on focus and every 20 s, an edited section is never replaced, a save updates the baseline', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const fn = js.slice(js.indexOf('function twResync()'), js.indexOf('/** What the left column holds of a section right now'))
    expect(fn.length).toBeGreaterThan(200)
    // only after the first read, never while a run / save is busy, never while the owner types in the page
    expect(fn).toContain("tw.loaded[lk] !== 'done' && tw.loaded[lk] !== 'none'")
    expect(fn).toContain('tw.busy')
    expect(fn).toContain('host.contains(document.activeElement)')
    // the server text replaces the page's one only where the page still holds what it took over (tw.base)
    expect(fn).toContain('if (twBaseSig(pv) !== base) return')
    expect(fn).toContain('if (base === undefined) return')
    expect(fn).toContain('tw.base[key] = server')
    expect(fn).toContain("'/outline/translation?to='")
    // the first read and a save both set the baseline
    expect(js).toContain('tw.base[key] = twBaseSig(s)')
    expect(js).toContain("list.forEach(function (it) { tw.base[id + ':' + lang + ':' + it.source_section] = twBaseSig(it) })")
    // triggers: tab back in front, window focus, a 20 second timer
    expect(js).toContain("document.visibilityState === 'visible') twResync()")
    expect(js).toContain("window.addEventListener('focus', function () { twResync() })")
    expect(js).toMatch(/setInterval\(function \(\) \{[^}]*twResync\(\)[^}]*\}, 20000\)/)
    for (const lang of ['hu', 'en']) {
      const dict = readFileSync(join(__dirname, '..', '..', 'web', 'lang', lang + '.js'), 'utf8')
      expect(dict).toContain('"workbench.tw.resynced"')
    }
  })
})
