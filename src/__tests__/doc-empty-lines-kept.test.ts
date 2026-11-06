import { describe, expect, it } from 'vitest'
import { buildFodt, type RenderOutline } from '../workbench-docrender.js'

// Boss TG 5086: the German letter kept three plain empty lines above the printed name; the PDF collapsed them into one
// paragraph gap, so the signature (placed from the paragraph) slid below the name. Every empty line is a line.
const render = (text: string): string => {
  const outline: RenderOutline = { sections: [{ title: 'x', status: 'done', blocks: [{ kind: 'paragraph', text }] }] }
  return buildFodt(outline, { title: 't', author: 'a', draft: false, lang: 'de' } as never)
}
const count = (xml: string, s: string): number => xml.split(s).length - 1

describe('empty lines in a paragraph stay lines in the PDF', () => {
  it('three empty lines between the date and the name = a paragraph gap plus two empty lines', () => {
    const one = render('Chemnitz\n\nBakos')
    const three = render('Chemnitz\n\n\n\nBakos')
    expect(count(three, '​')).toBe(count(one, '​') + 2)
  })

})
