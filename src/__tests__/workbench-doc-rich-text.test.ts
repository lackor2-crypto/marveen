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

describe('font, size, colours and paragraph format (#527, Boss TG 2814)', () => {
  it('keeps font / size / colour / highlight in one fixed outer span and drops anything it does not know', () => {
    const r = sanitizeRich('<span style="color: rgb(255, 0, 0); font-size: 16px; font-family: Arial, sans-serif; background-color:#FFFF00; position:fixed">x</span>')
    expect(r).toBe('<span style="font-family:Arial;font-size:12pt;color:#ff0000;background-color:#ffff00">x</span>')
    expect(sanitizeRich('<span style="font-family: Comic Sans; font-size: 500pt; color: expression(1)">x</span>')).toBe('')
    expect(sanitizeRich('<span style="color:#f00" onclick="alert(1)">x</span>')).toBe('<span style="color:#ff0000">x</span>')
  })
  it('is stable: a canonical string comes back byte for byte', () => {
    const c = '<span style="font-family:Georgia;font-size:14pt;color:#336699"><b>vastag</b></span><span style="font-family:Georgia;font-size:14pt;color:#336699"> és</span> sima'
    expect(sanitizeRich(c)).toBe(c)
    expect(sanitizeRich(sanitizeRich(c))).toBe(sanitizeRich(c))
  })
  it('a nested span inherits the outer one and the plain text is unchanged', () => {
    const r = sanitizeRich('<span style="color:#ff0000">piros <span style="font-size:20pt">nagy</span></span>')
    expect(r).toBe('<span style="color:#ff0000">piros </span><span style="font-size:20pt;color:#ff0000">nagy</span>')
    expect(richToPlain(r)).toBe('piros nagy')
  })
})

describe('paragraph format in the model and the render', () => {
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

  it('stores line spacing, space after, indent and heading; unknown values are dropped; {} clears', () => {
    const r = addBlock(item.id, sec, { text: 'Szöveg', pfmt: { ls: 1.5, sa: 12, ind: 2, h: 7, x: 1 }, author: 'owner' })
    if (!r.ok) throw new Error('add')
    expect(first().pfmt).toEqual({ ls: 1.5, sa: 12, ind: 2 })
    expect(updateBlock(item.id, r.block.id, { pfmt: { ls: 1.33 }, author: 'owner' }).ok).toBe(true)
    expect(first().pfmt).toBeNull()
    updateBlock(item.id, r.block.id, { pfmt: { h: 2 }, author: 'owner' })
    expect(first().pfmt).toEqual({ h: 2 })
    updateBlock(item.id, r.block.id, { text: 'Új szöveg', author: 'owner' })
    expect(first().pfmt).toEqual({ h: 2 })
    updateBlock(item.id, r.block.id, { pfmt: {}, author: 'owner' })
    expect(first().pfmt).toBeNull()
  })

  it('the PDF / Word source carries the font, size, colours, spacing, indent and heading level', () => {
    addBlock(item.id, sec, { rich: 'A <span style="font-family:Arial;font-size:14pt;color:#ff0000;background-color:#ffff00">fontos</span> rész', pfmt: { ls: 1.5, sa: 12, ind: 2 }, author: 'owner' })
    addBlock(item.id, sec, { text: 'Alcím', pfmt: { h: 2 }, align: 'c', author: 'owner' })
    const o = documentOutline(item.id)
    const x = buildFodt(toRenderOutline(o), { title: 'T', lang: 'hu', draft: false, target: 'pdf' } as never)
    expect(x).toContain('fo:font-family="\'Arial\'"')
    expect(x).toContain('fo:font-size="14pt"')
    expect(x).toContain('fo:color="#ff0000"')
    expect(x).toContain('fo:background-color="#ffff00"')
    expect(x).toContain('fo:line-height="195%"')
    expect(x).toContain('fo:margin-left="2.00cm"')
    // space after is written in pt (a pt->cm slip once made 12 pt come out as 4.2 cm)
    expect(x).toContain('fo:margin-bottom="12pt"')
    expect(x).toContain('<text:h text:style-name=')
    expect(x).toContain('text:outline-level="2"')
  })
  it('Heading 1 (#534 a) is a paragraph style: stored, level 4 dropped, written as outline level 1', () => {
    const r = addBlock(item.id, sec, { text: 'Cím', pfmt: { h: 1 }, author: 'owner' })
    if (!r.ok) throw new Error('add')
    expect(first().pfmt).toEqual({ h: 1 })
    updateBlock(item.id, r.block.id, { pfmt: { h: 4 }, author: 'owner' })
    expect(first().pfmt).toBeNull()
    updateBlock(item.id, r.block.id, { pfmt: { h: 1 }, author: 'owner' })
    const x = buildFodt(toRenderOutline(documentOutline(item.id)), { title: 'T', lang: 'hu', draft: false, target: 'pdf' } as never)
    expect(x).toMatch(/<text:h text:style-name="[^"]+" text:outline-level="1">Cím<\/text:h>/)
  })
})
