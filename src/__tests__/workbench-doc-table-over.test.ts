// #590 (Boss TG 9045): a table can be placed like a picture -- also FREE OVER the text (`&o=1`, as the picture's #566 mode) --
// and editing a table never drops its free place (x / y) or its over mode.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { tableBlockParts } from '../workbench-docmodel.js'
import { buildFodt } from '../workbench-docrender.js'

const base = ' a | b\n 1 | 2'
const render = (text: string): string => buildFodt(
  { sections: [{ title: 'T', status: 'ready' as never, blocks: [{ kind: 'table' as never, text }] }] },
  { title: 'T', author: null, draft: false, lang: 'hu' },
)
const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../web/workbench.css', import.meta.url), 'utf8')

describe('the table text', () => {
  it('reads the over mode like the picture does', () => {
    expect(tableBlockParts(base + '\n#w=40&a=l&x=60&y=250&o=1')).toMatchObject({ width: 40, x: 60, y: 250, over: true })
    expect(tableBlockParts(base + '\n#w=40&a=l&x=99&y=999&o=1')).toMatchObject({ x: 60, y: 300, over: true })
    expect(tableBlockParts(base + '\n#w=40&a=l&x=35&y=20')).toMatchObject({ x: 35, y: 20, over: false })
    expect(tableBlockParts(base + '\n#w=40&a=r')).toMatchObject({ x: null, over: false })
  })
})

describe('the PDF / Word source', () => {
  it('an over table is a run-through frame at x / y from its paragraph and takes no room', () => {
    const x = render(base + '\n#w=40&a=l&x=50&y=20&o=1')
    expect(x).toMatch(/<style:style style:name="TblOver1" style:family="graphic"[^>]*><style:graphic-properties style:wrap="run-through" style:run-through="foreground" style:horizontal-pos="from-left" style:horizontal-rel="paragraph" style:vertical-pos="from-top"/)
    expect(x).toMatch(/<draw:frame draw:style-name="TblOver1"[^>]*text:anchor-type="paragraph" svg:x="8\.25cm" svg:y="3\.30cm" svg:width="6\.60cm"/)
    expect(x).toContain('<draw:text-box')
    expect(x).not.toContain('TblGap1')
    expect(x).not.toContain('#w=')
  })
  it('the in-flow free place stays as it was', () => {
    const x = render(base + '\n#w=40&a=l&x=35&y=20')
    expect(x).toContain('TblGap1')
    expect(x).not.toContain('TblOver1')
  })
})

describe('the editor keeps the place', () => {
  it('every re-save of a table text passes x, y and over on (an edit no longer drops the free place)', () => {
    expect(js).not.toMatch(/dpTableText\([^()]*tp\.width, tp\.align\)/)
    expect((js.match(/tp\.align, tp\.x, tp\.y, tp\.over\)/g) || []).length).toBe(3)
  })
  it('has the over mode for the table: parser, writer, mode buttons, drag, css', () => {
    expect(js).toContain('(&o=1)?\\s*$/.exec(String(text')
    expect(js).toMatch(/function dpTableText\(body, width, align, x, y, over\)/)
    expect(js).toContain("dpImgModeBtn(b.id, 'over', !!pic.over)")
    expect(js).toContain("var isTbl = b.kind === 'table'")
    expect(js).toContain('a table lying over the text is dragged like a picture')
    expect(css).toContain('.wb-dp-row-over > .wb-dp-tbl')
  })
})
