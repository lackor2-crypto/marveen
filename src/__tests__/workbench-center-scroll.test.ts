// #703: the Simple-view middle column (document, deck, table) scrolls on its own instead of clipping.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('workbench middle column scroll (#703)', () => {
  it('the centre column scrolls vertically, never sideways', () => {
    expect(css).toMatch(/\.wb-fr-center \{ min-height: 0; overflow-x: hidden; overflow-y: auto; \}/)
  })
  it('the fixed page area and the table area keep a minimum height, so the column scrolls instead of squeezing them to nothing', () => {
    expect(css).toMatch(/\.wb-fr-fixed \{ flex: 1 1 0; min-height: 320px; overflow: hidden;/)
    expect(css).toMatch(/\.wb-fr-tbl \{ flex: 1 1 0; min-height: 320px;/)
  })
  it('the page keeps its fit-to-view scale (container units of .wb-fr-fixed) and the phone rule keeps overflow visible', () => {
    expect(css).toContain('width: calc(min(100cqw, 100cqh * var(--ar, 1)) * var(--wb-zoom, 1))')
    expect(css).toMatch(/@media \(max-width: 900px\) \{ \.wb-fr-center \{ overflow: visible; \}/)
  })
})
