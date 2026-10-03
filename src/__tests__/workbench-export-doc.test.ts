import { describe, it, expect } from 'vitest'
import { DOC_EXPORT_FORMATS, htmlToExportBytes } from '../workbench-docedit.js'
import { probeLibreOffice } from '../office-convert.js'

const HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title></head><body><h1>Cim</h1><p>Szia arvizturo <b>fel</b></p></body></html>'

describe('workbench export to document formats', () => {
  it('offers the common word-processor formats', () => {
    for (const f of ['docx', 'doc', 'odt', 'rtf', 'txt', 'epub']) expect(DOC_EXPORT_FORMATS[f]).toBeTruthy()
  })

  it('rejects an unknown format without touching LibreOffice', async () => {
    const r = await htmlToExportBytes(HTML, 'exe')
    expect(r.ok).toBe(false)
  })

  it('produces a real docx / odt when LibreOffice is installed', async () => {
    const probe = await probeLibreOffice()
    if (!probe.available) return
    const docx = await htmlToExportBytes(HTML, 'docx')
    expect(docx.ok).toBe(true)
    if (docx.ok) expect(docx.data.subarray(0, 2).toString('latin1')).toBe('PK')
    const txt = await htmlToExportBytes(HTML, 'txt')
    expect(txt.ok).toBe(true)
    if (txt.ok) expect(txt.data.toString('utf-8')).toContain('Szia')
  }, 120_000)
})
