// #532 (Boss TG 8559): colours and every formatting can be switched off again. The behaviour needs a real browser
// (execCommand); it was measured in Chromium (colour off, highlight off, partial selection, clear all, size/font
// reset). This pins the wiring so the buttons and the reset entries cannot silently disappear.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const hu = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf8')

describe('formatting can be switched off (#532)', () => {
  it('the ribbon has "no colour" and "no highlight" buttons next to the pickers', () => {
    expect(src).toMatch(/btn\('nocolor', t\('workbench\.dp\.fmt_nocolor'\)/)
    expect(src).toMatch(/btn\('nohilite', t\('workbench\.dp\.fmt_nohilite'\)/)
  })

  it('font, size and space-after have a "default" entry that is handled', () => {
    expect((src.match(/\['__reset', t\('workbench\.dp\.fmt_reset'\)\]/g) || []).length).toBe(3)
    expect(src).toMatch(/v === '__reset'/)
    expect(src).toMatch(/dpSetPfmt\(el, \{ sa: null \}\)/)
  })

  it('"clear formatting" strips colour, highlight, font and size too, not only bold/italic', () => {
    expect(src).toMatch(/if \(f === 'clear'\) \{ dpClearFormat\(el\); return \}/)
    expect(src).toMatch(/\['fore', 'hilite', 'font', 'size'\]\.forEach\(function \(k\) \{ dpExecNone\(el, k\) \}\)/)
  })

  it('the Hungarian labels exist', () => {
    for (const k of ['fmt_reset', 'fmt_nocolor', 'fmt_nohilite']) expect(hu).toContain('"workbench.dp.' + k + '"')
  })

  it('the style picker offers Heading 1 and the class swap clears every level (#534 a)', () => {
    expect(src).toMatch(/\['1', t\('workbench\.dp\.fmt_head1'\)\], \['2', t\('workbench\.dp\.fmt_head2'\)\], \['3', t\('workbench\.dp\.fmt_head3'\)\]/)
    expect(src).toContain("el.classList.remove('wb-dp-h1', 'wb-dp-h2', 'wb-dp-h3')")
    const en = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf8')
    expect(hu).toContain('"workbench.dp.fmt_head1": "Címsor 1"')
    expect(en).toContain('"workbench.dp.fmt_head1": "Heading 1"')
  })
})
