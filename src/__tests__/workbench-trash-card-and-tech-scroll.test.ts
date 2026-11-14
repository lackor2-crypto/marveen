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
  it('locks the page scroll in the frame (the details open in its middle column, #906)', () => {
    expect(js).toContain("host.classList.toggle('wb-sh-locked', lock)")
    expect(js).toContain('lockFrameScroll()')
    // #906: the details open in the frame's middle column, so there is nothing below the page to scroll to any more
    expect(js).not.toContain('scrollTechIntoView')
    expect(css).toContain('main.projects-active.wb-sh-locked:has(.wb-fr-body) { overflow-y: hidden; }')
  })
})
