import { describe, expect, it } from 'vitest'
import { FIT_BODY_PT, FIT_MAX_LEVEL, tightenOutline } from '../workbench-docfit.js'
import { buildFodt, type RenderOutline } from '../workbench-docrender.js'

const BL = '​'
const p = (text: string) => ({ kind: 'paragraph' as const, text })
const outline = (): RenderOutline => ({ sections: [{ title: 'T', status: 'done', blocks: [p('Ein Text.'), p(BL), p(BL), p(BL), p(BL), p('Mit freundlichen Grüßen'), p(BL), p('Name')] }] })
const texts = (o: RenderOutline) => o.sections[0]!.blocks.map((b) => b.text)

describe('a language version is drawn tighter to fit the original page count (#856)', () => {
  it('step 0 changes nothing', () => {
    const o = outline()
    expect(tightenOutline(o, 0)).toBe(o)
  })

  it('step 1 cuts runs of more than two blank lines to two, and keeps a single mandatory blank line', () => {
    const t = texts(tightenOutline(outline(), 1))
    expect(t).toEqual(['Ein Text.', BL, BL, 'Mit freundlichen Grüßen', BL, 'Name'])
  })

  it('step 2 draws the blank lines at half height; the text of the blocks is never changed', () => {
    const t = tightenOutline(outline(), 2)
    const blanks = t.sections[0]!.blocks.filter((b) => b.text === BL)
    expect(blanks.length).toBe(3)
    expect(blanks.every((b) => b.pfmt?.ls === 0.5)).toBe(true)
    expect(t.sections[0]!.blocks.filter((b) => b.text !== BL).every((b) => !b.pfmt)).toBe(true)
  })

  it('steps 3 to 5 make the body font smaller, step by step, never below 10.5 pt', () => {
    expect([3, 4, 5].map((l) => tightenOutline(outline(), l).bodyPt)).toEqual([11.5, 11, 10.5])
    expect(Math.min(...Object.values(FIT_BODY_PT))).toBe(10.5)
    expect(FIT_MAX_LEVEL).toBe(5)
    expect(tightenOutline(outline(), 2).bodyPt).toBeUndefined()
  })

  it('the font size reaches the document: 12 pt by default, the step size when tightened', () => {
    const o = { ...outline(), bodyPt: 11 }
    const meta = { title: 't', author: 'a', draft: false, lang: 'de' } as never
    expect(buildFodt(o, meta)).toContain('fo:font-size="11pt"')
    expect(buildFodt(outline(), meta)).toContain('fo:font-size="12pt" fo:language')
    expect(buildFodt({ ...outline(), bodyPt: 40 }, meta)).toContain('fo:font-size="12pt" fo:language')
  })
})
