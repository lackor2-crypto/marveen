// The agent-picker popover on the Approvals page is position:fixed, so
// anything that lands below the viewport is unreachable -- the page cannot be
// scrolled to it. Boss hit exactly that (2026-08-10): opened from the last row
// of the table, the popover's own "Ellenőrzés indítása" button sat under the
// bottom edge of the window with no way to get at it.
//
// String-contract assertions in the house idiom: the property guarded here is
// "the popover is placed against the available space", which lives in the
// frontend file and has no server-side unit to test.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

describe('verify-picker popover placement', () => {
  it('flips above the anchor when there is more room there', () => {
    expect(APP).toContain('function _placeVerifyPicker()')
    expect(APP).toContain('const openUp = natural > below && above > below')
    expect(APP).toMatch(/pop\.style\.top = openUp/)
  })

  it('caps its height to the space available, so the list scrolls instead', () => {
    expect(APP).toContain('pop.style.maxHeight = `${room}px`')
    expect(APP).toMatch(/const room = Math\.max\(140, openUp \? above : below\)/)
  })

  it('stays put when the window is resized or scrolled while open', () => {
    expect(APP).toContain("window.addEventListener('resize', _repositionVerifyPicker)")
    expect(APP).toContain("window.addEventListener('scroll', _repositionVerifyPicker, true)")
    expect(APP).toContain("window.removeEventListener('resize', _repositionVerifyPicker)")
    expect(APP).toContain("window.removeEventListener('scroll', _repositionVerifyPicker, true)")
  })

  it('is re-placed after the agent list arrives, when its height is real', () => {
    // The popover is opened with a one-line "loading" body and filled in after
    // a fetch; placing it only at open time would measure the wrong height.
    const open = APP.indexOf('async function _openVerifyPicker(')
    const afterList = APP.indexOf('_placeVerifyPicker()', APP.indexOf('verify-picker-list'))
    expect(open).toBeGreaterThan(-1)
    expect(afterList).toBeGreaterThan(open)
  })
})
