// #856: ensureFitFor measures a language version against its original with the real page count (LibreOffice), stores the step
// under the fingerprint of both texts, measures again only when a text changed, and leaves an ordinary work item alone.
import { beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addBlock, addSection, listSections } from '../workbench-docmodel.js'
import { createVariant } from '../workbench-doclang.js'
import { fitOf } from '../workbench-docfit.js'
import { fitHashOf } from '../workbench-docfinal.js'
import { ensureFitFor } from '../workbench-docpages.js'

const hasOffice = spawnSync('soffice', ['--version']).status === 0
const LINE = 'Ich bitte Sie, sich schriftlich zu den folgenden Punkten zu äußern und entsprechend tätig zu werden, damit es geklärt wird.'

describe.skipIf(!hasOffice)('ensureFitFor measures the page fit of a language version again when a text changed (#856)', () => {
  let src: WorkItemRow
  let variant: WorkItemRow
  const addTo = (item: WorkItemRow, n: number, text: string) => {
    const sec = listSections(item.id)[0]!
    for (let i = 0; i < n; i++) if (!addBlock(item.id, sec.id, { text: `${text} ${i}`, author: 'agent' }).ok) throw new Error('block')
  }

  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Antrag', type: 'document' })
    if (!w.ok) throw new Error('item')
    src = w.item
    if (!addSection(src.id, '1. Antrag').ok) throw new Error('section')
    addTo(src, 3, LINE)
    const v = createVariant(src, 'hu', null)
    if (!v.ok) throw new Error('variant')
    variant = v.item
    addTo(variant, 3, 'Kérem, hogy írásban nyilatkozzon a következő pontokról.')
  }, 30000)

  it('stores the step under the fingerprint of both texts, and a changed text makes it measure again', async () => {
    await ensureFitFor(variant, 'hu')
    const first = fitOf(variant.id)
    expect(first?.hash).toBe(fitHashOf(src, variant))
    expect(first?.fits).toBe(1)
    addTo(variant, 1, 'Még egy bekezdés.')
    expect(fitOf(variant.id)?.hash).not.toBe(fitHashOf(src, variant))
    await ensureFitFor(variant, 'hu')
    expect(fitOf(variant.id)?.hash).toBe(fitHashOf(src, variant))
  }, 60000)

  it('an ordinary work item (not a language version) gets no stored fit', async () => {
    await ensureFitFor(src, 'hu')
    expect(fitOf(src.id)).toBeNull()
  })
})
