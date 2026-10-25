// #441 (v4 spec 1/A, K-1.7 ... K-1.16, K-1.22): dokumentummodell es forrasrendszer.
// A kitalalt teny vagy hivatkozas technikailag ne kerulhessen be: minden
// tenyallitasnak igazolt forrasa van, a tulajdonos kozlese csak a SAJAT
// kattintasaval kerulhet a vegleges iratba.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import {
  addSection, addBlock, updateBlock, addClaim, confirmOwnerClaim, documentCheck, documentOutline, claimStrength,
  updateSection, removeSection, listClaims, type SourceWorld, type SourceRow,
} from '../workbench-docmodel.js'
import { ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import { ensureAgentTables } from '../workbench-agent/sessions.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const P1 = 'Landgericht Berlin. Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr.'

function seedRead(abs: string, name: string, pages: string[]): void {
  ensureDocReadTables()
  const sha = sha256OfFile(abs)
  const db = getDb()
  db.prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
    VALUES (?, ?, 'pdf', 'done', ?, ?, NULL, ?, 0)`).run(sha, name, pages.length, pages.length, DOCREAD_VERSION)
  pages.forEach((t, i) => db.prepare('INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, ?, ?, \'text\', NULL, 0)').run(sha, i + 1, t))
}

describe('#794 attachment fallback for owner-said claims', () => {
  let depot = ''
  let itemId = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const world = (): SourceWorld => ({
    resolveFile: () => null,
    ownerMessages: () => [],
    itemDocuments: () => [{ path: 'Level/idezes.pdf', abs: join(projDir(), 'Level', 'idezes.pdf'), name: 'idezes.pdf' }],
  })
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-docmodel794-'))
    mkdirSync(join(projDir(), 'Level'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Level', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    writeFileSync(join(projDir(), 'Level', 'idezes.pdf'), 'PDF')
    seedRead(join(projDir(), 'Level', 'idezes.pdf'), 'idezes.pdf', ['Seite eins', P1])
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('an owner-said claim whose words stand in an attached document becomes a document source', () => {
    const s = addSection(itemId, '2. T')
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(itemId, s.section.id, { text: 'Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr.', author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    const r = addClaim(itemId, b.block.id, 'Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr.', [{ kind: 'owner', said: 'Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr' }], world(), null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.claim.sources[0]).toMatchObject({ kind: 'document', verdict: 'verified', path: 'Level/idezes.pdf', page: 2 })
  })

  it('words that are in no attachment stay not_in_chat', () => {
    const s = addSection(itemId, '2. T')
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(itemId, s.section.id, { text: 'Ez sehol nincs leirva.', author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    const r = addClaim(itemId, b.block.id, 'Ez sehol nincs leirva.', [{ kind: 'owner', said: 'Ez sehol nincs leirva' }], world(), null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.claim.sources[0]).toMatchObject({ kind: 'owner', verdict: 'not_in_chat' })
  })
})
