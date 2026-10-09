import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOC_EXPORT_FORMATS, htmlToExportBytes } from '../workbench-docedit.js'
import { probeLibreOffice } from '../office-convert.js'

const HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title></head><body><h1>Cim</h1><p>Szia arvizturo <b>fel</b></p></body></html>'

// Own render cache, so its own LibreOffice profile (lo-profile). The conversion queue only serialises inside ONE
// process; another vitest worker converting with the shared store/workbench-render profile at the same moment
// makes soffice exit non-zero ("convert_failed") -- measured 2026-10-09: 4 parallel processes on one profile, 1
// failed in each of 2 rounds; on separate profiles 8/8 converted. Same isolation as office-convert.test.ts.
let cacheDir = ''
let savedCache: string | undefined
beforeAll(() => {
  savedCache = process.env['MARVEEN_RENDER_CACHE']
  cacheDir = mkdtempSync(join(tmpdir(), 'wb-export-doc-'))
  process.env['MARVEEN_RENDER_CACHE'] = cacheDir
})
afterAll(() => {
  if (savedCache === undefined) delete process.env['MARVEEN_RENDER_CACHE']
  else process.env['MARVEEN_RENDER_CACHE'] = savedCache
  rmSync(cacheDir, { recursive: true, force: true })
})

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
