import { describe, expect, it } from 'vitest'
import { buildFodt, closingKeepIndexes, type RenderOutline } from '../workbench-docrender.js'

const LONG = 'Ich bitte Sie, sich schriftlich zu den folgenden Punkten zu äußern und entsprechend tätig zu werden, damit es geklärt wird.'
const BL = '​'
const p = (text: string) => ({ kind: 'paragraph' as const, text })

describe('the closing of a letter stays with the body paragraph before it (#856)', () => {
  it('keeps the last long paragraph, the blank lines and the closing together, not the last block', () => {
    const blocks = [p(LONG), p(LONG), p('Mit freundlichen Grüßen'), p(BL), p(BL), p('Korpás László')]
    expect([...closingKeepIndexes(blocks)]).toEqual([1, 2, 3, 4])
  })

  it('skips a signature picture in the tail without breaking the chain', () => {
    const blocks = [p(LONG), p('Mit freundlichen Grüßen'), p(BL), { kind: 'image' as const, text: 'a.png#w=30' }, p(BL), p('Korpás László')]
    expect([...closingKeepIndexes(blocks)]).toEqual([0, 1, 2, 3, 4])
  })

  it('does nothing when the end is not a short closing (a long last paragraph, a table, a list)', () => {
    expect(closingKeepIndexes([p(LONG), p(LONG)]).size).toBe(0)
    expect(closingKeepIndexes([p(LONG), p('Kurz'), { kind: 'table' as const, text: 'a|b' }]).size).toBe(0)
    expect(closingKeepIndexes([p(LONG), p('Kurz'), { kind: 'list' as const, text: 'x' }]).size).toBe(0)
    expect(closingKeepIndexes([p('Kurz'), p('Korpás')]).size).toBe(0)
  })

  it('writes keep-with-next into the document only for the last section', () => {
    const outline: RenderOutline = {
      sections: [
        { title: 'Antrag', status: 'done', blocks: [p(LONG), p('Mit freundlichen Grüßen'), p(BL), p('Korpás László')] },
      ],
    }
    const fodt = buildFodt(outline, { title: 't', author: 'a', draft: false, lang: 'de' } as never)
    expect(fodt).toContain('fo:keep-with-next="always"')
    const none = buildFodt({ sections: [{ title: 'x', status: 'done', blocks: [p(LONG), p(LONG)] }] }, { title: 't', author: 'a', draft: false, lang: 'de' } as never)
    expect(none.match(/p\|Body\|/g) ?? []).toEqual([])
  })
})
