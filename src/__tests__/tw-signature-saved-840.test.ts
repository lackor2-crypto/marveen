import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock, BLANK_LINE } from '../workbench-docmodel.js'
import { previewSectionTranslation, savedTranslationFor, saveShownTranslation, setTranslateCallerForTest, type TranslateCaller } from '../workbench-doclang-translate.js'

// #840 (Boss TG 4458 / 4471): the saved German version (77M) had no signature picture, while the original (71M) had it. The
// saved version must be exactly what the translation column showed: the picture, the empty lines and the printed name, in
// their places -- whether the picture came over with the translation run or was put into the column by hand afterwards, and
// also when the original changed since (the column then shows an old translation, and saving still writes what is on it).
describe('the saved language version holds the signature picture of the translation column (#840)', () => {
  let src: WorkItemRow
  let secId = ''
  const SIG = 'Család/Korpás László/Identitás/korpas laszlo alairas.png#w=30&a=l'
  const model: TranslateCaller = async (req) => {
    const u = JSON.parse(req.user)
    const blocks = u.blocks.map((b: { id: string; kind: string; text: string }) => ({ id: b.id, text: b.kind === 'paragraph' && b.text.replace(/\u200B/g, '').trim() ? 'Hochachtungsvoll' : b.text, claims: [] }))
    return { ok: true, text: JSON.stringify({ title: 'Erklaerung', blocks }), account: 'test', model: 'test-model' }
  }
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Nyilatkozat', type: 'document' })
    if (!w.ok) throw new Error('item')
    src = w.item
    const s = addSection(src.id, 'Nyilatkozat')
    if (!s.ok) throw new Error('section')
    secId = s.section.id
    addBlock(src.id, secId, { text: 'Tisztelettel:', author: 'owner' })
    addBlock(src.id, secId, { text: BLANK_LINE, author: 'owner' })
    addBlock(src.id, secId, { kind: 'image', text: SIG, author: 'owner' })
    addBlock(src.id, secId, { text: BLANK_LINE, author: 'owner' })
    addBlock(src.id, secId, { text: 'Korpás László', author: 'owner' })
    setTranslateCallerForTest(model)
  })
  afterEach(() => setTranslateCallerForTest(null))

  const savedKinds = (): string[] => {
    const back = savedTranslationFor(src, 'de')
    if (!back.ok || !back.found) throw new Error('not found')
    return back.sections[0]!.blocks.map((b) => b.kind + ':' + (b.kind === 'image' ? b.text : b.text.replace(/\u200B/g, '').trim() ? 'text' : 'blank'))
  }

  it('the picture and the empty lines come over with the translation run and are saved as shown', async () => {
    const r = await previewSectionTranslation(src, secId, 'de', 'hu')
    if (!r.ok) throw new Error('preview')
    expect(r.preview.blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph', 'image', 'paragraph', 'paragraph'])
    expect(saveShownTranslation(src, 'de', [{ source_section: secId, title: r.preview.title, blocks: r.preview.blocks }], 'owner')).toMatchObject({ ok: true, saved: 1 })
    expect(savedKinds()).toEqual(['paragraph:text', 'paragraph:blank', 'image:' + SIG, 'paragraph:blank', 'paragraph:text'])
  })

  it('a picture put into the column by hand after the original changed is saved too (an old translation is saved as it stands)', async () => {
    const r = await previewSectionTranslation(src, secId, 'de', 'hu')
    if (!r.ok) throw new Error('preview')
    const plain = r.preview.blocks.filter((b) => b.kind !== 'image')
    expect(saveShownTranslation(src, 'de', [{ source_section: secId, title: r.preview.title, blocks: plain }], 'owner')).toMatchObject({ ok: true, saved: 1 })
    expect(savedKinds()).not.toContain('image:' + SIG)
    // the original changes (the saved version is old now); the owner puts the signature into the column and saves
    addBlock(src.id, secId, { text: 'Ein neuer Satz.', author: 'owner' })
    const withSig = [...plain.slice(0, 2), { kind: 'image', text: SIG, claims: [] }, ...plain.slice(2)]
    expect(saveShownTranslation(src, 'de', [{ source_section: secId, title: r.preview.title, blocks: withSig }], 'owner')).toMatchObject({ ok: true, saved: 1 })
    expect(savedKinds()).toEqual(['paragraph:text', 'paragraph:blank', 'image:' + SIG, 'paragraph:blank', 'paragraph:text'])
  })
})
