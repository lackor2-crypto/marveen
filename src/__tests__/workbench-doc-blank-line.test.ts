// #565 (the owner, TG 8971: "ures sorokat nem tur meg a lapon"): an empty line made with Enter is a paragraph of its own.
// It is stored as one invisible character (the model never holds an empty text), and prints as an empty paragraph.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BLANK_LINE, isBlankLine } from '../workbench-docmodel.js'
import { buildFodt, type RenderOutline } from '../workbench-docrender.js'

describe('an empty line stays (#565)', () => {
  it('the marker survives trim(), and only the marker counts as an empty line', () => {
    expect(BLANK_LINE.trim()).toBe(BLANK_LINE)
    expect(isBlankLine(BLANK_LINE)).toBe(true)
    expect(isBlankLine(BLANK_LINE + BLANK_LINE)).toBe(true)
    expect(isBlankLine('')).toBe(false)
    expect(isBlankLine('a')).toBe(false)
    expect(isBlankLine(`a${BLANK_LINE}`)).toBe(false)
  })

  it('the PDF / Word source keeps each empty line as an empty paragraph, in its place', () => {
    const o = { sections: [{ title: 'Új fejezet', status: 'draft', blocks: [
      { kind: 'paragraph', text: 'Első' },
      { kind: 'paragraph', text: BLANK_LINE },
      { kind: 'paragraph', text: BLANK_LINE },
      { kind: 'paragraph', text: 'Aláírás:' },
    ] }] } as unknown as RenderOutline
    const x = buildFodt(o, { title: 'T', author: null, draft: true, lang: 'hu' })
    const body = x.slice(x.indexOf('<office:text'))
    expect(body).toMatch(/Első<\/text:p>\s*<text:p text:style-name="Body"><\/text:p>\s*<text:p text:style-name="Body"><\/text:p>\s*<text:p text:style-name="Body">Aláírás:<\/text:p>/)
    expect(body).not.toContain(BLANK_LINE)
  })

  it('the page saves an empty line of the owner and still skips the line the program only offers', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
    expect(src).toMatch(/if \(k !== 'block'\) continue\s*\n\s*text = DP_BLANK/)
    expect(src).toMatch(/dpIsBlank\(b\.text\) \? '' : b\.text/)
  })

  it('a translation carries an empty line over untouched', () => {
    const src = readFileSync(join(__dirname, '..', 'workbench-doclang-translate.ts'), 'utf-8')
    expect(src).toMatch(/if \(isBlankLine\(s\.text\)\) return \{ kind: s\.kind, text: s\.text, claims: \[\] \}/)
  })
})
