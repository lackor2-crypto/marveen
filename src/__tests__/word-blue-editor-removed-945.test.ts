import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #945: ONE editor everywhere. The second, blue "Szerkesztés itt, a Munkapadon" Word editor is physically
// removed; a Word file (and the .docx a PDF is turned into) is read onto the court-document page (importWordToOutline).
const root = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')

describe('#945 the blue Word editor is gone, the court-document editor is the only one', () => {
  const js = read('web', 'workbench.js')
  const routes = read('src', 'web', 'routes', 'workbench.ts')

  it('the frontend has none of the blue editor\'s functions, buttons or state', () => {
    for (const k of ['openDocEdit', 'closeDocEdit', 'saveDocEdit', 'docEditMount', 'docEditHtml', 'docAutoOpen', 'docBuildHost',
      'docImgDragInit', 'docEditableExt', 'DOC_EDIT_EXTS', 'data-wb-act="doc-edit"', 'doc-edit-close', 'data-de-act', 'WB.docEdit']) {
      expect(js, k).not.toContain(k)
    }
  })

  it('the server has no save / read route of the blue editor (doc-html)', () => {
    expect(routes).not.toContain("'doc-html'")
  })

  it('no dead strings or styles are left behind', () => {
    for (const f of ['hu', 'en']) {
      const lang = read('web', 'lang', f + '.js')
      expect(lang, f).not.toContain('"workbench.docedit.open"')
      expect(lang, f).not.toContain('"workbench.docedit.save"')
    }
    const css = read('web', 'workbench.css')
    expect(css).not.toContain('.wb-docedit-page')
    expect(css).not.toContain('.wb-docedit-paper')
  })

  it('PDF -> Word reads the new .docx onto the court-document page (detail reloaded, import allowed again)', () => {
    const at = js.indexOf('function pdfToDocx()')
    expect(at).toBeGreaterThan(0)
    const body = js.slice(at, at + 1800)
    expect(body).toMatch(/textImportTried\[itemId\] = false/)
    expect(body).toMatch(/loadDetail\(itemId\)/)
  })

  it('the PDF marking tool (a separate PDF tool, not a Word editor) stays', () => {
    expect(js).toContain('function openPdfEdit()')
    expect(js).toContain('data-wb-act="pdf-edit"')
    expect(js).toContain('data-wb-act="pdf-to-docx"')
  })
})
