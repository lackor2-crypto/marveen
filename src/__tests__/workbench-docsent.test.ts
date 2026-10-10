// #530, phase 3: "Sent" is not "Final", and the sent copy is filed in the archive.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, createWorkItemVersion, getWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock } from '../workbench-docmodel.js'
import { contentHash } from '../workbench-docfinal.js'
import { fileOfficialCopy, listSent, recordSent, removeSent } from '../workbench-docsent.js'
import { listProjectDocs, updateProjectDoc, linkedUsesUnder } from '../workbench-doc-links.js'

describe('sent', () => {
  let depot = ''
  let pid = ''
  let item: WorkItemRow
  const abs = (rel: string) => join(depot, ...rel.split('/'))
  const OUT = 'Család/Anna/Hatóságok/Jobcenter/Kimenő'

  /** A final version the way finalizeDocument leaves one: the PDF in the project folder, the hash in the version. */
  function finalise(): void {
    writeFileSync(abs('Projektek/Ügy/Fellebbezés – Végleges.pdf'), 'FINAL-PDF-BYTES')
    const v = createWorkItemVersion(item.id, { metadata_json: JSON.stringify({ final: true, label: 'Végleges – 2026-10-08', content_hash: contentHash(item), pdf_path: 'Fellebbezés – Végleges.pdf', pdf_name: 'Fellebbezés – Végleges.pdf', files: [{ path: 'Fellebbezés – Végleges.pdf', name: 'Fellebbezés – Végleges.pdf', role: 'main' }], accepted_by: 'owner', accepted_at: 1, accepted_text: '', reviewed_at: 1, reviewed_by: 'owner', check: [] }) })
    if (!v.ok) throw new Error('version ' + v.code)
    item = getWorkItem(item.id) as WorkItemRow
  }

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-docsent-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(abs('Projektek/Ügy'), { recursive: true })
    mkdirSync(abs(OUT), { recursive: true })
    const p = createProject({ name: 'Jobcenter ügy' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Ügy' })
    const w = createWorkItem({ project_id: pid, title: 'Fellebbezés', type: 'document' })
    if (!w.ok) throw new Error('item')
    const s = addSection(w.item.id, '1. Tényállás', { status: 'done' })
    if (!s.ok) throw new Error('section')
    addBlock(w.item.id, s.section.id, { text: 'Fellebbezek.', author: 'owner' })
    item = getWorkItem(w.item.id) as WorkItemRow
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const good = { date: '2026-10-08', time: '14:30', recipient: 'Jobcenter Berlin Mitte', method: 'email', reference: 'RR123' }

  it('a draft cannot be marked as sent; a final can, with when / to whom / how', () => {
    const none = recordSent(item, good, 'owner')
    expect(none.ok === false && none.code).toBe('no_final')
    finalise()
    const r = recordSent(item, good, 'owner')
    expect(r.ok).toBe(true)
    expect(listSent(item.id).map((x) => [x.sent_date, x.sent_time, x.recipient, x.method, x.reference, x.final_label, x.filed_rel])).toEqual([
      ['2026-10-08', '14:30', 'Jobcenter Berlin Mitte', 'email', 'RR123', 'Végleges – 2026-10-08', null],
    ])
  })

  it('a final the document has changed since is not marked as sent: it would not be known which version went out', () => {
    finalise()
    const s = addSection(item.id, '2. Kérelem', { status: 'done' })
    if (!s.ok) throw new Error('section')
    item = getWorkItem(item.id) as WorkItemRow
    const r = recordSent(item, good, 'owner')
    expect(r.ok === false && r.code).toBe('final_stale')
  })

  it('refuses a day that does not exist, a bad time, a missing recipient and an unknown method', () => {
    finalise()
    for (const bad of [{ ...good, date: '2026-02-30' }, { ...good, date: '08.10.2026' }, { ...good, time: '25:00' }, { ...good, recipient: '   ' }, { ...good, method: 'pigeon' }, { ...good, recipient: 'x'.repeat(301) }]) {
      const r = recordSent(item, bad, 'owner')
      expect(r.ok === false && r.code).toBe('bad_input')
    }
    expect(listSent(item.id)).toEqual([])
    // The time and the method are optional.
    expect(recordSent(item, { date: '2026-10-08', recipient: 'Sozialamt' }, 'owner').ok).toBe(true)
    expect(listSent(item.id)[0]!.method).toBe('other')
  })

  it('the same final can go to two recipients; one recorded by mistake is taken back', () => {
    finalise()
    const a = recordSent(item, good, 'owner')
    const b = recordSent(item, { ...good, recipient: 'Sozialgericht', method: 'registered_post' }, 'owner')
    if (!a.ok || !b.ok) throw new Error('record')
    expect(listSent(item.id).length).toBe(2)
    expect(removeSent(item.id, a.id).ok).toBe(true)
    expect(removeSent(item.id, a.id).ok).toBe(false)
    expect(removeSent('masik', b.id).ok).toBe(false)
    expect(listSent(item.id).map((x) => x.recipient)).toEqual(['Sozialgericht'])
  })

  it('files the official copy in the chosen folder under a readable name, overwrites nothing, and the project lists it as official', async () => {
    finalise()
    const a = recordSent(item, good, 'owner')
    const b = recordSent(item, { ...good, recipient: 'Sozialgericht' }, 'owner')
    if (!a.ok || !b.ok) throw new Error('record')
    writeFileSync(abs(`${OUT}/Fellebbezés – 2026-10-08.pdf`), 'SOMETHING-ELSE-ALREADY-THERE')
    const f1 = await fileOfficialCopy(item, a.id, OUT, 'owner')
    if (!f1.ok) throw new Error(f1.code + ' ' + f1.detail)
    expect(f1.rel).toBe(`${OUT}/Fellebbezés – 2026-10-08 (2).pdf`)
    expect(readFileSync(abs(`${OUT}/Fellebbezés – 2026-10-08.pdf`), 'utf8')).toBe('SOMETHING-ELSE-ALREADY-THERE')
    expect(readFileSync(abs(f1.rel), 'utf8')).toBe('FINAL-PDF-BYTES')
    // The working copy in the project folder is still there: filing copies, it does not move.
    expect(readdirSync(abs('Projektek/Ügy'))).toContain('Fellebbezés – Végleges.pdf')
    const again = await fileOfficialCopy(item, a.id, OUT, 'owner')
    expect(again.ok === false && again.code).toBe('already_filed')
    const f2 = await fileOfficialCopy(item, b.id, OUT, 'owner')
    expect(f2.ok && f2.rel).toBe(`${OUT}/Fellebbezés – 2026-10-08 (3).pdf`)
    const sent = listSent(item.id)
    expect(sent.every((x) => x.filed_exists === true)).toBe(true)
    const docs = listProjectDocs(pid).docs
    expect(docs.map((d) => [d.role, d.exists]).sort()).toEqual([['official', true], ['official', true]])
    expect(docs[0]!.note).toMatch(/2026-10-08/)
    // An official document keeps its role.
    const ch = updateProjectDoc(pid, docs[0]!.id, { role: 'source' })
    expect(ch.ok === false && ch.code).toBe('bad_role')
    expect(linkedUsesUnder(OUT).map((u) => u.label)).toEqual(['official', 'official'])
  })

  it('refuses a folder that is not there, a path outside the tree, and the tree\'s root', async () => {
    finalise()
    const a = recordSent(item, good, 'owner')
    if (!a.ok) throw new Error('record')
    for (const [folder, code] of [['Család/Nincs', 'folder_missing'], ['../..', 'bad_input'], ['', 'bad_input'], [`${OUT}/x.pdf`, 'folder_missing']] as const) {
      const r = await fileOfficialCopy(item, a.id, folder, 'owner')
      expect(r.ok === false && r.code).toBe(code)
    }
    expect(listSent(item.id)[0]!.filed_rel).toBeNull()
    expect((await fileOfficialCopy(item, 'nincs', OUT, 'owner')).ok).toBe(false)
  })

  it('says so when the final PDF is no longer in the work item folder', async () => {
    finalise()
    const a = recordSent(item, good, 'owner')
    if (!a.ok) throw new Error('record')
    rmSync(abs('Projektek/Ügy/Fellebbezés – Végleges.pdf'))
    const r = await fileOfficialCopy(item, a.id, OUT, 'owner')
    expect(r.ok === false && r.code).toBe('final_file_missing')
    expect(readdirSync(abs(OUT))).toEqual([])
  })
})
