import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Boss (TG 4778): the original page and its translation must use the SAME margins (left, right, top, bottom)
// and the same width, otherwise the lines break in different places and the two pages drift apart.
const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

function rule(selectorStart: string): string {
  const line = css.split('\n').find((l) => l.startsWith(selectorStart))
  if (!line) throw new Error('rule not found: ' + selectorStart)
  return line
}
const vars = (l: string) => ['--pg-pt', '--pg-pr', '--pg-pb', '--pg-pl'].map((v) => (l.match(new RegExp(v + ':\\s*([^;]+);')) || [])[1])

describe('translation page keeps the margins of the original page', () => {
  const dp = rule('.wb-dp-page {')
  const tw = rule('.wb-tw-page {')
  it('same four margins as the original page', () => {
    expect(vars(tw)).toEqual(vars(dp))
    expect(vars(tw).every(Boolean)).toBe(true)
  })
  it('padding comes from those margins and the width is the same', () => {
    expect(tw).toContain('padding: var(--pg-pt) var(--pg-pr) var(--pg-pb) var(--pg-pl)')
    expect(tw).toContain('width: min(100%, 794px)')
    expect(dp).toContain('width: min(100%, 794px)')
  })
  it('with the side panel open the original and translation columns are equally wide', () => {
    const l = rule('.wb-tw-cols.has-both')
    const cols = (l.match(/minmax\(0, ([\d.]+)fr\)/g) || []).map((x) => x.replace(/\D*([\d.]+)fr.*/, '$1'))
    expect(cols[0]).toBe(cols[1])
  })
  it('the narrow-screen override changes both pages together', () => {
    expect(css).toMatch(/\.wb-dp-page, \.wb-tw-page \{ --pg-pt: 28px;/)
  })
})
