import { describe, expect, it } from 'vitest'
import { docEditExt, looksLikePdf, pdfHtmlToParagraphs, sanitizeDocHtml } from '../workbench-docedit.js'

describe('workbench docedit (#444)', () => {
  it('docEditExt accepts only Word-type documents', () => {
    expect(docEditExt('Szerzodes.DOCX')).toBe('docx')
    expect(docEditExt('a/b/level.doc')).toBe('doc')
    expect(docEditExt('x.odt')).toBe('odt')
    expect(docEditExt('x.rtf')).toBe('rtf')
    expect(docEditExt('x.pdf')).toBeNull()
    expect(docEditExt('x.xlsx')).toBeNull()
    expect(docEditExt('')).toBeNull()
    expect(docEditExt('constructor')).toBeNull()
  })

  it('sanitizeDocHtml strips scripts, handlers and external references', () => {
    const dirty = '<p onclick="x()">A</p><script>alert(1)</script><iframe src="https://e"></iframe>'
      + '<img src="https://evil/x.png"><img src="data:image/png;base64,AAAA">'
      + '<a href="javascript:bad()">l</a><link rel="stylesheet" href="https://e/s.css">'
      + '<p style="background:url(https://e/b.png)">B</p>'
    const out = sanitizeDocHtml(dirty)
    expect(out).not.toMatch(/script|onclick|iframe|<link|javascript:|https:\/\/evil|https:\/\/e\/b/i)
    expect(out).toContain('data:image/png;base64,AAAA')
    expect(out).toContain('<p>A</p>')
  })

  it('pdfHtmlToParagraphs makes one paragraph per line and page breaks per page', () => {
    const raw = '<html><body><a name=1></a><b>Cim<br/></b>Elso sor<br/>Masodik<br/><hr/>'
      + '<a name=2></a>Uj lap<br/><hr/><a name="outline"></a><h1>Document Outline</h1></body></html>'
    const out = pdfHtmlToParagraphs(raw)
    expect(out).toContain('<p><b>Cim</b></p>')
    expect(out).toContain('<p>Elso sor</p>')
    expect(out).toContain('<p style="page-break-before: always">Uj lap</p>')
    expect(out).not.toContain('Document Outline')
  })

  it('looksLikePdf checks header and trailer', () => {
    expect(looksLikePdf(Buffer.from('%PDF-1.4\n1 0 obj\n%%EOF\n'))).toBe(true)
    expect(looksLikePdf(Buffer.from('%PDF-1.4 truncated'))).toBe(false)
    expect(looksLikePdf(Buffer.from('<html>%%EOF</html>'))).toBe(false)
  })
})
