// Boss TG 3618: a letter with a signature block but no handwritten signature picture gets a WARNING on the
// Gaps tab; it never holds the finalizing back (ok stays true).
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock, documentCheck } from '../workbench-docmodel.js'

function setup(): { itemId: string; secId: string } {
  initDatabase(':memory:')
  const p = createProject({ name: 'Iroda' })
  if (!p.ok) throw new Error('project')
  const w = createWorkItem({ project_id: p.project.id, title: 'Antwort', type: 'document' })
  if (!w.ok) throw new Error('item')
  const s = addSection(w.item.id, { title: 'Levél' })
  if (!s.ok) throw new Error('section')
  return { itemId: w.item.id, secId: s.section.id }
}
const item = (id: string) => documentCheck(id).items.find((i) => i.key === 'signature_missing')!

describe('signature warning in the document check', () => {
  let ctx: { itemId: string; secId: string }
  beforeEach(() => { ctx = setup() })

  it('no signature block: nothing to warn about', () => {
    addBlock(ctx.itemId, ctx.secId, { kind: 'paragraph', text: 'Sehr geehrte Frau Teege', author: 'agent' })
    expect(item(ctx.itemId).count).toBe(0)
  })
  it('a signature block without a signature picture warns, but does not block', () => {
    addBlock(ctx.itemId, ctx.secId, { kind: 'signature', text: 'Chemnitz, 15.10.2026\n\nKorpás László', author: 'agent' })
    const it = item(ctx.itemId)
    expect(it.count).toBe(1)
    expect(it.ok).toBe(true)
  })
  it('a picture whose file name says signature clears the warning', () => {
    addBlock(ctx.itemId, ctx.secId, { kind: 'signature', text: 'Chemnitz, 15.10.2026\n\nKorpás László', author: 'agent' })
    const img = addBlock(ctx.itemId, ctx.secId, { kind: 'image', text: 'Személyes/Aláírás Korpás László.png', author: 'owner' })
    expect(img.ok).toBe(true)
    expect(item(ctx.itemId).count).toBe(0)
  })
})
