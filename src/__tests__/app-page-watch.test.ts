// #764: the app-page watcher. The page snippets below are cut from real public pages (measured
// 2026-10-24); only the data-carrying parts are kept.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parsePlayPage, parseApplePage, validateWatchUrl, checkOne, runWatch, readWatchFile, writeWatchFile, describeReading,
} from '../app-page-watch.js'

const PLAY = (band: string, exact: number) =>
  `<div class="ClM7O">${band}</div><div class="g1rdde">Downloads</div> ...,null,null,["${band}",100,${exact},"${band}"],null,null`
const APPLE = (c: number[]) => `..."ratingAverage":0,"ratingCounts":[${c.join(',')}],"x":1 ... "ratingCount":"0"`

describe('page parsers', () => {
  it('Google Play: reads the band and the more exact number', () => {
    expect(parsePlayPage(PLAY('100+', 117))).toEqual({ kind: 'play', band: '100+', value: 117 })
    expect(parsePlayPage(PLAY('1K+', 1234))).toEqual({ kind: 'play', band: '1K+', value: 1234 })
  })
  it('Google Play: falls back to the band minimum when only the visible band is there', () => {
    expect(parsePlayPage('<div class="ClM7O">5K+</div><div class="g1rdde">Downloads</div>')).toEqual({ kind: 'play', band: '5K+', value: 5000 })
  })
  it('Google Play: an unrecognizable page is null, never zero', () => {
    expect(parsePlayPage('<html>consent wall</html>')).toBeNull()
  })
  it('Apple: sums the star counts; no ratings is a real 0', () => {
    expect(parseApplePage(APPLE([0, 0, 0, 0, 0]))).toEqual({ kind: 'apple', band: '', value: 0 })
    expect(parseApplePage(APPLE([1, 0, 2, 3, 4]))).toEqual({ kind: 'apple', band: '', value: 10 })
    expect(parseApplePage('<html></html>')).toBeNull()
  })
})

describe('address check', () => {
  it('accepts only https Play / App Store pages', () => {
    expect(validateWatchUrl('https://play.google.com/store/apps/details?id=a.b').ok).toBe(true)
    expect(validateWatchUrl('https://apps.apple.com/de/app/x/id1').ok).toBe(true)
    for (const bad of ['http://play.google.com/x', 'https://example.com/', 'https://play.google.com.evil.com/', 'nonsense', '']) {
      const r = validateWatchUrl(bad)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) { expect(r.hu.length).toBeGreaterThan(5); expect(r.en.length).toBeGreaterThan(5) }
    }
  })
})

describe('checkOne / runWatch', () => {
  let dir: string
  let file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'appwatch-')); file = join(dir, 'w.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const page = { id: 'p1', label: 'Rider', url: 'https://play.google.com/store/apps/details?id=a.b' }

  it('the first reading only sets the baseline, a rise later is reported', async () => {
    const first = await checkOne(page, undefined, async () => PLAY('100+', 117))
    expect(first.result).toMatchObject({ ok: true, previous: null, current: 117, increased: false })
    const same = await checkOne(page, first.state, async () => PLAY('100+', 117))
    expect(same.result.increased).toBe(false)
    const up = await checkOne(page, same.state, async () => PLAY('500+', 540))
    expect(up.result).toMatchObject({ increased: true, previous: 117, current: 540, band: '500+' })
  })

  it('a falling number is not reported', async () => {
    const a = await checkOne(page, undefined, async () => PLAY('100+', 300))
    const b = await checkOne(page, a.state, async () => PLAY('100+', 250))
    expect(b.result.increased).toBe(false)
  })

  it('a failed fetch keeps the last good value and carries the real error text', async () => {
    const a = await checkOne(page, undefined, async () => PLAY('100+', 117))
    const b = await checkOne(page, a.state, async () => { throw new Error('HTTP 503') })
    expect(b.result).toMatchObject({ ok: false, error: 'HTTP 503', current: 117 })
    expect(b.state.value).toBe(117)
    expect(b.state.error).toBe('HTTP 503')
    const c = await checkOne(page, b.state, async () => PLAY('100+', 117))
    expect(c.state.error).toBe('')
  })

  it('an unrecognizable page is an error, not a zero', async () => {
    const r = await checkOne(page, undefined, async () => '<html>consent</html>')
    expect(r.result.ok).toBe(false)
    expect(r.state.value).toBeNull()
  })

  it('runWatch persists state and notifies once, in the owner language, only on a rise', async () => {
    writeWatchFile({ pages: [page], state: {} }, file)
    const sent: string[] = []
    let html = PLAY('100+', 117)
    const run = (lang: 'hu' | 'en') => runWatch({ file, fetcher: async () => html, notify: async (t) => { sent.push(t) }, lang })
    await run('hu')
    expect(sent).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf-8')).state.p1.value).toBe(117)
    html = PLAY('500+', 540)
    await run('hu')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Letöltés-figyelő')
    expect(sent[0]).toContain('117 letöltés')
    expect(sent[0]).toContain('540 letöltés')
    html = PLAY('1K+', 1100)
    await run('en')
    expect(sent[1]).toContain('Download watcher')
    expect(sent[1]).toContain('1100 downloads')
    expect(readWatchFile(file).state.p1.value).toBe(1100)
  })

  it('describeReading never shows a missing reading as 0', () => {
    expect(describeReading('play', null, '', 'hu')).toBe('még nincs mérés')
    expect(describeReading('apple', 0, '', 'en')).toBe('0 ratings')
  })
})
