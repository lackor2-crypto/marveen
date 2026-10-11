// #551 (Boss TG 8697): a name in a Workbench list must never shrink to three dots. MEASURED in Chromium: at
// 390px a depth-8 row left the title 17px wide and 330px tall. This pins the CSS rules that guarantee it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')
const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('a list name never runs out (#551)', () => {
  it('every depth indent is capped relative to the list width', () => {
    for (let n = 1; n <= 8; n++) {
      expect(css).toMatch(new RegExp('\\.wb-depth-' + n + ' \\{ margin-left: min\\(' + 18 * n + 'px, ' + 4 * n + '%\\); \\}'))
    }
  })

  it('the title keeps a non-zero minimum width and nothing resets it to 0', () => {
    // #555: basis auto (the name itself), not 8ch -- see the pin in the #555 block below
    expect(css).toMatch(/\.wb-item-title \{ flex: 1 1 auto; min-width: min\(100%, 8ch\); \}/)
    for (const m of css.matchAll(/([^{}]*\.wb-item-title[^{}]*)\{([^}]*)\}/g)) {
      expect(m[2]).not.toMatch(/min-width:\s*0\b/)
    }
  })

  it('the row button and the type line wrap instead of squeezing the name', () => {
    expect(css).toMatch(/\.wb-item \{ flex-wrap: wrap; \}/)
    // #555: basis 0 (not auto), so the button stays BESIDE the star / the tick box instead of dropping under them
    expect(css).toMatch(/\.wb-item-row \.wb-item \{ flex: 1 1 0; min-width: min\(100%, 9rem\); \}/)
    expect(css).toMatch(/\.wb-fr-panel \.wb-item-row \.wb-item \{ order: 0; flex: 1 1 0; min-width: min\(100%, 9rem\);/)
    expect(css).toMatch(/\.wb-fr-panel \.wb-item-row \{ flex-wrap: wrap;/)
    expect(css).not.toMatch(/\.wb-fr-panel \.wb-item-row \.wb-item \{[^}]*min-width: 0;/)
  })

  it('the full name is the row button\'s tooltip (work items and loose files)', () => {
    expect(js).toMatch(/\(it\.source_path \? baseOf\(it\.source_path\) : it\.title\) \+ \(archived\(\)/)
    expect(js).toContain("escA(f.name + ' \\u2014 ' + t('workbench.file.open'))")
  })

  // #555 (Boss TG 8738): MEASURED in Chromium -- in the frame's panel the row button is a column, so the title's
  // `flex: 1 1 8ch` became a height: a row named "Rovid" was 69px tall (title 51px). Now 32px; a long name 60px (3 lines).
  // #555 (phone width, measured in Chromium at 390px): with basis 8ch a name that did not fit beside the type line was
  // squeezed to a 63px column (a short name two lines tall, a long one three lines of ~8 characters). Basis auto: the
  // type line drops under the name, and the name uses the whole row width, at most three lines.
  it('#555: the row list title has the name itself as its basis, so the type line wraps under it instead of squeezing it', () => {
    expect(css).not.toMatch(/\.wb-item-title \{ flex: 1 1 8ch;/)
    expect(css).toMatch(/\.wb-item-title \{ flex: 1 1 auto; min-width: min\(100%, 8ch\); \}/)
  })

  it('#555: in the column rows the title is as tall as its text, and a name is at most three lines everywhere', () => {
    expect(css).toMatch(/\.wb-fr-panel \.wb-item-title \{ flex: 0 0 auto;[^}]*-webkit-line-clamp: 3;/)
    expect(css).toMatch(/\.wb-item-title \{ word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3;/)
    expect(css).not.toMatch(/\.wb-item-title \{[^}]*-webkit-line-clamp: 1;/)
  })
})
