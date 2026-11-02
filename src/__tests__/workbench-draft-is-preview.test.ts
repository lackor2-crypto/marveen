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
    expect(css).toMatch(/\.wb-dp-tailrow:focus-within\s*>\s*\.wb-dp-tail\s*\{[^}]*position:\s*static/)
    // the old rule that gave every tail row a line of its own is gone
    expect(css).not.toMatch(/\.wb-dp-tail\s*\{\s*min-height:\s*1\.6em;\s*\}/)
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
