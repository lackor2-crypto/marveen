/**
 * #396 Phase 1 -- the DB snapshot is consistent while the dashboard keeps
 * writing (the old backup.sh's checkpoint-then-tar could tear it).
 */
import { describe, it, expect, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotDatabase, inspectDatabaseFile } from '../backup/db-snapshot.js'
import { makeDb } from './backup-fixture.js'

const dir = mkdtempSync(join(tmpdir(), 'marveen-bk-db-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('snapshotDatabase', () => {
  it('stays consistent under 50 concurrent writes on the same handle', async () => {
    const src = join(dir, 'live.db')
    makeDb(src, 2000, 2000)
    const db = new Database(src)
    db.pragma('journal_mode = WAL')
    // ~4 MB, so the online backup takes many steps and the writer really
    // interleaves with it (a tiny DB is copied in one step).
    const bulk = db.prepare('INSERT INTO memories (content, agent_id) VALUES (?, ?)')
    db.transaction(() => { for (let i = 0; i < 2000; i++) bulk.run('y'.repeat(2000), 'bulk') })()
    const before = (db.prepare('SELECT count(*) n FROM memories').get() as { n: number }).n
    const ins = db.prepare('INSERT INTO memories (content, agent_id) VALUES (?, ?)')
    let writes = 0
    const timer = setInterval(() => { if (writes < 50) { ins.run('x'.repeat(2000), 'w'); writes++ } }, 0)
    try {
      const dest = join(dir, 'snap.db')
      const info = await snapshotDatabase(db, dest)
      expect(info.integrity).toBe('ok')
      expect(info.counts.memories).toBeGreaterThanOrEqual(before)
      expect(info.counts.kanban_cards).toBe(2000)
      expect(existsSync(dest + '-wal')).toBe(false)
      expect(inspectDatabaseFile(dest).integrity).toBe('ok')
      expect(writes).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
      db.close()
    }
  })

  it('from a file path (the CLI under the systemd timer), read-only', async () => {
    const src = join(dir, 'file.db')
    makeDb(src, 3, 4)
    const info = await snapshotDatabase(src, join(dir, 'file-snap.db'))
    expect(info).toMatchObject({ integrity: 'ok', counts: { kanban_cards: 3, memories: 4 } })
    expect(info.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the fingerprint changes when a column is added', async () => {
    const a = join(dir, 'fa.db'); makeDb(a, 1, 1)
    const b = join(dir, 'fb.db'); makeDb(b, 1, 1)
    const h = new Database(b); h.exec('ALTER TABLE kanban_cards ADD COLUMN extra TEXT'); h.close()
    const ia = await snapshotDatabase(a, join(dir, 'fa-s.db'))
    const ib = await snapshotDatabase(b, join(dir, 'fb-s.db'))
    expect(ia.schemaFingerprint).not.toBe(ib.schemaFingerprint)
  })
})
