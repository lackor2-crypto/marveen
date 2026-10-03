import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #470: on the Projects page the content area scrolls, never the document, so the left menu and its
// collapse button cannot slide away (Boss, TG 7643). Source-contract checks on the three files involved.
const web = (f: string) => readFileSync(join(__dirname, '..', '..', 'web', f), 'utf8')

describe('projects page keeps the menu fixed (#470)', () => {
  it('app.js marks main as projects-active only on the projects page', () => {
    expect(web('app.js')).toContain("classList.toggle('projects-active', pageId === 'projects')")
  })

  it('style.css makes main the scroll owner on wide screens, contained, with no document growth', () => {
    const css = web('style.css')
    const m = css.match(/@media \(min-width: 769px\) \{[^}]*main\.projects-active \{([^}]*)\}/)
    expect(m).not.toBeNull()
    const rule = m![1]
    expect(rule).toContain('height: 100vh')
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toContain('position: relative')
  })

  it('phones (<=768px) are not given the fixed-height scroller', () => {
    const css = web('style.css')
    expect(css).not.toMatch(/max-width: 768px\) \{[^}]*main\.projects-active/)
  })

  it('the Simple-view frame height counts the scrolled main host', () => {
    const js = web('workbench.js')
    expect(js).toContain("fr.closest('main.projects-active')")
    expect(js).toContain('host.scrollTop = 0')
  })
})
