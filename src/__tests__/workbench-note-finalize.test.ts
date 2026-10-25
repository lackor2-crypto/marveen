// #667 (Boss TG 9260) made a .md / .txt work item's own PDF finalize; #777 / #803 (Boss TG: "egy helyen javitunk, mindenhol
// javitva van") removed it: a note is read onto the document page and finalized there by the court document's own finalize.
// These tests hold the new contract: the old route makes no PDF of its own and points to the document page.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { hasTextFinalPanel, isTextSourcePath } from '../workbench-notefinal.js'
import { textLangState } from '../workbench-notelang.js'
import { workItemTypeForFile } from '../workbench-upload.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { rmTempDir } from './helpers/rm-temp-dir.js'

const FAKE_SOFFICE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 tesztpeldany"; exit 0; fi
out=""; prev=""; last=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"; last="$a"
done
# the test reads back what was converted (the document text), to prove WHICH text became the PDF
if [ -n "$MARVEEN_TEST_CAPTURE" ] && [ -f "$last" ]; then cp "$last" "$MARVEEN_TEST_CAPTURE"; fi
printf '%%PDF-1.4 teszt' > "$out/doc.pdf"
exit 0
`

describe('#803 text-file work item: one finalize, on the document page', () => {
  let depot = ''
  let pid = ''
  const saved: Record<string, string | undefined> = {}
  const mkNote = (rel: string | null, title = 'Terv', type: 'note' | 'video' = 'note') => {
    const w = createWorkItem({ project_id: pid, title, type })
    if (!w.ok) throw new Error('munkadarab')
    if (rel) getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(rel, w.item.id)
    return w.item.id
  }
  const approval = (id: string, body: unknown, kind = 'session') =>
    callWorkbench(`/api/workbench/items/${id}/approval`, 'POST', body, undefined, kind === 'session' ? { kind: 'session', user: 'teszt' } : { kind })

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-notefinal-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE', 'MARVEEN_TEST_CAPTURE']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    const fake = join(depot, 'fake-soffice.sh')
    writeFileSync(fake, FAKE_SOFFICE, 'utf-8')
    chmodSync(fake, 0o755)
    process.env['MARVEEN_SOFFICE'] = fake
    resetLibreOfficeProbe()
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    writeFileSync(join(depot, 'Projektek', 'Iroda', 'Terv.md'), '# Terv\n\nElső sor.\n', 'utf-8')
  })

  afterEach(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    resetLibreOfficeProbe()
    rmTempDir(depot)
  })

  it('knows which files are text files', () => {
    expect(isTextSourcePath('a/b/Terv (2).md')).toBe(true)
    expect(isTextSourcePath('a/b/jegyzet.TXT')).toBe(true)
    expect(isTextSourcePath('a/b/kep.png')).toBe(false)
    expect(isTextSourcePath(null)).toBe(false)
    expect(hasTextFinalPanel({ source_path: 'x/y.md' })).toBe(true)
    expect(hasTextFinalPanel({ source_path: null })).toBe(false)
  })

  const pdfsIn = (rel: string): string[] => {
    const out: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name))
        else if (/\.pdf$/i.test(e.name)) out.push(e.name)
      }
    }
    walk(join(depot, rel))
    return out
  }

  it('a note not read onto the page yet: the old PDF finalize is gone, the answer points to the document page', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('final_needs_document_page')
    expect(r.body.message).toMatch(/dokumentum-oldalon/)
    expect(getWorkItem(id)?.status).not.toBe('done')
    expect(pdfsIn('Projektek/Iroda')).toEqual([])
  })

  it('once on the page, the old route points to the page\'s own finalize (nothing is made, nothing is closed)', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const imp = await callWorkbench(`/api/workbench/items/${id}/text-import`, 'POST', {}, undefined, { kind: 'session', user: 'teszt' })
    expect(imp.status).toBe(201)
    for (const body of [{ action: 'finalize', pdf: true }, { action: 'finalize', pdf: true, lang: 'en', text: '# Plan\n\nFirst line.\n' }]) {
      const r = await approval(id, body)
      expect(r.status).toBe(409)
      expect(r.body.error).toBe('final_on_document_page')
    }
    expect(getWorkItem(id)?.status).not.toBe('done')
    expect(pdfsIn('Projektek/Iroda')).toEqual([])
  })

  it('a .txt that is not a note (a video\'s subtitles) gets no text PDF either: its finalize is the plain one of its kind', async () => {
    const id = mkNote('Projektek/Iroda/Film.txt', 'Film', 'video')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.final).toBeUndefined()
    expect(pdfsIn('Projektek/Iroda')).toEqual([])
  })

  it('an item without a text file keeps the bare status switch (no PDF)', async () => {
    const id = mkNote(null, 'Szabad jegyzet')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('done')
    expect(r.body.final).toBeUndefined()
  })

  it('only the owner click finalizes (an agent token is refused)', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const r = await approval(id, { action: 'finalize', pdf: true }, 'token')
    expect(r.status).toBe(403)
    expect(getWorkItem(id)?.status).not.toBe('done')
  })

  it('#803: a .markdown upload is a note too, so it is read onto the page like a .md', () => {
    expect(workItemTypeForFile('Terv.markdown')).toBe('note')
    expect(workItemTypeForFile('Terv.md')).toBe('note')
    expect(workItemTypeForFile('Terv.docx')).toBe('document')
  })

  it('#671: the Translation view still saves a language version (the item GET lists it)', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const saved = await callWorkbench(`/api/workbench/items/${id}/text-variant`, 'POST', { lang: 'en', text: 'Saved English body.' }, undefined, { kind: 'session', user: 'teszt' })
    expect(saved.status).toBe(201)
    const again = await callWorkbench(`/api/workbench/items/${id}/text-variant`, 'POST', { lang: 'en', text: 'Saved English body, v2.' }, undefined, { kind: 'session', user: 'teszt' })
    expect(again.status).toBe(200)
    expect(again.body.existing).toBe(true)
    expect(again.body.text_langs.variants).toHaveLength(1)
    const get = await callWorkbench(`/api/workbench/items/${id}`, 'GET', undefined, undefined, { kind: 'session', user: 'teszt' })
    expect(get.body.text_langs.variants.map((v: { lang: string }) => v.lang)).toEqual(['en'])
    const sib = getWorkItem(textLangState({ id }).variants[0]!.item_id)!
    expect(readFileSync(join(depot, sib.source_path!), 'utf-8')).toContain('Saved English body, v2.')
  })
})

// #803: the old note / Word finalize panel is gone from the page; whatever is on the document page opens the court panel.
describe('#803 one finalize for every document (frontend source)', () => {
  const js = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'workbench.js'), 'utf-8')
  it('the old note and Word finalize panels and their buttons are gone; only the spreadsheet keeps its own', () => {
    expect(js).not.toContain('workbench.notefinal.title')
    expect(js).not.toContain('workbench.docxfinal.title')
    expect(js).not.toContain('function docxFinalGo(')
    expect(js).not.toContain('function noteFinalLangHtml(')
    expect(js).not.toContain('function isDocxFinalItem(')
    expect(js).toContain('workbench.tablefinal.title')
  })
  it('the top Finalize opens the court panel for whatever stands on the document page', () => {
    expect(js).toMatch(/a === 'item-finalize' && WB\.detail && finalOnPage\(WB\.detail\.item\)\) \{ WB\.shFinal = !WB\.shFinal/)
    const top = js.match(/function finalizeTopHtml\(it, cls\) \{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(top).toContain('if (finalOnPage(it)) {')
    expect(top).toContain('data-wb-act="sh-final"')
  })
  it('a note / Word file not on the page yet says what to do and reads it in again; the error has a retry button', () => {
    expect(js).toMatch(/a === 'item-finalize' && WB\.detail && needsPage\(WB\.detail\.item\)\) \{[^\n]*workbench\.textdoc\.final_needs_page[^\n]*textImportRetry\(\)/)
    expect(js).toContain('data-wb-act="text-import-retry"')
    expect(js).toContain("else if (a === 'text-import-retry') textImportRetry()")
  })
  it('the spreadsheet panel is still brought into view on a phone', () => {
    const open = js.match(/else if \(a === 'item-finalize'\) \{[^\n]*/)?.[0] ?? ''
    expect(open).toContain('noteFinalScrollIn()')
    const helper = js.match(/function noteFinalScrollIn\(\) \{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(helper).toContain("querySelector('.wb-note-final')")
  })
})
