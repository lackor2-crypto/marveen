import { describe, it, expect } from 'vitest'
import { freePictureOffsets, applyFreePictures } from '../workbench-docedit.js'

const anchor = (x: number, y: number) =>
  '<w:drawing><wp:anchor behindDoc="0"><wp:positionH relativeFrom="column"><wp:posOffset>' + x + '</wp:posOffset></wp:positionH>' +
  '<wp:positionV relativeFrom="paragraph"><wp:posOffset>' + y + '</wp:posOffset></wp:positionV><wp:wrapNone/></wp:anchor></w:drawing>'
const inline = '<w:drawing><wp:inline></wp:inline></w:drawing>'

describe('free pictures survive the docx -> html round trip', () => {
  it('reads the offsets of wrapNone anchors, null for inline ones', () => {
    const off = freePictureOffsets('<w:p>' + inline + '</w:p><w:p>' + anchor(2160000, 2520000) + '</w:p>')
    expect(off).toEqual([null, { left: 6, top: 7 }])
  })
  it('puts them back on the matching <img> only when the counts agree', () => {
    const html = '<p><img src="a" align="left" width="9"></p><p><img src="b"></p>'
    const out = applyFreePictures(html, [{ left: 6, top: 7 }, null])
    expect(out).toContain('position:absolute; left:6cm; top:7cm')
    expect(out).not.toContain('align="left"')
    expect(applyFreePictures(html, [{ left: 6, top: 7 }])).toBe(html)
  })
})
