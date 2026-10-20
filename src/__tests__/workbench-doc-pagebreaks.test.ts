// #590 (Boss, TG 9007): the document page shows a dashed line where the next page of the PDF begins. The place is read
// from the real draft PDF's text: every chapter and block is looked up in it, in order.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { matchPages, pageNorm, pageUnitsOf } from '../workbench-docpages.js'

const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../web/workbench.css', import.meta.url), 'utf8')
const unit = (id: string, text: string) => ({ id, text, kind: 'block' as const })

describe('what is compared', () => {
  it('letters and digits only, lower case: bullets, quotes and line wrapping do not matter', () => {
    expect(pageNorm('„Első”\n  tétel – 12,5 Ft')).toBe('elsőtétel125ft')
  })
})

describe('matchPages', () => {
  const p1 = 'Fejezet egy\nAlfa bekezdés szövege ami az első oldalon van.\nBéta bekezdés szövege ami az első oldalon van.'
  const p2 = 'Gamma bekezdés szövege ami a második oldalon kezdődik.\nDelta bekezdés szövege ami a második oldalon van.'
  const units = [unit('a', 'Alfa bekezdés szövege ami az első oldalon van.'), unit('b', 'Béta bekezdés szövege ami az első oldalon van.'), unit('c', 'Gamma bekezdés szövege ami a második oldalon kezdődik.'), unit('d', 'Delta bekezdés szövege ami a második oldalon van.')]

  it('a page begins right before the first block that is on it; page 1 has no line', () => {
    expect(matchPages([p1, p2], units)).toEqual([{ id: 'c', page: 2, inside: false }])
  })

  it('a paragraph that runs over the page end is marked where the next page begins inside it', () => {
    const long = 'Ez egy nagyon hosszú bekezdés eleje amely az első oldalon kezdődik és folytatódik tovább a második oldalra a végén zárul le.'
    const pages = ['Ez egy nagyon hosszú bekezdés eleje amely az első oldalon kezdődik és folytatódik tovább', 'a második oldalra a végén zárul le.\nKövetkező bekezdés a második oldalon.']
    expect(matchPages(pages, [unit('x', long), unit('y', 'Következő bekezdés a második oldalon.')])).toEqual([{ id: 'x', page: 2, inside: true }])
  })

  it('a block the PDF text does not hold is skipped and the others keep their place', () => {
    const withGhost = [units[0]!, unit('ghost', 'Ez a szöveg sehol sincs a PDF-ben, kép vagy összetett tábla.'), units[1]!, units[2]!, units[3]!]
    expect(matchPages([p1, p2], withGhost)).toEqual([{ id: 'c', page: 2, inside: false }])
  })

  it('the same text twice is read in order, not matched to the first copy twice', () => {
    const pages = ['Aláírás helye\nElső rész szövege.', 'Aláírás helye\nMásodik rész szövege.']
    const r = matchPages(pages, [unit('s1', 'Aláírás helye'), unit('t1', 'Első rész szövege.'), unit('s2', 'Aláírás helye'), unit('t2', 'Második rész szövege.')])
    expect(r).toEqual([{ id: 's2', page: 2, inside: false }])
  })

  it('an empty document or an empty PDF gives no lines', () => {
    expect(matchPages([], units)).toEqual([])
    expect(matchPages([p1], [])).toEqual([])
  })
})

describe('pageUnitsOf', () => {
  it('lists the chapter titles and the blocks in reading order; a picture is not looked up, a table by its first cell', () => {
    const u = pageUnitsOf([{ id: 's1', title: 'Tényállás', blocks: [{ id: 'b1', kind: 'paragraph', text: 'Szöveg.' }, { id: 'b2', kind: 'image', text: 'a/k.png#w=40&a=l' }, { id: 'b3', kind: 'table', text: 'Tétel | Összeg\nLakbér | 5\n#w=40&a=l' }] }])
    expect(u.map((x) => [x.id, x.text])).toEqual([['s1', 'Tényállás'], ['b1', 'Szöveg.'], ['b3', 'Tétel']])
  })
  it('the program\'s placeholder chapter title is not a title on the page', () => {
    const u = pageUnitsOf([{ id: 's1', title: 'Új fejezet', blocks: [{ id: 'b1', kind: 'paragraph', text: 'Szöveg.' }] }])
    expect(u.map((x) => x.id)).toEqual(['b1'])
  })
})

describe('the editor', () => {
  it('draws the line on the read-only Preview sheet too, not only on the editable page', () => {
    expect(js).toContain('function dpPagesRoot()')
    expect(js).toMatch(/function dpPagesRoot\(\) \{[^}]*querySelector\('\.wb-dp-page'\)/)
    expect(js).toMatch(/function dpPagesPaint\(\) \{\s*var page = dpPagesRoot\(\)/)
    expect(js).toContain('!dpPagesRoot() || dpIsVariant()')
  })

  it('has the toggle in the ribbon, asks the server, and paints the line into the page after every redraw', () => {
    expect(js).toContain('data-wb-act="dp-pages-toggle"')
    expect(js).toContain("a === 'dp-pages-toggle'")
    expect(js).toContain("/outline/pagebreaks?lang=")
    expect(js).toContain('dpPagesAfterRender()')
    expect(js).toContain('dpPagesSoon() // the lines of the PDF')
    expect(css).toContain('.wb-dp-pagebreak')
  })

  it('is on by default for every document, and the break is a grey band between two white sheets', () => {
    expect(js).toContain("readPref('marveen.workbench.dpSheets', '') !== '0'")
    expect(css).toMatch(/\.wb-dp-pagebreak \{[^}]*margin: var\(--pg-pb\) calc\(-1 \* var\(--pg-pr\)\)/)
    expect(css).toContain('--pg-pl: 72px')
  })
})
