// #777 (Boss TG 2026-10-24: "Nem kell atkotni semmit, a birosagi oldalt kell helyette hasznalni. Butitott valtozatban."):
// a note read onto the document page (text profile) is finalized by the court document's OWN route (/outline/finalize,
// review -> tick -> final PDF in Finished materials), and the separate note panel (#667) refuses it, so a fix in the court
// finalize reaches every document. Runs on an empty in-memory DB with a fake LibreOffice: a fresh install behaves the same.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { addBlock, addSection } from '../workbench-docmodel.js'
import { isWordImported } from '../workbench-worddoc.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { rmTempDir } from './helpers/rm-temp-dir.js'

const FAKE_SOFFICE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 tesztpeldany"; exit 0; fi
out=""; prev=""; filter=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  if [ "$prev" = "--convert-to" ]; then filter="$a"; fi
  prev="$a"
done
case "$filter" in
  docx*) printf 'PK-docx %s' "$filter" > "$out/doc.docx" ;;
  *) printf '%%PDF-1.4 %s' "$filter" > "$out/doc.pdf" ;;
esac
exit 0
`

describe('#777 the text profile finalizes on the court document route', () => {
  let depot = ''
  let pid = ''
  const dirRel = 'Projektek/Iroda'
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-tpfinal-'))
    mkdirSync(join(depot, dirRel), { recursive: true })
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) saved[k] = process.env[k]
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
    updateProject(pid, { folder_path: dirRel })
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetLibreOfficeProbe()
    rmTempDir(depot)
  })

  const mkNote = (name: string, text: string, title = 'Terv') => {
    writeFileSync(join(depot, dirRel, name), text, 'utf-8')
    const w = createWorkItem({ project_id: pid, title, type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(`${dirRel}/${name}`, w.item.id)
    return getWorkItem(w.item.id)!
  }

  it('the separate note panel refuses a text-profile note; the court finalize makes the final PDF and closes the item', async () => {
    const note = mkNote('Terv.md', '# Terv\n\n## Első\n\nEgy bekezdés **félkövérrel**.\n')
    expect((await callWorkbench(`/api/workbench/items/${note.id}/text-import`, 'POST', {})).status).toBe(201)

    const old = await callWorkbench(`/api/workbench/items/${note.id}/approval`, 'POST', { action: 'finalize', pdf: true })
    expect(old.status).toBe(409)
    expect(old.body.error).toBe('final_on_document_page')
    expect(getWorkItem(note.id)!.status).not.toBe('done')

    const base = `/api/workbench/items/${note.id}/outline`
    const hash = (await callWorkbench(base, 'GET')).body.outline.content_hash as string
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect((await callWorkbench(`${base}/pdf?review=${hash}`, 'GET')).status).toBe(200)
    const fin = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash })
    expect(fin.status).toBe(200)
    expect(fin.body.ok).toBe(true)
    // The final PDF is the court document's PDF/A, from the page (not the raw text file), in Finished materials.
    expect(fin.body.final.pdfa).toBe(true)
    expect(String(fin.body.file)).toMatch(/\.pdf$/)
    expect(getWorkItem(note.id)!.status).toBe('done')
  })

  it('a Word file read onto the page is finalized the same way (its own Word panel refuses it)', async () => {
    writeFileSync(join(depot, dirRel, 'Antwort.docx'), 'PK-docx', 'utf-8')
    const w = createWorkItem({ project_id: pid, title: 'Antwort', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(`${dirRel}/Antwort.docx`, w.item.id)
    // What the Word import leaves behind: the page's outline and the import mark (the real import needs LibreOffice).
    const sec = addSection(w.item.id, 'Antwort')
    if (!sec.ok) throw new Error('fejezet')
    expect(addBlock(w.item.id, sec.section.id, { kind: 'paragraph', text: 'Sehr geehrte Damen und Herren.', author: 'owner' }).ok).toBe(true)
    isWordImported(w.item.id)
    getDb().prepare("INSERT INTO wb_word_import (work_item_id, warnings, imported_at) VALUES (?, '[]', 1)").run(w.item.id)

    const old = await callWorkbench(`/api/workbench/items/${w.item.id}/approval`, 'POST', { action: 'finalize', pdf: true })
    expect(old.status).toBe(409)
    expect(old.body.error).toBe('final_on_document_page')

    const base = `/api/workbench/items/${w.item.id}/outline`
    const hash = (await callWorkbench(base, 'GET')).body.outline.content_hash as string
    expect((await callWorkbench(`${base}/pdf?review=${hash}`, 'GET')).status).toBe(200)
    const fin = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash })
    expect(fin.status).toBe(200)
    expect(fin.body.final.pdfa).toBe(true)
    expect(getWorkItem(w.item.id)!.status).toBe('done')
  })

  it('a note NOT on the document page keeps its own panel (nothing else can finalize it)', async () => {
    const note = mkNote('Vazlat.md', 'Csak egy sor.\n', 'Vázlat')
    const r = await callWorkbench(`/api/workbench/items/${note.id}/approval`, 'POST', { action: 'finalize', pdf: true })
    expect(r.body.error).not.toBe('final_on_document_page')
  })
})
