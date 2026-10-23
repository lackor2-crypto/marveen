import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'style.css'), 'utf8')

describe('email reader header never paints the buttons over the title', () => {
  it('is a wrapping flex row, so a 5th button (Drafts) cannot overflow into the title', () => {
    expect(css).toContain('.email-reader-sticky-header .email-list-header { display: flex; flex-wrap: wrap;')
    expect(css).not.toContain('.email-reader-sticky-header .email-list-header { grid-template-columns: auto minmax(0, 1fr) auto; }')
  })

  it('the title is the part that gives way', () => {
    expect(css).toMatch(/\.email-reader-sticky-header \.email-list-header-title \{[^}]*flex: 1 1 0; min-width: 0;/)
  })

  it('the action group wraps instead of scrolling inside itself, so Törlés is never hidden off-screen', () => {
    const rule = css.match(/\.email-reader-sticky-header \.email-reader-actions-left \{[^}]*flex: 0 0 auto;[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toContain('flex-wrap: wrap')
    expect(rule![0]).not.toContain('overflow-x')
    expect(css).not.toMatch(/\.email-reader-actions-left \{[^}]*overflow-x: auto/)
  })
})
