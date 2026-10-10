import { describe, it, expect } from 'vitest'
import { tableBlockParts } from '../workbench-docmodel.js'
import { buildFodt } from '../workbench-docrender.js'

const base = ' a | b\n 1 | 2'
const render = (text: string): string => buildFodt(
  { sections: [{ title: 'T', status: 'ready' as never, blocks: [{ kind: 'table' as never, text }] }] },
  { title: 'T', author: null, draft: false, lang: 'hu' },
)

describe('table block width and alignment (#508)', () => {
  it('parses the trailing size line and keeps plain tables untouched', () => {
    expect(tableBlockParts(base)).toEqual({ text: base, width: null, align: 'c', x: null, y: null })
    expect(tableBlockParts(base + '\n#w=40&a=r')).toEqual({ text: base, width: 40, align: 'r', x: null, y: null })
    expect(tableBlockParts(base + '\n#w=5&a=l').width).toBe(10)
    expect(tableBlockParts(base + '\n#w=300').width).toBe(100)
  })

  it('a plain table keeps the default style and has no frame', () => {
    const x = render(base)
    expect(x).toContain('table:style-name="Tbl"')
    expect(x).not.toContain('<draw:frame')
  })

  it('a narrow centred table gets its own width, no frame', () => {
    const x = render(base + '\n#w=50&a=c')
    expect(x).toContain('style:width="8.25cm"')
    expect(x).not.toContain('<draw:frame')
  })

  it('a narrow left/right table sits in a wrapped frame and the size line is not a row', () => {
    for (const a of ['l', 'r']) {
      const x = render(base + `\n#w=40&a=${a}`)
      expect(x).toContain('<draw:frame')
      expect(x).toContain('style:horizontal-pos="' + (a === 'r' ? 'right' : 'left') + '"')
      expect(x).toContain('style:parent-style-name="Frame"')
      expect(x).not.toContain('#w=')
    }
  })
})
