import { describe, expect, it } from 'vitest'
import { buildFodt, type RenderOutline } from '../workbench-docrender.js'

// Boss TG 5086: the German letter kept three plain empty lines above the printed name; the PDF collapsed them into one
// paragraph gap, so the signature (placed from the paragraph) slid below the name. Every empty line is a line.
const render = (text: string, rich?: string): string => {
  const outline: RenderOutline = { sections: [{ title: 'x', status: 'done', blocks: [{ kind: 'paragraph', text, ...(rich ? { rich } : {}) }] }] }
  return buildFodt(outline, { title: 't', author: 'a', draft: false, lang: 'de' } as never)
}
const count = (xml: string, s: string): number => xml.split(s).length - 1

describe('empty lines in a paragraph stay lines in the PDF', () => {
  it('three empty lines between the date and the name = a paragraph gap plus two empty lines', () => {
    const one = render('Chemnitz\n\nBakos')
    const three = render('Chemnitz\n\n\n\nBakos')
    expect(count(three, '​')).toBe(count(one, '​') + 2)
  })

  // #864: the formatted (rich) branch of the renderer has its own empty-line loop -- the same rule must hold there.
  it('the formatted text keeps them as well', () => {
    const one = render('Chemnitz\n\nBakos', '<b>Chemnitz</b><br><br>Bakos')
    const three = render('Chemnitz\n\n\n\nBakos', '<b>Chemnitz</b><br><br><br><br>Bakos')
    expect(count(three, '​')).toBe(count(one, '​') + 2)
  })

  it('stored empty lines (one zero-width space each) are one line each', () => {
    const one = render('Chemnitz\n​\nBakos')
    const three = render('Chemnitz\n​\n​\n​\nBakos')
    expect(count(three, '​')).toBe(count(one, '​') + 2)
  })

})
