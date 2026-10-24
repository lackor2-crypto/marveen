// #779: a document written on the document page (court document, a note or a Word file read onto it) exports what the
// page shows -- the Export panel used to read the old "parts" and said "this work item has no content yet".
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, listPendingApprovals } from '../db.js'
import { _setSendDeps } from '../workbench-export.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addBlock, addSection } from '../workbench-docmodel.js'
import { probeLibreOffice } from '../office-convert.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

// Own render cache = own LibreOffice profile (see workbench-export-doc.test.ts: a shared profile fails under parallel workers).
let cacheDir = ''
let savedCache: string | undefined
beforeAll(() => {
  savedCache = process.env['MARVEEN_RENDER_CACHE']
  cacheDir = mkdtempSync(join(tmpdir(), 'wb-export-docpage-'))
  process.env['MARVEEN_RENDER_CACHE'] = cacheDir
})
afterAll(() => {
  if (savedCache === undefined) delete process.env['MARVEEN_RENDER_CACHE']
  else process.env['MARVEEN_RENDER_CACHE'] = savedCache
  rmSync(cacheDir, { recursive: true, force: true })
})

describe('#779 export of a document-page work item', () => {
  let depot = ''
  let itemId = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-exp-docpage-'))
    mkdirSync(join(depot, 'Projektek', 'ugy'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_WORKBENCH_EXPORTS'] = join(depot, 'exports-store')
    const p = createProject({ name: 'Bírósági ügy' })
    if (!p.ok) throw new Error('project')
    updateProject(p.project.id, { folder_path: 'Projektek/ugy' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Fellebbezés', type: 'document' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
    const s = addSection(itemId, 'Kérelem')
    if (!s.ok) throw new Error('section')
    addBlock(itemId, s.section.id, { text: 'Tisztelt Bíróság, a végzés ellen fellebbezést nyújtok be.', author: 'owner' })
    _setSendDeps({ mailerReady: () => null, mailer: async () => ({ ok: true, messageId: 'x' }) })
  })
  afterEach(() => {
    _setSendDeps()
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
    delete process.env['MARVEEN_WORKBENCH_EXPORTS']
  })

  it('the printable page (PDF / print, HTML) carries the page text, not "no content yet"', async () => {
    if (!(await probeLibreOffice()).available) return
    const r = await callWorkbench(`/api/workbench/items/${itemId}/export.html`, 'GET')
    expect(r.status).toBe(200)
    const html = r.raw.toString('utf-8')
    expect(html).toContain('fellebbezést nyújtok be')
    expect(html).toContain('Kérelem')
    expect(html).not.toContain('még nincs tartalom')
  }, 120_000)

  it('a word-processor format (txt) carries the page text', async () => {
    if (!(await probeLibreOffice()).available) return
    const r = await callWorkbench(`/api/workbench/items/${itemId}/export-doc?fmt=txt`, 'GET')
    expect(r.status).toBe(200)
    expect(r.raw.toString('utf-8')).toContain('fellebbezést nyújtok be')
  }, 120_000)

  it('Send attaches the page text too (the same page as the export)', async () => {
    if (!(await probeLibreOffice()).available) return
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'ugyfel@example.com', subject: 'Fellebbezés', message: 'Csatolva.', attachment: 'html' }, undefined, { kind: 'token' })
    expect(r.status).toBe(201)
    const ap = listPendingApprovals().find((a) => a.category === 'email_send')
    expect(ap).toBeTruthy()
    const payload = JSON.parse(ap?.action_payload || '{}')
    expect(readFileSync(payload.input.attachment_path, 'utf-8')).toContain('fellebbezést nyújtok be')
  }, 120_000)
})
