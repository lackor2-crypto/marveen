import { describe, expect, it } from 'vitest'
import { buildHimalayaSearchArgs, foldDiacritics, normalizeEmailSearchQuery } from '../web/email-search.js'

describe('email search', () => {
  it('trims and bounds user queries', () => {
    expect(normalizeEmailSearchQuery('  invoice  ')).toBe('invoice')
    expect(normalizeEmailSearchQuery('x'.repeat(250))).toHaveLength(200)
    expect(normalizeEmailSearchQuery(null)).toBe('')
  })

  it('passes user text as quoted DSL values instead of operators', () => {
    const query = 'invoice" or flag seen'
    const args = buildHimalayaSearchArgs(query)
    const quoted = JSON.stringify(query)

    expect(args).toEqual([
      'from', quoted,
      'or', 'to', quoted,
      'or', 'subject', quoted,
      'or', 'body', quoted,
      'order', 'by', 'date', 'desc',
    ])
  })

  it('strips diacritics so accented and plain queries match the same word', () => {
    expect(foldDiacritics('videó')).toBe('video')
    expect(foldDiacritics('Toyota Corolla')).toBe('Toyota Corolla')
    expect(foldDiacritics('árvíztűrő tükörfúrógép')).toBe('arvizturo tukorfurogep')
  })

  it('folds diacritics before quoting the himalaya search pattern', () => {
    const args = buildHimalayaSearchArgs('videó')
    const quoted = JSON.stringify('video')
    expect(args).toEqual([
      'from', quoted,
      'or', 'to', quoted,
      'or', 'subject', quoted,
      'or', 'body', quoted,
      'order', 'by', 'date', 'desc',
    ])
  })
})
