import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #580: the project tree header sits higher, the hide-finalized switch hugs the buttons.
const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('workbench tree header compact (#580)', () => {
  it('the hide switch has no outer margin', () => {
    const m = css.match(/\.wb-root \.wb-hide-done \{[^}]*\}/)
    expect(m).not.toBeNull()
    expect(m![0]).toContain('margin: 0;')
  })
  it('the items panel is tightened and the buttons ride at the top', () => {
    expect(css).toMatch(/\.wb-panel-items \{ padding-top: 6px; gap: 2px; \}/)
    expect(css).toMatch(/\.wb-panel-items \.wb-panel-head \{ align-items: flex-start; \}/)
    expect(css).toMatch(/\.wb-panel-items \.wb-head-btns \{ margin-top: -2px; \}/)
  })
})
