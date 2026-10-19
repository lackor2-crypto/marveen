// #711: after a size of 36 pt was set, no other size could be set. The behaviour needs a real browser (execCommand); it
// was measured in Chromium: with the old code, bold text (<b style="font-size: xxx-large">) stayed xxx-large for every
// size; with the fix 12 / 36 / 24 / 8 / 14 / 10 pt apply in any order, plain and bold, and "no size" clears it. This
// pins the wiring so the marker steps cannot silently go back.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('font size can be changed again after 36 pt (#711)', () => {
  it('the size marker goes through size 1 first, so text that is already 36 pt still changes', () => {
    expect(src).toMatch(/function dpMarkSize\(\) \{\s*document\.execCommand\('fontSize', false, '1'\)\s*document\.execCommand\('fontSize', false, '7'\)\s*\}/)
  })

  it('both applying and clearing a size use the marker helper', () => {
    expect(src).toMatch(/else if \(kind === 'size'\) dpMarkSize\(\)/)
    expect(src).toMatch(/else if \(kind === 'size'\) \{\s*dpMarkSize\(\)/)
  })

  it('the marker is found and stripped on any element (e.g. <b>), not only on span / font', () => {
    expect(src).toContain("querySelectorAll('[style],font')")
    expect(src).toContain("querySelectorAll('[style*=\"xxx-large\"], font[size=\"7\"]')")
    expect(src).toMatch(/!\/\^\(SPAN\|FONT\)\$\/\.test\(b\.tagName\)/)
  })
})
