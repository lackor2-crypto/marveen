import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const js = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')
const css = readFileSync(join(root, 'web', 'workbench.css'), 'utf8')

// #492: a trashed item is one framed card: title line, type line, then both buttons together.
describe('Workbench trash card', () => {
  it('renders title, meta and the two buttons inside one card, not in a nowrap item row', () => {
    const i = js.indexOf('<li class="wb-trash-card">')
    expect(i).toBeGreaterThan(0)
    const block = js.slice(i, i + 1200)
    expect(block).toContain('wb-trash-card-title')
    expect(block).toContain('wb-trash-card-actions')
    expect(block).toContain('item-restore')
    expect(block).toContain('item-purge-ask')
    expect(block).not.toContain('wb-trash-row')
  })
  it('gives the title its own full-width, wrapping line', () => {
    expect(css).toMatch(/\.wb-trash-card-title \{[^}]*width: 100%/)
    expect(css).toMatch(/\.wb-trash-card-title \{[^}]*overflow-wrap: anywhere/)
  })
})

// TG 2469: no page scroll in the Simple view until the technical details open; opening scrolls to them.
describe('Simple view technical details', () => {
  it('locks the page scroll while the details are closed and scrolls to them on open', () => {
    expect(js).toContain("host.classList.toggle('wb-sh-locked', lock)")
    expect(js).toContain('lockFrameScroll()')
    expect(js).toContain("if (WB.shMore) scrollTechIntoView()")
    expect(js).toContain("scrollIntoView({ behavior: 'smooth', block: 'start' })")
    expect(css).toContain('main.projects-active.wb-sh-locked { overflow-y: hidden; }')
  })
})
