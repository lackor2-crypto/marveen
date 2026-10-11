// #567 (Boss TG 8988: page numbers "alul kozepre, ilyen birosagi iratoknal oda szoktak tenni"): the page number stands
// at the bottom centre of EVERY page, in the draft, in the final PDF and in the Word file, also on a one-page letter.
// Measured 2026-10-11 on a 10-page document: draft "PISZKOZAT · n / 10 oldal", final "n / 10 oldal", Word footer
// PAGE / NUMPAGES centred -- so this pins what the pipeline already does, per language.
import { describe, it, expect } from 'vitest'
import { buildFodt } from '../workbench-docrender.js'

const doc = { sections: [{ title: '1.', status: 'done', blocks: [{ kind: 'paragraph', text: 'Szoveg.' }] }] } as never
const make = (draft: boolean, lang: 'hu' | 'en' | 'de', target?: 'docx'): string => buildFodt(doc, { title: 'T', author: null, draft, lang, ...(target ? { target } : {}) } as never)

describe('page number: bottom centre, every page', () => {
  it('the footer style is centred, and both master pages (first and following) carry the number and the page count', () => {
    for (const draft of [true, false]) {
      const x = make(draft, 'hu')
      expect(x).toMatch(/style:name="Footer" style:family="paragraph"[^>]*><style:paragraph-properties fo:text-align="center"\/>/)
      const masters = x.match(/<style:master-page [\s\S]*?<\/style:master-page>/g) || []
      expect(masters.length).toBe(2)
      for (const m of masters) {
        expect(m).toContain('<text:page-number text:select-page="current"/>')
        expect(m).toContain('<text:page-count/>')
        expect(m).toContain('<text:p text:style-name="Footer">')
      }
    }
  })
  it('the draft keeps its mark beside the number, the final and the Word file carry the number alone', () => {
    expect(make(true, 'hu')).toContain('PISZKOZAT · <text:page-number')
    expect(make(false, 'hu')).not.toContain('PISZKOZAT · <text:page-number')
    expect(make(false, 'hu', 'docx')).toContain('<text:p text:style-name="Footer"><text:page-number')
  })
  it('the wording follows the document language', () => {
    expect(make(false, 'hu')).toMatch(/page-count\/> oldal/)
    expect(make(false, 'en')).toMatch(/Page <text:page-number[^>]*\/> of <text:page-count\/>/)
    expect(make(false, 'de')).toMatch(/Seite <text:page-number[^>]*\/> von <text:page-count\/>/)
  })
})
