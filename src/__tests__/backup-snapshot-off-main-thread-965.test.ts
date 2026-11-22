// #965: the dashboard's own database handle must never run the online backup itself -- one backup step held the event
// loop for 8.0 s on the 179 MB database (stall sampler: better-sqlite3 backup.js step). The copy goes through a
// read-only connection of its own (a worker thread in the compiled build).
import { describe, it, expect, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotDatabase } from '../backup/db-snapshot.js'
import { makeDb } from './backup-fixture.js'

const dir = mkdtempSync(join(tmpdir(), 'marveen-bk-965-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('snapshot of the dashboard handle (#965)', () => {
  it('does not call backup() on the live handle, and still copies everything', async () => {
    const src = join(dir, 'live.db')
    makeDb(src, 5, 7)
    const db = new Database(src)
    db.pragma('journal_mode = WAL')
    db.prepare('INSERT INTO memories (content, agent_id) VALUES (?, ?)').run('in the wal', 'w')
    const spy = vi.spyOn(db, 'backup')
    try {
      const info = await snapshotDatabase(db, join(dir, 'snap.db'))
      expect(spy).not.toHaveBeenCalled()
      expect(info.integrity).toBe('ok')
      expect(info.counts.kanban_cards).toBe(5)
      expect(info.counts.memories).toBe(8)
    } finally { db.close() }
  })

  it('the compiled build has a worker entry for the copy, wired from snapshotDatabase', () => {
    expect(existsSync(join(process.cwd(), 'src', 'backup', 'db-snapshot-worker.ts'))).toBe(true)
    const code = readFileSync(join(process.cwd(), 'src', 'backup', 'db-snapshot.ts'), 'utf8')
    expect(code).toContain("'db-snapshot-worker.js'")
    expect(code).toMatch(/copyDatabaseFileAsync\(typeof source === 'string' \? source : source\.name/)
  })
})
