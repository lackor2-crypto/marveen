// #818 -- a project tile in the Projects list must not grow without bound when
// the project has a long description (Boss, TG 3742/3744): the tile shows at
// most 4 lines ending in "...", the full text is shown when the project is
// opened.
//
// Measured in a real browser on an isolated web-only instance (2026-11-02):
// a 1463-character description renders 78 px (4 lines) in the tile, scrollHeight
// 644 (the rest is hidden, not dropped), the tile is 164 px high, and the
// opened project shows the whole text unclamped. This test pins the two source
// facts that measurement depends on, so a later CSS cleanup cannot silently
// bring the giant tile back.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const css = readFileSync(join(root, 'web', 'style.css'), 'utf8')
const js = readFileSync(join(root, 'web', 'app.js'), 'utf8')

function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp('(?:^|\\n)' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

describe('#818 project tile description is clamped, the opened project is not', () => {
  const tileDesc = rule('.prj-tile-desc')

  it('the tile description is cut after 4 lines with an ellipsis', () => {
    expect(tileDesc).not.toBe('')
    expect(tileDesc).toMatch(/display:\s*-webkit-box/)
    expect(tileDesc).toMatch(/-webkit-box-orient:\s*vertical/)
    expect(tileDesc).toMatch(/-webkit-line-clamp:\s*4\b/)
    expect(tileDesc).toMatch(/\bline-clamp:\s*4\b/)
    expect(tileDesc).toMatch(/overflow:\s*hidden/)
    expect(tileDesc).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('an unbroken long word cannot widen the tile either', () => {
    expect(tileDesc).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('the tile renders the description through that class', () => {
    expect(js).toMatch(/<span class="prj-tile-desc">\$\{escapeHtml\(p\.description\)\}<\/span>/)
  })

  it('the opened project shows the full description, with no clamp class', () => {
    expect(js).toMatch(/<p class="subtitle">\$\{escapeHtml\(p\.description\)\}<\/p>/)
    expect(rule('.subtitle')).not.toMatch(/line-clamp/)
    expect(rule('.prj-head-main .subtitle')).not.toMatch(/line-clamp/)
  })
})
