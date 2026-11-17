// #852: the page-break lines of a language version's draft sheet must be measured on the SAME drawing as the draft PDF.
// The draft PDF measures the page fit first (ensureFitFor); the page-break measurement used the stored fit as it was, so
// with no / stale fit it drew the version loose (3 blank lines before the signature), the signature slid to page 2 in the
// measurement while the real draft PDF -- tightened -- kept it on page 1 (or the other way round).
import { beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addBlock, addSection, listBlocks, listSections } from '../workbench-docmodel.js'
import { createVariant } from '../workbench-doclang.js'
import { fitOf } from '../workbench-docfit.js'
import { renderDraft } from '../workbench-docfinal.js'
import { pageBreaksFor, pdfPageTexts } from '../workbench-docpages.js'

const hasTools = spawnSync('soffice', ['--version']).status === 0 && spawnSync('pdftotext', ['-v']).status === 0
const BL = '​'
const LINE = 'Ich bitte Sie, sich schriftlich zu den folgenden Punkten zu äußern und entsprechend tätig zu werden, damit es geklärt wird.'

describe.skipIf(!hasTools)('the draft sheet page lines are measured on the tightened drawing, like the draft PDF (#852)', () => {
  let src: WorkItemRow
  let variant: WorkItemRow
  const add = (item: WorkItemRow, texts: string[]) => {
    const sec = listSections(item.id)[0]!
    for (const t of texts) if (!addBlock(item.id, sec.id, { text: t, author: 'agent' }).ok) throw new Error('block')
  }
  // the original keeps 2 blank lines before the closing, the version 6: loose it needs 2 pages, tightened (step 1) 1 page like the original
  const body = (n: number, blanks: number, sig: string) => [
    ...Array.from({ length: n }, (_, i) => `${LINE} ${i}`),
    ...Array(blanks).fill(BL), 'Mit freundlichen Grüßen', BL, BL, BL, sig,
  ]

  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Antrag', type: 'document' })
    if (!w.ok) throw new Error('item')
    src = w.item
    if (!addSection(src.id, '1. Antrag').ok) throw new Error('section')
    add(src, body(11, 2, 'Korpás László'))
    const v = createVariant(src, 'hu', null)
    if (!v.ok) throw new Error('variant')
    variant = v.item
    add(variant, body(11, 6, 'Korpás László'))
  }, 60000)

  it('the number of pages the page lines report equals the page count of the draft PDF, with no stored fit yet', async () => {
    expect(fitOf(variant.id)).toBeNull()
    const marks = await pageBreaksFor(variant, 'hu')
    if (!marks.ok) throw new Error(marks.code)
    const draft = await renderDraft(variant, 'hu')
    if (!draft.ok) throw new Error(draft.code)
    const t = await pdfPageTexts(draft.pdf)
    if (!t.ok) throw new Error(t.detail)
    expect(t.pages.length).toBe(1)
    expect(marks.pages).toBe(t.pages.length)
    expect(marks.marks).toEqual([])
  }, 120000)

  // The owner's case (TG 4766-4771): the signature must be on the SAME page in the sheet's page lines as in the draft PDF.
  // Measured for a run of body lengths, so the signature lands on page 1, on the boundary and on page 2.
  it('the page the page lines put the closing and the signature on is the page the draft PDF has them on (original, signature around the page edge)', async () => {
    const texts = ['Mit freundlichen Grüßen', 'Korpás László']
    const seenPages = new Set<number>()
    for (let n = 12; n < 30; n++) {
      const w = createWorkItem({ project_id: variant.project_id, title: `Antrag ${n}`, type: 'document' })
      if (!w.ok) throw new Error('item')
      const doc = w.item
      if (!addSection(doc.id, '1. Antrag').ok) throw new Error('section')
      add(doc, body(n, 2, 'Korpás László'))
      const marks = await pageBreaksFor(doc, 'hu')
      if (!marks.ok) throw new Error(marks.code)
      const draft = await renderDraft(doc, 'hu')
      if (!draft.ok) throw new Error(draft.code)
      const t = await pdfPageTexts(draft.pdf)
      if (!t.ok) throw new Error(t.detail)
      expect(marks.pages).toBe(t.pages.length)
      const blocks = listBlocks(doc.id)
      // page of a block according to the lines: the highest mark at or before it
      const pageByLines = (id: string) => {
        const idx = blocks.findIndex((b) => b.id === id)
        let page = 1
        for (const m of marks.marks) {
          const at = blocks.findIndex((b) => b.id === m.id)
          if (at !== -1 && at <= idx) page = Math.max(page, m.page)
        }
        return page
      }
      for (const txt of texts) {
        const b = blocks.find((x) => x.text === txt)!
        const realPage = t.pages.findIndex((pg) => pg.includes(txt)) + 1
        expect(pageByLines(b.id), `n=${n} "${txt}"`).toBe(realPage)
        if (txt === 'Korpás László') seenPages.add(realPage)
      }
    }
    // the run really crosses the page edge, so the check above saw the signature on both sides of it
    expect(seenPages.has(1) && seenPages.has(2)).toBe(true)
  }, 300000)
})
