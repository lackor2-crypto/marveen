// An EXISTING install must pick up the `mode` column, and the rows already in
// it must come out as what they actually were: read-only reviews.
//
// The reason this is a rebuild and not a plain ALTER: SQLite cannot attach a
// CHECK constraint to an added column. Without the rebuild a fresh install
// would reject a bogus mode and an upgraded one would store it -- the same
// code behaving differently depending on how old the database is, which is
// precisely the kind of difference that stays invisible until it matters.
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, listApprovalVerifications, createOrResetApprovalVerification } from '../db.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Writes an OLD-shaped database and returns its path. */
function oldDb(ddl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'av-mig-'))
  dirs.push(dir)
  const file = join(dir, 'old.db')
  const db = new Database(file)
  db.exec(ddl)
  db.prepare(`INSERT INTO approval_verifications (id,approval_id,agent,status,report,requested_at,resolved_at)
              VALUES ('x','a1','gemma','pass','regi sor',111,222)`).run()
  db.prepare(`INSERT INTO approval_verifications (id,approval_id,agent,status,requested_at)
              VALUES ('y','a1','north','pending',333)`).run()
  db.close()
  return file
}

const PRE_NORESPONSE = `CREATE TABLE approval_verifications (
  id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pass','fail')),
  report TEXT, requested_at INTEGER NOT NULL DEFAULT (unixepoch()), resolved_at INTEGER,
  UNIQUE(approval_id, agent))`

// The shape the live board was actually on when the mode was added.
const PRE_MODE = `CREATE TABLE approval_verifications (
  id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pass','fail','noresponse')),
  report TEXT, requested_at INTEGER NOT NULL DEFAULT (unixepoch()), resolved_at INTEGER,
  reminded_at INTEGER, UNIQUE(approval_id, agent))`

describe.each([
  ['a pre-noresponse database', PRE_NORESPONSE],
  ['a database that has noresponse but no mode', PRE_MODE],
])('migrating %s', (_label, ddl) => {
  it('keeps every row, with its report and timestamps intact', () => {
    const file = oldDb(ddl)
    initDatabase(file)
    const rows = listApprovalVerifications('a1')
    expect(rows).toHaveLength(2)
    const gemma = rows.find(r => r.agent === 'gemma')!
    expect(gemma.report).toBe('regi sor')
    expect(gemma.status).toBe('pass')
    expect(gemma.requested_at).toBe(111)
    expect(gemma.resolved_at).toBe(222)
  })

  it("backfills every existing row as 'verify' -- which is what they were", () => {
    const file = oldDb(ddl)
    initDatabase(file)
    expect(listApprovalVerifications('a1').map(r => r.mode)).toEqual(['verify', 'verify'])
  })

  it('accepts a fix row afterwards, and rejects a mode that is neither', () => {
    const file = oldDb(ddl)
    initDatabase(file)
    createOrResetApprovalVerification('a1', 'code:proj', 'fix')
    expect(listApprovalVerifications('a1').find(r => r.agent === 'code:proj')!.mode).toBe('fix')

    const raw = new Database(file)
    try {
      expect(() => raw.prepare(
        `INSERT INTO approval_verifications (id,approval_id,agent,mode,requested_at) VALUES ('z','a1','q','bogus',1)`,
      ).run()).toThrow()
    } finally {
      raw.close()
    }
  })

  it('is idempotent -- opening the database again changes nothing', () => {
    const file = oldDb(ddl)
    initDatabase(file)
    createOrResetApprovalVerification('a1', 'code:proj', 'fix')
    const before = listApprovalVerifications('a1')
    initDatabase(file)
    expect(listApprovalVerifications('a1')).toEqual(before)
  })
})
