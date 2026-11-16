import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock, documentOutline } from '../workbench-docmodel.js'
import { translateSection, listVariants } from '../workbench-doclang.js'
import { saveShownTranslation } from '../workbench-doclang-translate.js'

// #866 (Boss TG 5175): the translation page is a free document without the AI agent. Select all + paste ONE line (an external
// translation) leaves the chapter with a heading only and no paragraphs. The owner's page save used to refuse that ("1 fejezetet nem
// sikerult elmenteni") and left an empty language version behind; the agent's own path keeps its "no blocks" guard.
describe('#866: a chapter the owner saved with a heading only (pasted one line)', () => {
  let src: WorkItemRow
  let secId = ''

  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Beadvany', type: 'document' })
    if (!w.ok) throw new Error('item')
    src = w.item
    const s = addSection(src.id, 'Tenyallas')
    if (!s.ok) throw new Error('section')
    secId = s.section.id
    for (const text of ['Elso bekezdes.', 'Masodik bekezdes.']) {
      const b = addBlock(src.id, secId, { text, author: 'owner' })
      if (!b.ok) throw new Error('block')
    }
  })

  it('the owner\'s page save stores it (saved 1, nothing failed)', () => {
    const r = saveShownTranslation(src, 'de', [{ source_section: secId, title: 'Die ganze Uebersetzung in einer Zeile.', blocks: [] }], 'owner')
    expect(r).toMatchObject({ ok: true, saved: 1, failed: [] })
    expect(listVariants(src.id)).toHaveLength(1)
    if (!r.ok) throw new Error('save')
    expect(JSON.stringify(documentOutline(r.variant.id))).toContain('Die ganze Uebersetzung in einer Zeile.')
  })

  it('saving the same title-only page again says it is already there', () => {
    const sec = { source_section: secId, title: 'Nur Titel', blocks: [] }
    expect(saveShownTranslation(src, 'de', [sec], 'owner')).toMatchObject({ ok: true, saved: 1 })
    expect(saveShownTranslation(src, 'de', [sec], 'owner')).toMatchObject({ ok: true, saved: 0, unchanged: 1, failed: [] })
  })

  it('the agent path keeps its guard: no blocks for a section that has some is still refused', () => {
    const r = saveShownTranslation(src, 'de', [{ source_section: secId, title: 'x', blocks: [] }], 'owner')
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('save')
    const direct = translateSection(r.variant.id, { source_section: secId, title: 'Nur Titel', blocks: [] }, 'agent')
    expect(direct.ok).toBe(false)
  })
})
