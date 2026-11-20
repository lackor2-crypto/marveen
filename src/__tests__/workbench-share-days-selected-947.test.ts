import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')
const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

// #947: the 1/7/30 day buttons of the read-only link set aria-pressed, but nothing styled it, so the
// owner could not see which validity was chosen.
describe('read-only link validity choice shows the selection (#947)', () => {
  it('the day buttons set aria-pressed from the chosen value', () => {
    expect(js).toMatch(/data-wb-act="share-days"[^;]*aria-pressed="' \+ \(WB\.shareDays === d\)/)
  })
  it('a pressed day button is visibly different', () => {
    expect(css).toMatch(/\.wb-share-new \[aria-pressed="true"\]\s*\{[^}]*background/)
  })
})

describe('a pending read-only link names how long it will live (#947)', () => {
  it('the pending row uses the chosen number of days, in HU and EN', () => {
    expect(js).toMatch(/sh\.days \? t\('workbench\.share\.st\.pending_days', \{ n: sh\.days \}\)/)
    for (const l of ['hu', 'en']) expect(readFileSync(join(__dirname, '..', '..', 'web', 'lang', l + '.js'), 'utf8')).toMatch(/"workbench\.share\.st\.pending_days":/)
  })
})
