// #674 (Boss TG 9357): a spreadsheet work item is finalized from a panel; the workbook (and a PDF, when LibreOffice is there)
// lands in the item's Finished materials folder -- not just the bare "done" status. Notes keep their own path (#667).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { hasTableFinalPanel } from '../workbench-tablefinal.js'
import { hasTextFinalPanel } from '../workbench-notefinal.js'
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

describe('#674 table work item: finalize puts the workbook into Finished materials', () => {
  let depot = ''
  let pid = ''
  const saved: Record<string, string | undefined> = {}
  const XLSX = Buffer.from('PK\u0003\u0004 teszt-munkafuzet')
  const mk = (rel: string | null) => {
    const w = createWorkItem({ project_id: pid, title: 'Koltsegvetes', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    if (rel) getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(rel, w.item.id)
    return w.item.id
  }
  const approval = (id: string, body: unknown, kind = 'session') =>
    callWorkbench(`/api/workbench/items/${id}/approval`, 'POST', body, undefined, kind === 'session' ? { kind: 'session', user: 'teszt' } : { kind })
  const setup = (soffice: string | null) => {
    if (soffice) { writeFileSync(join(depot, 'fake-soffice.sh'), soffice, 'utf-8'); chmodSync(join(depot, 'fake-soffice.sh'), 0o755); process.env['MARVEEN_SOFFICE'] = join(depot, 'fake-soffice.sh') }
    else process.env['MARVEEN_SOFFICE'] = join(depot, 'nincs-ilyen-soffice')
    resetLibreOfficeProbe()
  }

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-tablefinal-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    writeFileSync(join(depot, 'Projektek', 'Iroda', 'Koltsegvetes.xlsx'), XLSX)
  })

  afterEach(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    resetLibreOfficeProbe()
    rmTempDir(depot)
  })

  it('knows which items get the table panel and leaves the note panel alone', () => {
    expect(hasTableFinalPanel({ source_path: 'a/b.xlsx' })).toBe(true)
    expect(hasTableFinalPanel({ source_path: 'a/b.CSV' })).toBe(true)
    expect(hasTableFinalPanel({ source_path: 'a/b.md' })).toBe(false)
    expect(hasTableFinalPanel({ source_path: 'a/b.docx' })).toBe(false)
    expect(hasTableFinalPanel({ source_path: null })).toBe(false)
    expect(hasTextFinalPanel({ source_path: 'a/b.xlsx' })).toBe(false)
  })

  it('with LibreOffice: the xlsx and a PDF land in Finished materials, then the item is done', async () => {
    setup(FAKE_SOFFICE)
    const id = mk('Projektek/Iroda/Koltsegvetes.xlsx')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('done')
    expect(r.body.final.name).toBe('Koltsegvetes.xlsx')
    expect(r.body.final.pdf_name).toBe('Koltsegvetes.pdf')
    expect(r.body.final.pdf_note).toBe('made')
    expect(r.body.final.path).toMatch(/Elkészített anyagok|Finished materials/)
    expect(readFileSync(join(depot, r.body.final.path)).equals(XLSX)).toBe(true)
    const dir = join(depot, r.body.final.path, '..')
    expect(readdirSync(dir).sort()).toEqual(['Koltsegvetes.pdf', 'Koltsegvetes.xlsx'])
    expect(getWorkItem(id)?.status).toBe('done')
  })

  it('#738: finalizing an UNCHANGED workbook again makes no twin in Finished materials; a changed one is saved anew', async () => {
    setup(FAKE_SOFFICE)
    const id = mk('Projektek/Iroda/Koltsegvetes.xlsx')
    const r1 = await approval(id, { action: 'finalize', pdf: true })
    expect(r1.status).toBe(200)
    const dir = join(depot, r1.body.final.path, '..')
    expect(readdirSync(dir).sort()).toEqual(['Koltsegvetes.pdf', 'Koltsegvetes.xlsx'])
    expect((await approval(id, { action: 'reopen' })).status).toBe(200)
    const r2 = await approval(id, { action: 'finalize', pdf: true })
    expect(r2.status).toBe(200)
    expect(r2.body.final.path).toBe(r1.body.final.path)
    expect(r2.body.final.pdf_name).toBe('Koltsegvetes.pdf')
    expect(r2.body.final.pdf_note).toBe('made')
    expect(readdirSync(dir).sort()).toEqual(['Koltsegvetes.pdf', 'Koltsegvetes.xlsx'])
    // a real change makes a new copy (and a new PDF) again
    writeFileSync(join(depot, 'Projektek', 'Iroda', 'Koltsegvetes.xlsx'), Buffer.concat([XLSX, Buffer.from(' valtozott')]))
    expect((await approval(id, { action: 'reopen' })).status).toBe(200)
    const r3 = await approval(id, { action: 'finalize', pdf: true })
    expect(r3.status).toBe(200)
    expect(r3.body.final.path).not.toBe(r1.body.final.path)
    expect(readdirSync(dir).length).toBe(4)
  })

  it('without LibreOffice: the xlsx still lands, the answer says no PDF was made', async () => {
    setup(null)
    const id = mk('Projektek/Iroda/Koltsegvetes.xlsx')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('done')
    expect(r.body.final.pdf_name).toBeNull()
    expect(r.body.final.pdf_note).toBe('no_converter')
    expect(existsSync(join(depot, r.body.final.path))).toBe(true)
  })

  it('a csv has no PDF conversion but is finalized with its file', async () => {
    setup(FAKE_SOFFICE)
    writeFileSync(join(depot, 'Projektek', 'Iroda', 'adat.csv'), 'a;b\n1;2\n', 'utf-8')
    const id = mk('Projektek/Iroda/adat.csv')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.final.name).toBe('adat.csv')
    expect(r.body.final.pdf_note).toBe('not_convertible')
  })

  it('a missing file stops it: nothing is finalized and the message is a sentence', async () => {
    setup(null)
    const id = mk('Projektek/Iroda/Nincs.xlsx')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(500)
    expect(getWorkItem(id)?.status).not.toBe('done')
    expect(String(r.body.message)).toMatch(/nem olvasható|cannot be read/)
  })

  it('finalizing twice is refused, and an agent cannot finalize', async () => {
    setup(null)
    const id = mk('Projektek/Iroda/Koltsegvetes.xlsx')
    expect((await approval(id, { action: 'finalize', pdf: true }, 'agent')).status).toBe(403)
    expect((await approval(id, { action: 'finalize', pdf: true })).status).toBe(200)
    expect((await approval(id, { action: 'finalize', pdf: true })).status).toBe(409)
  })

  it('the bare finalize (no pdf flag) still works as before', async () => {
    setup(null)
    const id = mk('Projektek/Iroda/Koltsegvetes.xlsx')
    const r = await approval(id, { action: 'finalize' })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('done')
    expect(r.body.final).toBeUndefined()
  })
})
