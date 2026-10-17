// #667 (Boss TG 9260): a work item whose file is a .md / .txt is finalized from a panel, and the finalize makes the PDF of
// the file into the item's Finished materials folder -- not just the bare "done" status.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { hasTextFinalPanel, isTextSourcePath } from '../workbench-notefinal.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { rmTempDir } from './helpers/rm-temp-dir.js'

const FAKE_SOFFICE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 tesztpeldany"; exit 0; fi
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"
done
printf '%%PDF-1.4 teszt' > "$out/doc.pdf"
exit 0
`

describe('#667 text-file work item: finalize makes the PDF', () => {
  let depot = ''
  let pid = ''
  const saved: Record<string, string | undefined> = {}
  const mkNote = (rel: string | null, title = 'Terv') => {
    const w = createWorkItem({ project_id: pid, title, type: 'note' })
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
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    writeFileSync(join(depot, 'Projektek', 'Iroda', 'Terv.md'), '# Terv\n\nElső sor.\n', 'utf-8')
  })

  afterEach(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    resetLibreOfficeProbe()
    rmTempDir(depot)
  })

  it('knows which files get the panel', () => {
    expect(isTextSourcePath('a/b/Terv (2).md')).toBe(true)
    expect(isTextSourcePath('a/b/jegyzet.TXT')).toBe(true)
    expect(isTextSourcePath('a/b/kep.png')).toBe(false)
    expect(isTextSourcePath(null)).toBe(false)
    expect(hasTextFinalPanel({ source_path: 'x/y.md' })).toBe(true)
    expect(hasTextFinalPanel({ source_path: null })).toBe(false)
  })

  it('the PDF lands in Finished materials and only then the item is done', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('done')
    expect(r.body.final.name).toMatch(/^Terv.*\.pdf$/)
    const abs = join(depot, r.body.final.path)
    expect(existsSync(abs)).toBe(true)
    expect(readFileSync(abs).subarray(0, 5).toString()).toBe('%PDF-')
    expect(r.body.final.path).toMatch(/Elkészített anyagok|Finished materials/)
    expect(getWorkItem(id)?.status).toBe('done')
  })

  it('a missing file stops it: no PDF, the item is not finalized, the message is a sentence', async () => {
    const id = mkNote('Projektek/Iroda/Nincs.md')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(500)
    expect(r.body.error).toBe('note_final_unreadable')
    expect(r.body.message.length).toBeGreaterThan(20)
    expect(getWorkItem(id)?.status).not.toBe('done')
  })

  it('a second finalize says it is already done, and the old PDF stays', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const a = await approval(id, { action: 'finalize', pdf: true })
    expect(a.status).toBe(200)
    const b = await approval(id, { action: 'finalize', pdf: true })
    expect(b.status).toBe(409)
    expect(b.body.error).toBe('note_final_already_done')
    expect(existsSync(join(depot, a.body.final.path))).toBe(true)
  })

  it('an item without a text file keeps the bare status switch (no PDF)', async () => {
    const id = mkNote(null, 'Szabad jegyzet')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('done')
    expect(r.body.final).toBeUndefined()
  })

  it('only the owner click makes the PDF (an agent token is refused)', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const r = await approval(id, { action: 'finalize', pdf: true }, 'token')
    expect(r.status).toBe(403)
    expect(getWorkItem(id)?.status).not.toBe('done')
    const dir = readdirSync(join(depot, 'Projektek', 'Iroda'))
    expect(dir.some((n) => /\.pdf$/i.test(n))).toBe(false)
  })
})
