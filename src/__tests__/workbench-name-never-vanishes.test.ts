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
    expect(css).toMatch(/\.wb-item-title \{ flex: 1 1 8ch; min-width: min\(100%, 8ch\); \}/)
    for (const m of css.matchAll(/([^{}]*\.wb-item-title[^{}]*)\{([^}]*)\}/g)) {
      expect(m[2]).not.toMatch(/min-width:\s*0\b/)
    }
  })

  it('the row button and the type line wrap instead of squeezing the name', () => {
    expect(css).toMatch(/\.wb-item \{ flex-wrap: wrap; \}/)
    expect(css).toMatch(/\.wb-item-row \.wb-item \{ flex: 1 1 auto; min-width: min\(100%, 9rem\); \}/)
    expect(css).toMatch(/\.wb-fr-panel \.wb-item-row \{ flex-wrap: wrap;/)
    expect(css).not.toMatch(/\.wb-fr-panel \.wb-item-row \.wb-item \{[^}]*min-width: 0;/)
  })

  it('the full name is the row button\'s tooltip (work items and loose files)', () => {
    expect(js).toMatch(/\(it\.source_path \? baseOf\(it\.source_path\) : it\.title\) \+ \(archived\(\)/)
    expect(js).toContain("escA(f.name + ' \\u2014 ' + t('workbench.file.open'))")
  })
})
