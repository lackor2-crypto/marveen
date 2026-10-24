// #782: a Word list read onto the page keeps the bold / italic of its items, and an inner list stays an inner list (its
// items are numbered on their own, one level deeper) -- on the page, in the PDF and in the Word copy alike.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseWordHtml } from '../workbench-worddoc.js'
import { richMatches } from '../workbench-docrich.js'
import { buildFodt, renderOutlinePdf, type RenderOutline } from '../workbench-docrender.js'

const outline = (text: string, rich?: string): RenderOutline => ({ sections: [{ title: 'Kérelem', status: 'draft', blocks: [{ kind: 'list', text, rich: rich ?? null }] }] }) as unknown as RenderOutline
const body = (x: string): string => x.slice(x.indexOf('<office:text'))

describe('#782 Word lists: formatting and inner lists', () => {
  it('an inner numbered list is numbered on its own, one level deeper; the formatting of the items stays', () => {
    const p = parseWordHtml('<body><h1>K</h1><ol><li><p><b>Első</b> pont</p><ol><li><p>al<i>pont</i></p></li><li><p>másik</p></li></ol></li>'
      + '<li><p>Második</p></li></ol></body>')
    const b = p.sections[0]?.blocks[0]
    expect(b?.kind).toBe('list')
    expect(b?.text).toBe('1. Első pont\n  1. alpont\n  2. másik\n2. Második')
    expect(b?.rich).toContain('<b>Első</b>')
    expect(b?.rich).toContain('<i>pont</i>')
    expect(richMatches(b?.rich, b?.text as string)).toBe(true)
  })

  it('a bullet list inside a numbered one: the bullets are not numbered, the outer items keep 1., 2.', () => {
    const p = parseWordHtml('<body><ol><li>A<ul><li>a1</li><li>a2</li></ul></li><li>B</li></ol></body>')
    expect(p.sections[0]?.blocks[0]?.text).toBe('1. A\n  a1\n  a2\n2. B')
    expect(p.sections[0]?.blocks[0]?.rich).toBeUndefined()
  })

  it('a plain flat list is unchanged (no formatting stored)', () => {
    const p = parseWordHtml('<body><ol><li>egy</li><li>kettő</li></ol><ul><li>a</li><li>b</li></ul></body>')
    expect(p.sections[0]?.blocks.map((x) => [x.text, x.rich])).toEqual([['1. egy\n2. kettő', undefined], ['a\nb', undefined]])
  })

  it('the PDF draws the inner list inside its item, numbered on its own, with the bold and italic runs', () => {
    const p = parseWordHtml('<body><ol><li><p><b>Első</b> pont</p><ol><li><p>al<i>pont</i></p></li></ol></li><li><p>Második</p></li></ol></body>')
    const blk = p.sections[0]?.blocks[0] as { text: string; rich?: string }
    const x = body(buildFodt(outline(blk.text, blk.rich), { title: 'T', author: null, draft: false, lang: 'hu' }))
    // outer numbered list, the first item holds the inner (numbered) list, then the second item
    expect(x).toMatch(/<text:list text:style-name="LNum"><text:list-item><text:p text:style-name="ListP"><text:span text:style-name="FmtB">Első<\/text:span> pont<\/text:p><text:list text:style-name="LNum"><text:list-item><text:p text:style-name="ListP">al<text:span text:style-name="FmtI">pont<\/text:span><\/text:p><\/text:list-item><\/text:list><\/text:list-item><text:list-item><text:p text:style-name="ListP">Második<\/text:p><\/text:list-item><\/text:list>/)
    // the numbers come from the list style, not twice from the text
    expect(x).not.toContain('1. ')
  })

  it('a bullet inner list under numbered items is a bullet list; the list styles have the deeper levels', () => {
    const full = buildFodt(outline('1. A\n  a1\n  a2\n2. B'), { title: 'T', author: null, draft: false, lang: 'hu' })
    expect(body(full)).toContain('<text:p text:style-name="ListP">A</text:p><text:list text:style-name="LBul"><text:list-item><text:p text:style-name="ListP">a1</text:p></text:list-item><text:list-item><text:p text:style-name="ListP">a2</text:p></text:list-item></text:list></text:list-item>')
    expect(full).toMatch(/<text:list-style style:name="LBul">.*text:level="2".*text:level="3".*<\/text:list-style>/)
    expect(full).toMatch(/<text:list-style style:name="LNum">.*text:level="2".*text:level="3".*<\/text:list-style>/)
  })

  it('a flat list renders as before (one list, no inner lists)', () => {
    const x = body(buildFodt(outline('1. egy\n2. kettő'), { title: 'T', author: null, draft: false, lang: 'hu' }))
    expect(x).toContain('<text:list text:style-name="LNum"><text:list-item><text:p text:style-name="ListP">egy</text:p></text:list-item><text:list-item><text:p text:style-name="ListP">kettő</text:p></text:list-item></text:list>')
  })

  it('the real PDF (LibreOffice): outer 1. 2., the inner list its own 1. 2., one level deeper', async () => {
    const r = await renderOutlinePdf(outline('1. Első pont\n  1. alpont\n  2. másik\n2. Második', '1. <b>Első</b> pont<br>  1. al<i>pont</i><br>  2. másik<br>2. Második'), { title: 'T', author: null, draft: false, lang: 'hu' })
    if (!r.ok) throw new Error(`render: ${r.code} ${r.detail ?? ''}`)
    const txt = execFileSync('pdftotext', ['-layout', '-', '-'], { input: r.pdf }).toString('utf-8')
    const lines = txt.split('\n').filter((l) => /pont|másik|Második/.test(l))
    expect(lines.map((l) => l.trim().replace(/\s+/g, ' '))).toEqual(['1. Első pont', '1. alpont', '2. másik', '2. Második'])
    const col = (s: string): number => (lines.find((l) => l.includes(s)) as string).search(/\d/)
    expect(col('alpont')).toBeGreaterThan(col('Első'))
    expect(col('Második')).toBe(col('Első'))
  }, 120_000)

  it('the page draws an inner line further right and gives a numbered line no bullet (source)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')
    const at = src.indexOf('function dpListLinesHtml(html) {')
    let depth = 0
    let end = at
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    // eslint-disable-next-line no-new-func
    const f = new Function(src.slice(at, end) + '\nreturn dpListLinesHtml')() as (h: string) => string | null
    expect(f('1. <b>A</b>\n  a1\n2. B')).toBe('<div class="wb-dp-li wb-dp-li-num">1. <b>A</b></div>'
      + '<div class="wb-dp-li" data-lvl="1">  a1</div><div class="wb-dp-li wb-dp-li-num">2. B</div>')
    expect(css).toContain('.wb-dp-block.wb-dp-lines .wb-dp-li[data-lvl="1"] { margin-left: 18px; }')
    expect(css).toContain('.wb-dp-block.wb-dp-lines .wb-dp-li.wb-dp-li-num::before { content: none; }')
  })
})
