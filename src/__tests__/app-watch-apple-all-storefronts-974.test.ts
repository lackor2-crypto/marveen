// Boss TG 7438: the Apple watcher showed 0 ratings for ever. The /de/ page only counts the German storefront; the
// US storefront of the same app had 15 (measured 2026-11-22 through Apple's lookup endpoint). The total must sum
// every storefront.
import { describe, it, expect } from 'vitest'
import { APPLE_STOREFRONTS, appleAppId, parseAppleLookup, checkOne, describeReading } from '../app-page-watch.js'

const PAGE_DE = '<script>{"ratingCounts":[0,0,0,0,0]}</script>'
const lookup = (n: number | null) => JSON.stringify({ resultCount: n === null ? 0 : 1, results: n === null ? [] : [{ userRatingCount: n }] })

describe('Apple ratings sum over every storefront', () => {
  it('reads the app id from the page address', () => {
    expect(appleAppId('https://apps.apple.com/de/app/kansas-city-taxi-freeber-app/id6499212927?l=en-GB')).toBe('6499212927')
    expect(appleAppId('https://apps.apple.com/de/app/x')).toBeNull()
  })
  it('parses a lookup answer; an absent app is null, a zero is zero', () => {
    expect(parseAppleLookup(lookup(15))).toBe(15)
    expect(parseAppleLookup(lookup(0))).toBe(0)
    expect(parseAppleLookup(lookup(null))).toBeNull()
    expect(parseAppleLookup('not json')).toBeNull()
  })
  it('the German page says 0 but the US storefront has 15: the watcher reports 15 with the split', async () => {
    const fetcher = async (url: string): Promise<string> => {
      if (url.startsWith('https://itunes.apple.com/lookup')) return lookup(url.endsWith('country=us') ? 15 : url.endsWith('country=gb') ? 2 : 0)
      return PAGE_DE
    }
    const page = { id: 'a', label: 'p', url: 'https://apps.apple.com/de/app/kansas-city-taxi-freeber-app/id6499212927?l=en-GB' }
    const { result, state } = await checkOne(page, undefined, fetcher)
    expect(result.ok).toBe(true)
    expect(state.value).toBe(17)
    expect(state.detail).toBe('US 15, GB 2')
    expect(describeReading('apple', state.value, '', 'hu')).toBe('17 értékelés')
  })
  it('when no storefront answers, it falls back to the page own number (never invents one)', async () => {
    const fetcher = async (url: string): Promise<string> => { if (url.includes('itunes.apple.com')) throw new Error('down'); return PAGE_DE }
    const page = { id: 'a', label: 'p', url: 'https://apps.apple.com/de/app/x/id6499212927' }
    const { state } = await checkOne(page, undefined, fetcher)
    expect(state.value).toBe(0)
    expect(state.detail).toBe('')
  })
  it('the storefront list is not tiny', () => { expect(APPLE_STOREFRONTS.length).toBeGreaterThan(150); expect(APPLE_STOREFRONTS).toContain('us') })
})

describe('the language files still parse (an apostrophe in a single-quoted text broke en.js once)', () => {
  it.each(['hu', 'en'])('web/lang/%s.js is valid JavaScript', async (l) => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL(`../../web/lang/${l}.js`, import.meta.url), 'utf8')
    // eslint-disable-next-line no-new-func
    expect(() => new Function('window', src)).not.toThrow()
  })
})
