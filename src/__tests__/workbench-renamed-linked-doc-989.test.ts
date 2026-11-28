// #989: a PDF linked into a work item, renamed while it waited to be read and linked again, stayed "failed" for good
// (the failure of the OLD path was stored for the CONTENT), and the document buttons / endpoint did not work on a
// linked material at all, because they only knew paths inside the project folder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { startDocRead, docReadSummary, ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import { linkLifeFileAsUpload, withDocState, listWorkItemAssets } from '../workbench-assets.js'
import { which } from '../life-inbox-systools.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const FIXTURE = join(__dirname, 'fixtures', 'docread-mixed.pdf')
const haveReader = !!(which('pdftotext') && which('pdfinfo') && which('pdftoppm') && which('tesseract'))
const MAIL = 'From: a@example.invalid\nTo: b@example.invalid\nSubject: Termin\n\nDer Termin ist am Montag.\n'

let depot = ''
let pid = ''
const bank = () => join(depot, 'Penzugy', 'Bank')

beforeEach(() => {
  initDatabase(':memory:')
  depot = mkdtempSync(join(tmpdir(), 'marveen-wb-989-'))
  mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
  mkdirSync(bank(), { recursive: true })
  process.env['MARVEEN_DEPOT'] = depot
  const p = createProject({ name: 'Iroda' })
  if (!p.ok) throw new Error('project')
  pid = p.project.id
  updateProject(pid, { folder_path: 'Projektek/Iroda' })
})
afterEach(() => {
  rmSync(depot, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

function newItem(title = 'Level') {
  const w = createWorkItem({ project_id: pid, title, type: 'note' })
  if (!w.ok) throw new Error('item')
  return w.item
}

/** The reading starts under the old name and the file is renamed before its turn comes. */
async function readLostToRename(): Promise<{ sha: string; now: string }> {
  const old = join(bank(), 'old.eml')
  const now = join(bank(), 'new.eml')
  writeFileSync(old, MAIL)
  const s = startDocRead(old, 'old.eml')
  if (!s.ok) throw new Error(s.code)
  renameSync(old, now)
  await s.done
  return { sha: s.sha, now }
}

describe('a failure that belongs to the path does not stick to the content', () => {
  it('renamed while waiting: the next reading under the new name reads it', async () => {
    const { sha, now } = await readLostToRename()
    expect(docReadSummary(sha).status).toBe('stale')
    const again = startDocRead(now, 'new.eml')
    if (!again.ok) throw new Error(again.code)
    expect(again.started).toBe(true)
    await again.done
    expect(docReadSummary(sha)).toMatchObject({ status: 'done', error: null })
  })

  it('the read-life-file endpoint answers with the text, not with the old path', async () => {
    await readLostToRename()
    const url = `/api/workbench/read-life-file?rel=${encodeURIComponent('Penzugy/Bank/new.eml')}`
    const first = await callWorkbench(url, 'GET')
    expect([200, 202]).toContain(first.status)
    await vi.waitFor(async () => expect((await callWorkbench(url, 'GET')).status).toBe(200))
  })

  it('a failed row written before this fix (no stored path) is read again once', async () => {
    const abs = join(bank(), 'kept.eml')
    writeFileSync(abs, MAIL)
    ensureDocReadTables()
    const sha = sha256OfFile(abs)
    getDb().prepare(`INSERT INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
      VALUES (?, 'x.eml', 'email', 'failed', 0, 0, 'No such file', ?, 0)`).run(sha, DOCREAD_VERSION)
    const s = startDocRead(abs, 'kept.eml')
    if (!s.ok) throw new Error(s.code)
    await s.done
    expect(docReadSummary(sha).status).toBe('done')
  })

  it('a document that cannot be read while its file is there stays failed (no endless re-reading)', async () => {
    const abs = join(bank(), 'broken.pdf')
    writeFileSync(abs, 'this is not a PDF')
    const s = startDocRead(abs, 'broken.pdf')
    if (!s.ok) throw new Error(s.code)
    await s.done
    expect(docReadSummary(s.sha).status).toBe('failed')
    const again = startDocRead(abs, 'broken.pdf')
    expect(again.ok && again.started).toBe(false)
  })

  it('a material whose file is gone does not claim to be "being read"', async () => {
    const { now } = await readLostToRename()
    const item = newItem()
    const linked = linkLifeFileAsUpload(item, 'Penzugy/Bank/new.eml')
    if (!linked.ok) throw new Error(linked.code)
    rmSync(now)
    expect(withDocState(listWorkItemAssets(item.id))[0]).toMatchObject({ present: false, doc: null })
  })
})

describe('a linked material works with the document endpoint', () => {
  const REL = 'Penzugy/Bank/statement.pdf'
  function seed(abs: string): void {
    ensureDocReadTables()
    const sha = sha256OfFile(abs)
    getDb().prepare(`INSERT INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
      VALUES (?, 'statement.pdf', 'pdf', 'done', 1, 1, NULL, ?, 0)`).run(sha, DOCREAD_VERSION)
    getDb().prepare("INSERT INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, 1, 'Saldo 10 EUR', 'text', NULL, 0)").run(sha)
  }

  it('reads it and checks a quote by its Life-tree path; a path that is not on the list stays closed', async () => {
    const abs = join(depot, REL)
    writeFileSync(abs, 'PDF')
    seed(abs)
    const item = newItem()
    const other = newItem('Masik')
    expect(linkLifeFileAsUpload(item, REL).ok).toBe(true)
    const q = encodeURIComponent(REL)
    const ov = await callWorkbench(`/api/workbench/items/${item.id}/document?path=${q}`, 'GET')
    expect(ov.status).toBe(200)
    expect(ov.body.pages).toBe(1)
    const v = await callWorkbench(`/api/workbench/items/${item.id}/document/verify`, 'POST', { path: REL, page: 1, quote: 'Saldo 10 EUR' })
    expect(v.status).toBe(200)
    expect((await callWorkbench(`/api/workbench/items/${other.id}/document?path=${q}`, 'GET')).status).toBe(404)
    writeFileSync(join(bank(), 'secret.pdf'), 'x')
    const bad = await callWorkbench(`/api/workbench/items/${item.id}/document?path=${encodeURIComponent('Penzugy/Bank/secret.pdf')}`, 'GET')
    expect(bad.status).toBe(404)
  })

  it.skipIf(!haveReader)('the redacted copy of a linked original lands in the uploads folder of the item and joins its materials', async () => {
    copyFileSync(FIXTURE, join(depot, REL))
    const item = newItem()
    expect(linkLifeFileAsUpload(item, REL).ok).toBe(true)
    const r = await callWorkbench(`/api/workbench/items/${item.id}/document/redact`, 'POST', { path: REL, terms: ['Klage'], skip: [] })
    expect(r.status).toBe(201)
    expect(readdirSync(bank())).toEqual(['statement.pdf'])
    expect(r.body.path).toContain('/Feltöltések/')
    expect(existsSync(join(depot, 'Projektek', 'Iroda', r.body.path))).toBe(true)
    expect(r.body.assets.map((a: { name: string }) => a.name)).toContain(r.body.name)
  }, 120_000)

  it('the buttons beside a linked material carry its path (they were empty and did nothing)', async () => {
    const h = workbenchHarness()
    const ITEM = { id: 'w1', title: 'Level', type: 'note', status: 'draft', current_version_id: 'v1', folder: 'Level', source_path: null }
    const ASSETS = [{ id: 'a1', name: 'statement.pdf', path: REL, project_path: '', present: true, shared: false, support: 'readable',
      doc: { status: 'done', pages_total: 1, pages_done: 1, low_pages: [], ocr_pages: 1, error: null } }]
    h.respond((url) => {
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: ASSETS } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-assets-block'))
    expect(h.html()).toContain(`data-wb-act="redact-open" data-wb-path="${REL}"`)
    expect(h.html()).toContain(`data-wb-act="doc-searchable" data-wb-path="${REL}"`)
  })
})
