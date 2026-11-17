// #841 (Boss, TG 4449/4461): the Draft of a document IS its Preview. Before, the edit page put an extra clickable "new line" row
// (1.6em) beside every picture / table that the read-only Preview did not have, so the two drew the same document with
// different spacing. Measured in a real browser (10 rows, draft vs preview): identical after this change.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../web/workbench.css', import.meta.url), 'utf8')

describe('#841 the draft page takes the same room as the preview page', () => {
  it('the new-line rows beside pictures and tables take no layout height until focused', () => {
    expect(css).toMatch(/\.wb-dp-tailrow\s*\{[^}]*height:\s*0/)
    expect(css).toMatch(/\.wb-dp-tailrow\s*>\s*\.wb-dp-tail\s*\{[^}]*position:\s*absolute/)
    expect(css).toMatch(/\.wb-dp-tailrow\.is-cur\s*>\s*\.wb-dp-tail\s*\{[^}]*position:\s*static/)
    // the old rule that gave every tail row a line of its own is gone
    expect(css).not.toMatch(/\.wb-dp-tail\s*\{\s*min-height:\s*1\.6em;\s*\}/)
  })

  // The page is ONE contenteditable host: the browser's focus sits on .wb-dp-page, never on a row inside it, so :focus-within on a row
  // never matches (measured in a real browser: click on the strip -> activeElement = .wb-dp-page, row height stayed 0 and the typed
  // text stayed clipped in the 12px strip). The row the cursor is in is marked .is-cur by the selectionchange handler; the strip
  // opens on THAT.
  it('the strip opens on the cursor row marker (.is-cur), not on :focus-within (the page is one editing host)', () => {
    expect(css).not.toMatch(/\.wb-dp-tailrow:focus-within/)
    expect(css).toMatch(/\.wb-dp-tailrow\.is-cur\s*\{[^}]*height:\s*auto/)
    // --wb-lh is a UNITLESS number (1.6): `min-height: var(--wb-lh, 1.6em)` is invalid then and the opened empty row was ~2px high
    // (measured); the line height must be built as calc(var(--wb-lh, 1.6) * 1em) like .wb-dp-edit does.
    expect(css).toMatch(/\.wb-dp-tailrow\.is-cur\s*>\s*\.wb-dp-tail\s*\{[^}]*min-height:\s*calc\(var\(--wb-lh,\s*1\.6\)\s*\*\s*1em\)/)
    expect(js).toMatch(/row\.classList\.add\('is-cur'\)/)
    expect(js).toMatch(/f\.closest\('\.wb-dp-row, \.wb-dp-sechead'\)/)
  })

  it('a document with chapters has no Preview tab: the draft page is the one view', () => {
    expect(js).toMatch(/var pageIsPreview = !!\(o && o\.sections && o\.sections\.length\)/)
    expect(js).toMatch(/if \(!pageIsPreview\) tabs\.push\(\['preview', 'workbench\.sh\.doc\.preview'\]\)/)
    expect(js).toMatch(/if \(pageIsPreview && tab === 'preview'\) tab = 'draft'/)
  })

  it('the draft PDF button stays', () => {
    expect(js).toContain("'workbench.sh.doc.draft_pdf'")
  })
})
