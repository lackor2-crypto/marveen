import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Kanban 91b0d989 (Boss 2026-09-23): on the vault page one tall card left a
// big empty hole under its row-mates, because a CSS grid row is as tall as its
// tallest card. The cards must follow each other continuously -> columns.
const css = readFileSync(join(__dirname, '..', '..', 'web', 'style.css'), 'utf8')
const rule = (sel: string) => {
  const i = css.indexOf(sel + ' {')
  expect(i, `${sel} rule missing`).toBeGreaterThan(-1)
  return css.slice(i, css.indexOf('}', i))
}

describe('vault page layout: cards flow without row gaps', () => {
  it('the vault grid is a multi-column flow, not grid rows', () => {
    const r = rule('.vault-grid')
    expect(r).toMatch(/column-width:\s*\d+px/)
    expect(r).not.toMatch(/display:\s*grid/)
    expect(r).not.toMatch(/grid-template-columns/)
  })

  it('a card never splits across two columns and keeps a gap below it', () => {
    const r = rule('.vault-grid > .vault-card')
    expect(r).toMatch(/break-inside:\s*avoid/)
    expect(r).toMatch(/margin-bottom:\s*\d+px/)
  })
})
