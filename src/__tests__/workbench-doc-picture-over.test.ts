// #566 (Boss TG 8982): a picture can lie FREE OVER the text -- it takes no room, pushes nothing, stays where it is put.
// Kept as `&o=1` after the free place; x / y are the offset from the paragraph the picture is anchored at.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { imageBlockParts } from '../workbench-docmodel.js'
import { buildFodt } from '../workbench-docrender.js'

const fodt = (blocks: unknown[]): string => buildFodt({ sections: [{ title: '1.', status: 'done', blocks }] } as never, { title: 'T', author: null, draft: false, lang: 'hu' } as never)
const PNG = { data: Buffer.from('89504e470d0a1a0a', 'hex'), width: 120, height: 60, mime: 'image/png' }
const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')

describe('the picture text', () => {
  it('reads the over mode; x runs 0..100 (cut by the width), y 0..300', () => {
    expect(imageBlockParts('k.png#w=30&a=l&x=60&y=250&o=1')).toEqual({ path: 'k.png', width: 30, align: 'l', x: 60, y: 250, over: true })
    expect(imageBlockParts('k.png#w=30&a=l&x=99&y=999&o=1')).toMatchObject({ x: 70, y: 300, over: true })
    expect(imageBlockParts('k.png#w=30&a=l&o=1')).toMatchObject({ x: 0, y: 0, over: true })
  })
  it('reads a tenth of a percent, so a picture can be put exactly (one percent is 7 px on a wide page)', () => {
    expect(imageBlockParts('k.png#w=30&a=l&x=12.5&y=3.4&o=1')).toMatchObject({ x: 12.5, y: 3.4, over: true })
  })
  it('an old suffix without o reads unchanged', () => {
    expect(imageBlockParts('k.png#w=30&a=l&x=35&y=20')).toEqual({ path: 'k.png', width: 30, align: 'l', x: 35, y: 20, over: false })
    expect(imageBlockParts('k.png#w=30&a=l&x=35&y=200')).toMatchObject({ y: 150, over: false })
    expect(imageBlockParts('k.png#w=30&a=l')).toMatchObject({ x: null, y: null, over: false })
  })
})

describe('the PDF / Word source', () => {
  it('an over picture is a run-through frame anchored at the paragraph, with x / y, and no paragraph of its own height', () => {
    const x = fodt([{ kind: 'image', text: 'k.png#w=30&a=l&x=60&y=20&o=1', img: PNG }])
    expect(x).toMatch(/<style:style style:name="ImgOver1" style:family="graphic"[^>]*><style:graphic-properties style:wrap="run-through" style:run-through="foreground" style:horizontal-pos="from-left" style:horizontal-rel="paragraph" style:vertical-pos="from-top" style:vertical-rel="paragraph"/)
    expect(x).toMatch(/<text:p text:style-name="FrameAnchor"><draw:frame draw:style-name="ImgOver1"[^>]*text:anchor-type="paragraph" svg:x="9\.90cm" svg:y="3\.30cm"/)
    expect(x).not.toContain('ImageFree1')
    expect(x).not.toContain('ImgWrap1')
  })
  it('the old free place keeps its flow rendering', () => {
    const x = fodt([{ kind: 'image', text: 'k.png#w=30&a=l&x=35&y=20', img: PNG }])
    expect(x).toContain('ImageFree1')
    expect(x).not.toContain('ImgOver1')
  })
})

describe('the editor', () => {
  it('parses the same suffix as the server, writes it back, and a signature arrives in the free mode', () => {
    expect(js).toContain('(&o=1)?$/.exec(String(text')
    expect(js).toMatch(/function dpImageText\(path, width, align, x, y, over\)/)
    expect(js).toContain("rel + '#w=30&a=l&x=60&y=0&o=1'")
  })
  it('has the two-mode switch: toolbar button, right-click menu, and a drag that re-anchors', () => {
    expect(js).toContain('data-wb-act="dp-img-mode"')
    expect(js).toContain("a === 'dp-img-mode'")
    expect(js).toContain("document.addEventListener('contextmenu'")
    expect(js).toContain('function dpOverDragStart(')
    expect(js).toContain('function dpOverPlace(')
  })
})
