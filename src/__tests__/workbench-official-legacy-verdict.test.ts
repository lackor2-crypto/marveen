// #861: an official source (statute, ruling) is accepted as given (#1635), but rows stored BEFORE that fix kept the old
// verdict 'unverified'. Every reader of the verdict (the outline screen, the finalized JSON, the quote check of the
// consistency check) must treat an official source as verified, and the old rows are migrated once.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import {
  addSection, addBlock, addClaim, documentCheck, documentOutline, listClaims, ensureDocModelTables, type SourceWorld,
} from '../workbench-docmodel.js'
import { consistencyIssues } from '../workbench-doccheck.js'

const world: SourceWorld = { resolveFile: () => null, ownerMessages: () => [] }

describe('#861 official source: legacy unverified rows', () => {
  let depot = ''
  let itemId = ''
  let blockId = ''

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-official-legacy-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Beadvany', type: 'document' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
    const s = addSection(itemId, '1. Jogi alap')
    if (!s.ok) throw new Error('section')
    const b = addBlock(itemId, s.section.id, { text: 'A határidő 2027. március 17-én jár le.', author: 'agent' })
    if (!b.ok) throw new Error('block')
    blockId = b.block.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function legacyOfficialClaim(quote: string): string {
    const r = addClaim(itemId, blockId, 'A határidő 2027. március 17-én jár le.', [
      { kind: 'official', citation: '§ 12 VwGO', url: 'https://www.gesetze-im-internet.de/vwgo/__12.html', quote },
    ], world, 'workbench-agent')
    if (!r.ok) throw new Error('claim')
    // what the program wrote before #1635
    getDb().prepare("UPDATE wb_doc_sources SET verdict = 'unverified', detail = 'not yet checked in the official source' WHERE claim_id = ?").run(r.claim.id)
    return r.claim.id
  }

  it('an old official row with verdict unverified reads as verified on the outline, the claim and the check', () => {
    legacyOfficialClaim('Frist bis 17. März 2027')
    const claim = listClaims(itemId)[0]
    expect(claim.strength).toBe('verified')
    expect(claim.sources[0].verdict).toBe('verified')
    const outlineClaim = documentOutline(itemId).sections[0].blocks[0].claims[0]
    expect(outlineClaim.sources[0].verdict).toBe('verified')
    expect(documentCheck(itemId).items.find((i) => i.key === 'unverified_references')).toMatchObject({ ok: true, count: 0, total: 1 })
  })

  it('the quote of an old official row is used by the consistency check (a date that does not match the quote is found)', () => {
    legacyOfficialClaim('Frist bis 20. April 2027')
    expect(consistencyIssues(itemId).some((i) => i.kind === 'claim_date_mismatch')).toBe(true)
  })

  it('the old rows are migrated once when the tables are opened', () => {
    const claimId = legacyOfficialClaim('Frist bis 17. März 2027')
    // a database that still holds the old verdict, opened again by a fresh start
    initDatabase(':memory:')
    const db = getDb()
    db.exec(`CREATE TABLE wb_doc_sources (id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT, page INTEGER, quote TEXT,
      citation TEXT, url TEXT, retrieved_at TEXT, said TEXT, said_at INTEGER, message_id TEXT, based_on TEXT, verdict TEXT NOT NULL, detail TEXT,
      checked_at INTEGER, confirmed_at INTEGER, confirmed_by TEXT, confirmed_text TEXT, created_at INTEGER NOT NULL)`)
    db.prepare("INSERT INTO wb_doc_sources (id, claim_id, kind, citation, url, verdict, created_at) VALUES ('s1', ?, 'official', '§ 12', 'https://x.example/', 'unverified', 1)").run(claimId)
    db.prepare("INSERT INTO wb_doc_sources (id, claim_id, kind, path, page, verdict, created_at) VALUES ('s2', ?, 'document', 'a.pdf', 1, 'not_found', 1)").run(claimId)
    ensureDocModelTables()
    const rows = db.prepare('SELECT id, verdict FROM wb_doc_sources ORDER BY id').all() as { id: string; verdict: string }[]
    expect(rows).toEqual([{ id: 's1', verdict: 'verified' }, { id: 's2', verdict: 'not_found' }])
  })
})
