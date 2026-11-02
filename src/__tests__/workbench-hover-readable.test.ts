// #834 (Boss TG 4375): hovering a folder row turned its letters pale red (the accent colour on a tinted row) and they could
// not be read. No Workbench :hover rule may recolour TEXT with the accent colour: a hover shows a border or an underline.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('Workbench hover keeps the text readable (#834)', () => {
  it('no :hover rule sets the text colour to the accent colour', () => {
    const bad = css.split('\n').filter((l) => /:hover[^{]*\{[^}]*(?:^|[\s;{])color:\s*var\(--accent/.test(l))
    expect(bad).toEqual([])
  })
  it('the folder toggle shows an underline on hover', () => {
    expect(css).toMatch(/\.wb-folder-toggle:hover \{ text-decoration: underline;/)
  })
})
