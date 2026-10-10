// #521 (the owner, TG 8337 / TG 8451): a picture or a table can be placed anywhere on the page.
// Kept in the block's own text (`&x=..&y=..` after the size), so it travels with versions,
// the Word mirror and the language variants; rendered in the text flow, so a page break
// carries it and it never runs into the footer.
import { describe, it, expect } from 'vitest'
import { imageBlockParts, tableBlockParts, FREE_X_MAX, FREE_Y_MAX } from '../workbench-docmodel.js'
import { buildFodt } from '../workbench-docrender.js'

const fodt = (blocks: unknown[]): string => buildFodt({ sections: [{ title: '1.', status: 'done', blocks }] } as never, { title: 'T', author: null, draft: false, lang: 'hu' } as never)
const PNG = { data: Buffer.from('89504e470d0a1a0a', 'hex'), width: 120, height: 60, mime: 'image/png' }

describe('the place of a block in its text', () => {
  it('the old forms read exactly as before: no place', () => {
    expect(imageBlockParts('a/b.png')).toEqual({ path: 'a/b.png', width: null, align: 'c', x: null, y: null })
    expect(imageBlockParts('a/b.png#w=50&a=l')).toEqual({ path: 'a/b.png', width: 50, align: 'l', x: null, y: null })
    expect(tableBlockParts('a | b\n1 | 2')).toEqual({ text: 'a | b\n1 | 2', width: null, align: 'c', x: null, y: null })
    expect(tableBlockParts('a | b\n1 | 2\n#w=40&a=r')).toEqual({ text: 'a | b\n1 | 2', width: 40, align: 'r', x: null, y: null })
  })

  it('a free place is read; x is cut so that the element still fits, y has an upper limit', () => {
    expect(imageBlockParts('k.png#w=30&a=l&x=35&y=20')).toEqual({ path: 'k.png', width: 30, align: 'l', x: 35, y: 20 })
    expect(tableBlockParts('a | b\n#w=40&a=l&x=55&y=12')).toEqual({ text: 'a | b', width: 40, align: 'l', x: 55, y: 12 })
    expect(imageBlockParts('k.png#w=60&a=l&x=80&y=0').x).toBe(40) // 60 wide: at most 40 from the left
    expect(tableBlockParts('a\n#w=10&a=l&x=99&y=999')).toMatchObject({ x: FREE_X_MAX, y: FREE_Y_MAX })
    expect(tableBlockParts('a\n#w=100&a=c&x=30&y=10')).toMatchObject({ width: 100, x: 0, y: 10 })
    // Half a place is no place.
    expect(imageBlockParts('k.png#w=30&a=l&x=35').x).toBeNull()
  })
})

describe('the place in the PDF / Word source', () => {
  it('a free table: a left indent on the table, the space above as its own empty paragraph, no text beside it', () => {
    const x = fodt([{ kind: 'table', text: 'Tétel | Összeg\nLakbér | 500\n#w=40&a=l&x=50&y=20' }])
    expect(x).toMatch(/<style:style style:name="TblW1" style:family="table"><style:table-properties style:width="6\.60cm" table:align="left" fo:margin-left="8\.25cm"/)
    expect(x).toMatch(/<style:style style:name="TblGap1"[^>]*><style:paragraph-properties fo:margin-top="3\.30cm"/)
    expect(x).toMatch(/<text:p text:style-name="TblGap1"\/>\s*<table:table table:name="T1"/)
    expect(x).not.toContain('TblFrame1')
  })

  it('a free table at the very top of its place has no empty paragraph above it', () => {
    const x = fodt([{ kind: 'table', text: 'a | b\n#w=40&a=l&x=10&y=0' }])
    expect(x).not.toContain('TblGap1')
    expect(x).toMatch(/fo:margin-left="1\.65cm"/)
  })

  it('a free full-width table keeps its width and still gets the space above', () => {
    const x = fodt([{ kind: 'table', text: 'a | b\n#w=100&a=c&x=0&y=10' }])
    expect(x).toMatch(/style:width="16\.50cm" table:align="left" fo:margin-left="0\.00cm"/)
    expect(x).toContain('TblGap1')
  })

  it('a free picture: its paragraph carries the left indent and the space above', () => {
    const x = fodt([{ kind: 'image', text: 'k.png#w=30&a=l&x=35&y=20', img: PNG }])
    expect(x).toMatch(/<style:style style:name="ImageFree1"[^>]*><style:paragraph-properties fo:text-align="start" fo:margin-left="5\.78cm" fo:margin-top="3\.45cm"/)
    expect(x).toMatch(/<text:p text:style-name="ImageFree1"><draw:frame/)
  })

  it('what is not placed freely renders exactly as before', () => {
    const x = fodt([{ kind: 'table', text: 'a | b\n#w=40&a=r' }, { kind: 'image', text: 'k.png#w=30&a=l', img: PNG }, { kind: 'table', text: 'a | b' }])
    expect(x).toContain('TblFrame1') // right-aligned and narrow: the text still runs beside it
    expect(x).toMatch(/<text:p text:style-name="ImagePL"><draw:frame/)
    expect(x).not.toContain('ImageFree')
    expect(x).not.toContain('TblGap')
  })
})
