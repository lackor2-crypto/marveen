// #564 (Boss TG 8950 / 8952 / 8958): the Style box (Heading 1 / 2 / 3, Normal) reaches EVERY selected paragraph and every
// chapter title inside the selection, a long paragraph made Heading 1 loses nothing, and the two spacing lists name what
// they set. The selection itself needs a real browser (measured in Chromium, undo / redo included); this runs the pure
// title split and pins the wiring so the one-paragraph behaviour cannot silently come back.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchHarness } from './helpers/workbench-harness.js'

const root = join(__dirname, '..', '..', 'web')
const src = readFileSync(join(root, 'workbench.js'), 'utf8')
const hu = readFileSync(join(root, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(root, 'lang', 'en.js'), 'utf8')

describe('Style on the whole selection (#564)', () => {
  const split = (text: string) => workbenchHarness().win.MarvinWorkbench._dp.splitTitle(text) as { title: string; rest: string }

  it('a short paragraph becomes the whole title, nothing is left over', () => {
    expect(split('  Rövid bekezdés  ')).toEqual({ title: 'Rövid bekezdés', rest: '' })
  })

  it('a paragraph of exactly 200 characters is not split', () => {
    const t = 'a'.repeat(200)
    expect(split(t)).toEqual({ title: t, rest: '' })
  })

  it('a 342-character paragraph: the title ends at a whole word, the rest is kept, no character is lost', () => {
    const words = Array.from({ length: 60 }, (_, i) => 'szo' + i)
    const text = words.join(' ').slice(0, 342)
    const r = split(text)
    expect(r.title.length).toBeLessThanOrEqual(200)
    expect(r.rest.length).toBeGreaterThan(0)
    expect(text.startsWith(r.title)).toBe(true)
    expect(text.endsWith(r.rest)).toBe(true)
    expect(r.title + ' ' + r.rest).toBe(text)
  })

  it('one endless word is cut at 200 and the remainder is still kept', () => {
    const t = 'x'.repeat(342)
    const r = split(t)
    expect(r.title.length).toBe(200)
    expect(r.title + r.rest).toBe(t)
  })

  it('line breaks inside the paragraph become spaces in the title', () => {
    expect(split('első\nmásodik').title).toBe('első második')
  })

  it('the Style box goes through every selected paragraph and title, not only the one the selection started in', () => {
    expect(src).toMatch(/else if \(k === 'heading'\) dpHeadingEls\(el\)\.forEach\(function \(x\) \{ dpSetPfmt\(x, \{ h: Number\(v\) \|\| null \}\) \}\)/)
    expect(src).not.toMatch(/else if \(k === 'heading'\) dpSetPfmt\(el,/)
    // a selection over several paragraphs does not take the single-title shortcut
    expect(src).toMatch(/curTitle\.getAttribute\('data-wb-dp'\) === 'sec' && !\(WB\.dpRange && WB\.dpRange\.multi && dpHeadingEls\(curTitle\)\.length > 1\)/)
  })

  it('the title split is used by the Heading 1 conversion', () => {
    expect(src).toContain('var hSplit = dpSplitTitle(text)')
    expect(src).not.toMatch(/\.slice\(0, 200\), n\)/)
  })

  it('both spacing lists name what they set (HU + EN)', () => {
    expect(src).toContain("t('workbench.dp.fmt_linesp_opt'")
    expect(src).toContain("t('workbench.dp.fmt_spaceafter_opt'")
    expect(hu).toContain('"workbench.dp.fmt_linesp_opt": "Sortávolság: {v}"')
    expect(hu).toContain('"workbench.dp.fmt_spaceafter_opt": "Bekezdés után: {v} pt"')
    expect(en).toContain('"workbench.dp.fmt_linesp_opt": "Line spacing: {v}"')
    expect(en).toContain('"workbench.dp.fmt_spaceafter_opt": "After paragraph: {v} pt"')
  })
})
