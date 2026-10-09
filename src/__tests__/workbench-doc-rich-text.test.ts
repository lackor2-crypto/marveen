// Word-like formatting of a document block (#527, Boss TG 2803): bold / italic / underline / strike and the
// paragraph alignment are stored next to the plain text, shown again, and carried into the PDF / Word render.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock, updateBlock, documentOutline } from '../workbench-docmodel.js'
import { richToPlain, sanitizeRich, richMatches } from '../workbench-docrich.js'
import { buildFodt, toRenderOutline } from '../workbench-docrender.js'

describe('rich text helpers', () => {
  it('keeps only b / i / u / s / br and nests them the same way every time', () => {
    expect(sanitizeRich('<strong>a</strong> <em>b</em><script>x</script><span style="x">c</span>')).toBe('<b>a</b> <i>b</i>xc')
    expect(sanitizeRich('plain')).toBe('')
    expect(sanitizeRich('<i><b>x</b></i>')).toBe('<b><i>x</i></b>')
  })
  it('the plain text drops the tags, turns <br> into a new line and decodes the entities', () => {
    expect(richToPlain('<b>A &amp; B</b><br>2 &lt; 3')).toBe('A & B\n2 < 3')
    expect(richMatches('<b>x</b>', 'x')).toBe(true)
    expect(richMatches('<b>x</b>', 'y')).toBe(false)
  })
})

describe('formatted blocks in the model', () => {
  let item: WorkItemRow
  let sec = ''
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Beadvány', type: 'document' })
    if (!w.ok) throw new Error('item')
    item = w.item
    const s = addSection(item.id, 'Tényállás')
    if (!s.ok) throw new Error('section')
    sec = s.section.id
  })
  const first = () => documentOutline(item.id).sections[0].blocks[0]

  it('a block made from rich text keeps the formatting and its plain text is derived from it', () => {
    const r = addBlock(item.id, sec, { rich: 'A <b>keresetet</b> beadtuk.', align: 'c', author: 'owner' })
    expect(r.ok).toBe(true)
    expect(first()).toMatchObject({ text: 'A keresetet beadtuk.', rich: 'A <b>keresetet</b> beadtuk.', align: 'c' })
  })

  it('an alignment-only change leaves text and formatting alone', () => {
    const r = addBlock(item.id, sec, { rich: '<i>dőlt</i>', author: 'owner' })
    if (!r.ok) throw new Error('add')
    expect(updateBlock(item.id, r.block.id, { align: 'r', author: 'owner' }).ok).toBe(true)
    expect(first()).toMatchObject({ text: 'dőlt', rich: '<i>dőlt</i>', align: 'r' })
    expect(updateBlock(item.id, r.block.id, { align: '', author: 'owner' }).ok).toBe(true)
    expect(first().align).toBeNull()
  })

  it('a plain-text rewrite (an agent, a renumbering) drops the formatting instead of painting the wrong words', () => {
    const r = addBlock(item.id, sec, { rich: '<b>régi</b>', author: 'owner' })
    if (!r.ok) throw new Error('add')
    updateBlock(item.id, r.block.id, { text: 'új szöveg', author: 'agent' })
    expect(first()).toMatchObject({ text: 'új szöveg', rich: null })
  })

  it('a bad alignment is refused', () => {
    expect(addBlock(item.id, sec, { text: 'x', align: 'zz', author: 'owner' }).ok).toBe(false)
  })

  it('the PDF / Word source carries the marks and the alignment', () => {
    addBlock(item.id, sec, { rich: 'A <b>fontos</b> <i>rész</i>', align: 'c', author: 'owner' })
    const xml = buildFodt(toRenderOutline(documentOutline(item.id)), { title: 'T', draft: false, lang: 'hu' } as never)
    expect(xml).toContain('<text:span text:style-name="FmtB">fontos</text:span>')
    expect(xml).toContain('<text:span text:style-name="FmtI">rész</text:span>')
    expect(xml).toContain('text:style-name="BodyAl_c"')
  })
})
