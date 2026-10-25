// #779: a document written on the document page (court document, a note or a Word file read onto it) exports what the
// page shows -- the Export panel used to read the old "parts" and said "this work item has no content yet".
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, listPendingApprovals } from '../db.js'
import { _setSendDeps } from '../workbench-export.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { contentHash, finalizeDocument, recordReview } from '../workbench-docfinal.js'
import { listSent } from '../workbench-docsent.js'
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
    _setSendDeps({ accounts: () => [{ id: 'iroda', address: 'en@pelda.hu', kind: 'mailbox' }], send: async (account) => ({ ok: true, account, kind: 'mailbox', address: 'en@pelda.hu', messageId: 'x' }) })
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
  // #797: a finalized document sent from the Export panel is a sending of that final on the "Sent" log (date, recipient, by e-mail).
  it('the owner\'s Send of a finalized document goes on the Sent log as a sending of the final', async () => {
    if (!(await probeLibreOffice()).available) return
    const it0 = getWorkItem(itemId)!
    const hash = contentHash(it0)
    recordReview(itemId, hash, 'owner')
    const f = await finalizeDocument(it0, { accept: true, hash, by: 'owner', lang: 'hu' })
    if (!f.ok) throw new Error('finalize ' + f.code + ' ' + f.detail)
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'birosag@example.com', subject: 'Fellebbezés', attachment: 'html' })
    expect(r.status).toBe(201)
    expect(r.body.sent_logged).toBe('recorded')
    const log = listSent(itemId)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ recipient: 'birosag@example.com', method: 'email', reference: 'Fellebbezés' })
    expect(log[0].note).toContain('en@pelda.hu')
  }, 180_000)
})
