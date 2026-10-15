import { describe, expect, it } from 'vitest'
import { sourceForTranslated } from '../workbench-doclang.js'

const j = (text: string) => ({ kind: 'paragraph', text, rich: null, align: 'j', pfmt: null })

describe('sourceForTranslated', () => {
  it('pairs by position when the counts match', () => {
    const src = [j('a'), { ...j('b'), align: 'c' }]
    expect(sourceForTranslated(src, 1, 'paragraph', 2)?.align).toBe('c')
  })
  it('carries a uniform alignment when the counts differ (Boss TG 3473)', () => {
    const src = [j('a'), j('b'), j('c')]
    expect(sourceForTranslated(src, 0, 'paragraph', 5)?.align).toBe('j')
    expect(sourceForTranslated(src, 4, 'paragraph', 5)?.align).toBe('j')
  })
  it('never guesses when the source alignments differ', () => {
    const src = [j('a'), { ...j('b'), align: 'c' }]
    expect(sourceForTranslated(src, 0, 'paragraph', 3)).toBeNull()
  })
  it('does not paint a picture or a table', () => {
    expect(sourceForTranslated([j('a')], 0, 'image', 2)).toBeNull()
  })
  it('carries nothing when the source has no look', () => {
    expect(sourceForTranslated([{ ...j('a'), align: null }], 0, 'paragraph', 2)).toBeNull()
  })
})
