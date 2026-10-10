// #544 (owner, 2026-10-10): the text colour and highlight buttons work like Word's -- the main part puts the last
// used colour on the selection at once, the arrow opens the choice, the glyph shows the colour in use and the colour
// is remembered. The behaviour needs a real browser (execCommand, a live selection); it was measured in Chromium on
// an isolated instance. This pins the wiring, and the #532 guard that stops the "black bar" in an empty field.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', 'web')
const src = readFileSync(join(root, 'workbench.js'), 'utf8')
const css = readFileSync(join(root, 'workbench.css'), 'utf8')
const hu = readFileSync(join(root, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(root, 'lang', 'en.js'), 'utf8')

describe('Word-like colour buttons (#544)', () => {
  it('each colour has a main part that applies and an arrow that only opens the choice', () => {
    expect(src).toContain('data-wb-fmt="clr-\' + kind + \'"')
    expect(src).toContain('data-wb-fmt="clrpop-\' + kind + \'"')
    expect(src).toMatch(/if \(f\.indexOf\('clr-'\) === 0\) \{ dpClrPopClose\(\); dpApplyInline\(el, f\.slice\(4\), dpClrNow\(f\.slice\(4\)\)\); return \}/)
    // the arrow is handled BEFORE a field is required and never re-renders (the text selection must survive)
    expect(src.indexOf("f.indexOf('clrpop-') === 0")).toBeLessThan(src.indexOf("if (f === 'clear') { dpClearFormat(el); return }"))
  })

  it('a picked swatch is remembered, shown on the glyph and applied -- also when it is the same colour again', () => {
    expect(src).toMatch(/if \(f\.indexOf\('clrpick-'\) === 0\) \{ var pk = f\.slice\(8\); dpClrSet\(pk, btn\.getAttribute\('data-wb-clr'\)\); dpClrPopClose\(\); dpApplyInline\(el, pk, dpClrNow\(pk\)\); return \}/)
    expect(src).toContain("gl[i].style[kind === 'fore' ? 'borderBottomColor' : 'color'] = WB.dpClr[kind]")
    // the native picker ("more colours") remembers too
    expect(src).toContain("dpClrSet(clr.getAttribute('data-wb-fmtcolor'), clr.value)")
  })

  it('the remembered colour is a convenience: storage may be missing, a bad value falls back to the default', () => {
    expect(src).toMatch(/try \{ v = window\.localStorage\.getItem\('wb\.dp\.clr\.' \+ kind\) \} catch \(_e\) \{ v = null \}/)
    expect(src).toMatch(/try \{ window\.localStorage\.setItem\('wb\.dp\.clr\.' \+ kind, WB\.dpClr\[kind\]\) \} catch/)
    expect(src).toContain("WB.dpClr[kind] = dpClrValid(v) ? v.toLowerCase() : DP_CLR_DEFAULT[kind]")
    expect(src).toContain("var DP_CLR_DEFAULT = { fore: '#cc0000', hilite: '#ffff00' }")
  })

  it('the choice opens by a class (not the hidden attribute) and has its styles', () => {
    expect(css).toContain('.wb-dp-clrgrp.is-open .wb-dp-clrpop { display: flex; }')
    expect(css).toMatch(/\.wb-dp-clrpop \{ display: none;/)
  })

  it('every new label exists in Hungarian and in English', () => {
    for (const k of ['fmt_color_apply', 'fmt_color_choose', 'fmt_hilite_apply', 'fmt_hilite_choose', 'fmt_clr_more', 'fmt_nocolor_short', 'fmt_nohilite_short']) {
      expect(hu).toContain('"workbench.dp.' + k + '"')
      expect(en).toContain('"workbench.dp.' + k + '"')
    }
  })
})

describe('"none" in an empty field leaves no marker behind (#532, the black bar)', () => {
  it('dpExecNone does nothing on a collapsed caret', () => {
    const at = src.indexOf('function dpExecNone(el, kind) {')
    const body = src.slice(at, at + 1200)
    // collapsed, or nothing but the line break an emptied field keeps
    expect(body).toContain("if (!cs || !cs.rangeCount || cs.isCollapsed || /^[\\r\\n]*$/.test(String(cs.toString()))) return")
    expect(body.indexOf('cs.isCollapsed')).toBeLessThan(body.indexOf("execCommand('foreColor'"))
  })
})
