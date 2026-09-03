// An EXISTING install must gain the 'withdrawn' approval status, and the rows
// already in it must survive untouched.
//
// Boss, 2026-09-03: a pending kanban_done approval was resolved as 'timeout'
// when its card LEFT the waiting column, even though nothing timed out
// (timeout_at was null) -- it was withdrawn by the move. An approval that read
// "Lejárt" and vanished looked like a spontaneous expiry. 'withdrawn' is now a
// real terminal status; adding it needs a table rebuild because the status
// CHECK constraint is part of the schema (SQLite cannot ALTER a CHECK).
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, listApprovals, resolveApproval } from '../db.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// The shape the live board was on before 'withdrawn' -- the CHECK lists only
// the four older statuses. resolution_reason is present (it is ALTER-added
// early in initDatabase, so by the time the withdrawn rebuild runs it exists).
const PRE_WITHDRAWN = `CREATE TABLE approvals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
  action_description TEXT NOT NULL, action_payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','timeout')),
  timeout_at INTEGER, telegram_message_id INTEGER,
  requested_at INTEGER NOT NULL DEFAULT (unixepoch()), resolved_at INTEGER, resolved_by TEXT,
  resolution_reason TEXT)`

function oldDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ap-wd-mig-'))
  dirs.push(dir)
  const file = join(dir, 'old.db')
  const db = new Database(file)
  db.exec(PRE_WITHDRAWN)
  db.prepare(`INSERT INTO approvals (id,agent_id,category,action_description,status,requested_at,resolved_at,resolved_by,resolution_reason)
              VALUES ('pnd','lackor2-bot','kanban_done','Kártya: valami (aa55180c)','pending',111,NULL,NULL,NULL)`).run()
  db.prepare(`INSERT INTO approvals (id,agent_id,category,action_description,status,requested_at,resolved_at,resolved_by,resolution_reason)
              VALUES ('done','lackor2-bot','kanban_done','Kártya: mas (bb66291d)','approved',100,120,'Boss','ok')`).run()
  db.close()
  return file
}

describe('migrating a pre-withdrawn approvals database', () => {
  it('keeps every existing row, with its fields intact', () => {
    initDatabase(oldDb())
    const rows = listApprovals({})
    expect(rows).toHaveLength(2)
    const done = rows.find(r => r.id === 'done')!
    expect(done.status).toBe('approved')
    expect(done.resolved_by).toBe('Boss')
    expect(done.resolution_reason).toBe('ok')
    expect(done.requested_at).toBe(100)
  })

  it("accepts a 'withdrawn' resolution after the upgrade (the CHECK was rebuilt)", () => {
    const file = oldDb()
    initDatabase(file)
    // The whole point: the pending row can now be resolved as withdrawn.
    expect(resolveApproval('pnd', 'withdrawn', 'lackor2-bot', null, 'a kártya elmozdult')).toBe(true)
    expect(listApprovals({}).find(r => r.id === 'pnd')!.status).toBe('withdrawn')
  })

  it('still rejects a bogus status -- the constraint is not lost on upgrade', () => {
    const file = oldDb()
    initDatabase(file)
    const raw = new Database(file)
    try {
      expect(() => raw.prepare(
        `INSERT INTO approvals (id,agent_id,category,action_description,status,requested_at) VALUES ('z','a','kanban_done','x','bogus',1)`,
      ).run()).toThrow()
    } finally {
      raw.close()
    }
  })

  it('is idempotent -- opening the database again changes nothing', () => {
    const file = oldDb()
    initDatabase(file)
    const before = listApprovals({})
    initDatabase(file)
    expect(listApprovals({})).toEqual(before)
  })
})
