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

// 2026-09-06 (kanban #232): a 2026-08-10-i javitas KEVES volt, es Boss ugyanabba
// akadt bele masodszor. Ket meresi hiba maradt benne:
//   1. `pop.style.maxHeight = ''` NEM torli a stiluslap 320px-es korlatjat, csak
//      a soron levo erteket -- a "termeszetes magassag" ezert legfeljebb 320
//      lehetett, es egy hosszabb lista ala-becslest kapott;
//   2. `Math.max(140, ...)` a HELY helyett egy minimumot irt vissza, tehat ha a
//      horgony alatt tenyleg csak 40px volt, a doboz 140px-esre nyilt, es
//      100px-nyi -- benne az inditogomb -- a kepernyo ala csuszott.
// Az ELSO ket allitas ezert az UJ szerzodest meri (`'none'` + a valodi hely).
// A geometria maga viselkedesi tesztet kapott, ami minden horgony-poziciot
// vegigsopor: `src/__tests__/verify-picker-viewport.test.ts`.
describe('verify-picker popover placement', () => {
  it('flips above the anchor when there is more room there', () => {
    expect(APP).toContain('function _placeVerifyPicker()')
    expect(APP).toContain('const openUp = natural > below && above > below')
    // Felfele nyitaskor a doboz ALJA horgonyzodik (bottom), nem a teteje: igy a
    // magassaga sosem tolhatja at a horgonyon.
    expect(APP).toMatch(/if \(room < MIN_USABLE\)/)
    expect(APP).toMatch(/\} else if \(openUp\) \{/)
    expect(APP).toContain('pop.style.bottom = `${Math.max(MARGIN, window.innerHeight - rect.top + GAP)}px`')
  })

  it('caps its height to the space available, so the list scrolls instead', () => {
    expect(APP).toContain('pop.style.maxHeight = `${room}px`')
    // A meres ELOTT a stiluslap korlatjat is fel kell oldani -- ures sztringgel
    // nem lehet, csak 'none'-nal (ez volt az 1. hiba).
    expect(APP).toContain("pop.style.maxHeight = 'none'")
    // A hely a HELY, nem egy alsó kuszob (ez volt a 2. hiba).
    expect(APP).toContain('const room = openUp ? above : below')
    expect(APP).not.toMatch(/const room = Math\.max\(140,/)
  })

  it('stays put when the window is resized or scrolled while open', () => {
    expect(APP).toContain("window.addEventListener('resize', _repositionVerifyPicker)")
    expect(APP).toContain("window.addEventListener('scroll', _repositionVerifyPicker, true)")
    expect(APP).toContain("window.removeEventListener('resize', _repositionVerifyPicker)")
    expect(APP).toContain("window.removeEventListener('scroll', _repositionVerifyPicker, true)")
  })

  it('scrolling the popover\'s own list does not move the popover', () => {
    expect(APP).toContain('if (e?.target instanceof Node && _verifyPickerPopover?.contains(e.target)) return')
  })

  it('survives the approvals table re-rendering under it', () => {
    // The table rebuilds every 5s while a verification runs, detaching the
    // anchor button. A detached node reports an all-zero rect, and placing
    // against that threw the popover into the top-left corner.
    expect(APP).toContain('function _currentVerifyAnchor()')
    expect(APP).toContain('if (_verifyPickerAnchor?.isConnected) return _verifyPickerAnchor')
    expect(APP).toContain('.approvals-verify-btn[data-id="${CSS.escape(_verifyPickerApprovalId)}"]')
    expect(APP).toContain('if (!rect.width && !rect.height) return')
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
