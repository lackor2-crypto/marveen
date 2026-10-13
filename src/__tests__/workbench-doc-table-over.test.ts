// #590 (Boss, TG 9007: "az Excelnel is ugyanazt, mint a fotonal"): a table takes the picture's second mode -- it lies
// FREE OVER the text (`&x=..&y=..&o=1` after the size) -- and editing its cells no longer drops its place.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { tableBlockParts } from '../workbench-docmodel.js'
import { buildFodt } from '../workbench-docrender.js'

const fodt = (blocks: unknown[]): string => buildFodt({ sections: [{ title: '1.', status: 'done', blocks }] } as never, { title: 'T', author: null, draft: false, lang: 'hu' } as never)
const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../web/workbench.css', import.meta.url), 'utf8')

describe('the table text', () => {
  it('reads the over mode like a picture: x 0..100 (cut by the width), y 0..300, a tenth of a percent', () => {
    expect(tableBlockParts('a | b\n#w=40&a=l&x=55&y=250&o=1')).toEqual({ text: 'a | b', width: 40, align: 'l', x: 55, y: 250, over: true })
    expect(tableBlockParts('a | b\n#w=40&a=l&x=99&y=999&o=1')).toMatchObject({ x: 60, y: 300, over: true })
    expect(tableBlockParts('a | b\n#w=40&a=l&x=12.5&y=3.4&o=1')).toMatchObject({ x: 12.5, y: 3.4, over: true })
    expect(tableBlockParts('a | b\n#w=40&a=l&o=1')).toMatchObject({ x: 0, y: 0, over: true })
  })
  it('the older forms read unchanged', () => {
    expect(tableBlockParts('a | b\n#w=40&a=l&x=35&y=20')).toMatchObject({ x: 35, y: 20, over: false })
    expect(tableBlockParts('a | b\n#w=40&a=r')).toMatchObject({ x: null, y: null, over: false })
    expect(tableBlockParts('a | b')).toMatchObject({ width: null, over: false })
  })
})

describe('the PDF / Word source', () => {
  it('an over table is a run-through text-box frame anchored at the paragraph, at x / y, with no paragraph of its own height', () => {
    const x = fodt([{ kind: 'table', text: 'Tétel | Összeg\nLakbér | 500\n#w=40&a=l&x=50&y=20&o=1' }])
    expect(x).toMatch(/<style:style style:name="TblOver1" style:family="graphic"[^>]*><style:graphic-properties style:wrap="run-through" style:run-through="foreground" style:horizontal-pos="from-left" style:horizontal-rel="paragraph" style:vertical-pos="from-top" style:vertical-rel="paragraph"/)
    expect(x).toMatch(/<text:p text:style-name="FrameAnchor"><draw:frame draw:style-name="TblOver1"[^>]*text:anchor-type="paragraph" svg:x="8\.25cm" svg:y="3\.30cm" svg:width="6\.60cm"/)
    expect(x).toContain('<draw:text-box')
    expect(x).not.toContain('TblGap1')
    expect(x).not.toContain('TblFrame1')
  })
  it('the other table forms keep their rendering', () => {
    const free = fodt([{ kind: 'table', text: 'a | b\n#w=40&a=l&x=50&y=20' }])
    expect(free).toContain('TblGap1')
    expect(free).not.toContain('TblOver1')
    const wrap = fodt([{ kind: 'table', text: 'a | b\n#w=40&a=r' }])
    expect(wrap).toContain('TblFrame1')
    expect(wrap).not.toContain('TblOver1')
  })
})

describe('the editor', () => {
  it('reads and writes the same suffix as the server', () => {
    expect(js).toMatch(/function dpTableText\(body, width, align, x, y, over\)/)
    expect(js).toContain('(&o=1)?\\s*$/.exec(String(text')
  })
  it('a table has the two-mode switch like a picture: toolbar, right-click menu, over drag, resize', () => {
    expect(js).toContain("dpImgModeBtn(b.id, 'over', overT)")
    expect(js).toContain("e.target.closest('[data-wb-img-block], [data-wb-tbl-block]')")
    expect(js).toContain("hd.closest('.wb-dp-img, .wb-dp-tbl')")
    expect(js).toContain("row.style.setProperty('--wb-ow', String(pct))")
    expect(css).toContain('.wb-dp-row-over > .wb-dp-tbl')
  })
  it('editing a table keeps its place and mode in all three places that save the cells', () => {
    expect(js).not.toMatch(/dpTableText\([^()]*, tp\.width, tp\.align\)/)
    expect((js.match(/tp\.width, tp\.align, tp\.x, tp\.y, tp\.over/g) || []).length).toBe(3)
  })
})
