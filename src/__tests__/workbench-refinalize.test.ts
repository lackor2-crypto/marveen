// #737 (Boss TG 4102): a court-style document that is finalized, reopened and finalized AGAIN without a change must
// finalize again; when a PDF step fails, the real error text reaches the screen (the toast), not only the short sentence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { markPlainItem } from '../workbench-assets.js'
import { addSection, addBlock } from '../workbench-docmodel.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

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

describe('#737 ujra-veglegesites', () => {
  let depot = ''
  let itemId = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-refinal-'))
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    const fake = join(depot, 'fake-soffice.sh')
    writeFileSync(fake, FAKE_SOFFICE, 'utf-8')
    chmodSync(fake, 0o755)
    process.env['MARVEEN_SOFFICE'] = fake
    resetLibreOfficeProbe()
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Sozialamt Pflegesituation', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    const s = addSection(itemId, '1. Tény', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'Sehr geehrte Frau Jäckle,', author: 'owner' })
    addBlock(itemId, s.section.id, { kind: 'signature', text: 'Chemnitz, 2026.\n\nBakos', author: 'owner' })
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    resetLibreOfficeProbe()
    rmSync(depot, { recursive: true, force: true })
  })

  async function review(): Promise<string> {
    const base = `/api/workbench/items/${itemId}/outline`
    const o = (await callWorkbench(base, 'GET')).body.outline
    await callWorkbench(`${base}/pdf?review=${o.content_hash}`, 'GET')
    return o.content_hash as string
  }

  it('finalize, reopen, finalize again with no change succeeds', async () => {
    const base = `/api/workbench/items/${itemId}/outline`
    const h1 = await review()
    const f1 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: h1, override: true })
    expect(f1.status, JSON.stringify(f1.body)).toBe(200)
    const re = await callWorkbench(`/api/workbench/items/${itemId}/approval`, 'POST', { action: 'reopen' })
    expect(re.status, JSON.stringify(re.body)).toBe(200)
    const h2 = await review()
    const f2 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: h2, override: true })
    expect(f2.status, JSON.stringify(f2.body)).toBe(200)
  })

  it('#738: finalizing an UNCHANGED document again puts no second PDF into the Finished materials; a changed one does', async () => {
    const base = `/api/workbench/items/${itemId}/outline`
    const pdfs = (): string[] => {
      const out: string[] = []
      const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.pdf$/i.test(e.name)) out.push(f) } }
      walk(join(depot, 'Projektek'))
      return out
    }
    const f1 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f1.status, JSON.stringify(f1.body)).toBe(200)
    expect(pdfs().length).toBe(1)
    expect((await callWorkbench(`/api/workbench/items/${itemId}/approval`, 'POST', { action: 'reopen' })).status).toBe(200)
    const f2 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f2.status, JSON.stringify(f2.body)).toBe(200)
    expect(pdfs().length).toBe(1)
    expect(f2.body.reused).toBe(true)
    expect(f1.body.reused).toBe(false)
    expect(f2.body.file ?? f2.body.asset_path ?? '').toBe(f1.body.file ?? f1.body.asset_path ?? '')
    // a real change makes a new PDF again
    expect((await callWorkbench(`/api/workbench/items/${itemId}/approval`, 'POST', { action: 'reopen' })).status).toBe(200)
    const sec = (await callWorkbench(base, 'GET')).body.outline.sections[0]
    addBlock(itemId, sec.id, { text: 'Noch ein Satz.', author: 'owner' })
    const f3 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f3.status, JSON.stringify(f3.body)).toBe(200)
    expect(pdfs().length).toBe(2)
  })

  /** The case of Boss TG 4102: a plain item (#717) made from a Word file whose file link is gone (the Word import clears it). */
  function makePlainWithoutFile(container: string): void {
    markPlainItem(itemId)
    getDb().prepare('UPDATE work_items SET source_path = NULL, folder = NULL, container_folder = ? WHERE id = ?').run(container, itemId)
  }

  it('a plain item without a file link finalizes into the Finished materials of the folder it is listed in (no new folder)', async () => {
    const dir = join(depot, 'Projektek', 'Iroda', 'Munkadarabok', 'Level')
    mkdirSync(join(dir, 'Elkészített anyagok'), { recursive: true })
    makePlainWithoutFile('Munkadarabok/Level')
    const before = readdirSync(join(depot, 'Projektek', 'Iroda', 'Munkadarabok')).sort()
    const base = `/api/workbench/items/${itemId}/outline`
    const f = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f.status, JSON.stringify(f.body)).toBe(200)
    expect(f.body.file).toMatch(/Munkadarabok\/Level\/Elkészített anyagok\/[^/]+\.pdf$/)
    expect(existsSync(join(depot, f.body.file))).toBe(true)
    expect(readdirSync(join(depot, 'Projektek', 'Iroda', 'Munkadarabok')).sort()).toEqual(before)
    // ... and again after a reopen, nothing changed
    expect((await callWorkbench(`/api/workbench/items/${itemId}/approval`, 'POST', { action: 'reopen' })).status).toBe(200)
    const f2 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f2.status, JSON.stringify(f2.body)).toBe(200)
  })

  it('a plain item without a file link that is listed in the project folder itself finalizes there (the root is a folder too)', async () => {
    makePlainWithoutFile('@project')
    const base = `/api/workbench/items/${itemId}/outline`
    const f = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f.status, JSON.stringify(f.body)).toBe(200)
    // as for a linked plain item at the root (finishedFolderFor has no subfolder there): the PDF lies in the folder itself, no folder is made
    expect(f.body.file).toMatch(/^Projektek\/Iroda\/[^/]+\.pdf$/)
    expect(existsSync(join(depot, f.body.file))).toBe(true)
    expect(readdirSync(join(depot, 'Projektek', 'Iroda'), { withFileTypes: true }).filter((e) => e.isDirectory())).toEqual([])
  })

  it('Boss\'s real shape: accented project path, listed folder with no Finished materials yet; finalize, reopen, finalize again, and again after the PDF was deleted', async () => {
    const project = join(depot, 'Család', 'Korpás László', 'Projektek', 'Német hivatalok dolgai')
    const listed = 'Munkadarabok/Szochivatal Bakos Eva/Szocialis hivatalnak email AOK elutasitas ugyben'
    mkdirSync(join(project, listed), { recursive: true })
    const row = getDb().prepare('SELECT project_id FROM work_items WHERE id = ?').get(itemId) as { project_id: string }
    updateProject(row.project_id, { folder_path: 'Család/Korpás László/Projektek/Német hivatalok dolgai' })
    makePlainWithoutFile(listed)
    const base = `/api/workbench/items/${itemId}/outline`
    const f1 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f1.status, JSON.stringify(f1.body)).toBe(200)
    expect(existsSync(join(depot, f1.body.file))).toBe(true)
    expect((await callWorkbench(`/api/workbench/items/${itemId}/approval`, 'POST', { action: 'reopen' })).status).toBe(200)
    const f2 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f2.status, JSON.stringify(f2.body)).toBe(200)
    expect(f2.body.reused).toBe(true)
    // the earlier PDF was deleted by hand: the unchanged document is made again, not an error
    rmSync(join(depot, f1.body.file))
    expect((await callWorkbench(`/api/workbench/items/${itemId}/approval`, 'POST', { action: 'reopen' })).status).toBe(200)
    const f3 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f3.status, JSON.stringify(f3.body)).toBe(200)
    expect(existsSync(join(depot, f3.body.file))).toBe(true)
  })

  it('when the folder is really gone the answer says so in a sentence and carries the exact error', async () => {
    makePlainWithoutFile('Munkadarabok/Nincs')
    const base = `/api/workbench/items/${itemId}/outline`
    const f = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: await review(), override: true })
    expect(f.status).toBe(409)
    expect(f.body.error).toBe('docpdf_folder_unreachable')
    expect(f.body.message).toContain('mappája nem érhető el')
    expect(f.body.detail).toContain('unreachable')
  })

  it('the screen shows the exact error: the finalize toasts use the text with the detail', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
    expect(js).toMatch(/text: why && message\.indexOf\(why\) < 0/)
    expect((js.match(/window\.showToast\(r\.text \|\| r\.message\)/g) || []).length).toBeGreaterThanOrEqual(5)
    for (const f of ['hu', 'en']) expect(readFileSync(join(__dirname, '..', '..', 'web', 'lang', f + '.js'), 'utf-8')).toContain('"workbench.err.detail"')
  })
})
