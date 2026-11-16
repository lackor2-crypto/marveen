// #856: the stored page fit of a language version belongs to the exact texts it was measured on. A fit measured on older
// texts must not shape the draft / Word / final PDF of newer texts, and the final steps measure again before they draw.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addBlock, addSection, listSections } from '../workbench-docmodel.js'
import { createVariant } from '../workbench-doclang.js'
import { saveFit } from '../workbench-docfit.js'

const fitCalls: string[] = []
vi.mock('../workbench-docpages.js', () => ({
  ensureFitFor: vi.fn(async (item: WorkItemRow) => { fitCalls.push(item.id) }),
  fitVariantToSource: vi.fn(async () => null),
  pageBreaksFor: vi.fn(async () => ({ ok: false, code: 'x', detail: null })),
}))

const TEXT = 'Ich bitte Sie, sich schriftlich zu den folgenden Punkten zu äußern und entsprechend tätig zu werden.'

describe('the stored page fit follows the texts it was measured on (#856)', () => {
  let src: WorkItemRow
  let variant: WorkItemRow

  beforeEach(() => {
    initDatabase(':memory:')
    fitCalls.length = 0
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Antrag', type: 'document' })
    if (!w.ok) throw new Error('item')
    src = w.item
    const s = addSection(src.id, '1. Antrag')
    if (!s.ok) throw new Error('section')
    if (!addBlock(src.id, s.section.id, { text: TEXT, author: 'agent' }).ok) throw new Error('block')
    const v = createVariant(src, 'hu', null)
    if (!v.ok) throw new Error('variant')
    variant = v.item
    const vs = listSections(variant.id)[0]!
    if (!addBlock(variant.id, vs.id, { text: 'Kérem, hogy írásban nyilatkozzon a következő pontokról.', author: 'agent' }).ok) throw new Error('vblock')
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('a fit measured on the current texts shapes the drawing, a fit measured on older texts does not', async () => {
    const { contentHash, renderInputFor } = await import('../workbench-docfinal.js')
    saveFit(variant.id, { hash: `${contentHash(src)}|${contentHash(variant)}`, level: 4, source_pages: 2, pages: 2, fits: true })
    expect(renderInputFor(variant).bodyPt).toBe(11)
    // the owner changes the translation afterwards: the stored step was measured on other text
    const vs = listSections(variant.id)[0]!
    if (!addBlock(variant.id, vs.id, { text: 'Egy újabb bekezdés.', author: 'agent' }).ok) throw new Error('vblock2')
    expect(renderInputFor(variant).bodyPt).toBeUndefined()
    expect(renderInputFor(variant, false, 3).bodyPt).toBe(11.5)
  })

  it('the draft, the Word copy, the plain PDF and the final PDF measure the version again first', async () => {
    const m = await import('../workbench-docfinal.js')
    await m.renderDraft(variant, 'hu')
    await m.renderDocx(variant, 'hu')
    await m.renderPlainPdf(variant, 'hu')
    expect(fitCalls).toEqual([variant.id, variant.id, variant.id])
    m.recordReview(variant.id, m.contentHash(variant), null)
    await m.finalizeDocument(variant, { accept: true, hash: null, by: null, lang: 'hu', override: true }).catch(() => null)
    expect(fitCalls).toEqual([variant.id, variant.id, variant.id, variant.id])
  })
})
