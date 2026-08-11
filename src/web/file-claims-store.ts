// Storage for file claims (see src/file-claims.ts for the why).
//
// One row per path: the claim IS the current holder, so a claim by a new agent
// after expiry simply replaces it. Kept in the shared SQLite database rather
// than a JSON file because several agent processes write concurrently, and
// better-sqlite3's single-writer locking is exactly the serialisation this
// needs -- two agents claiming the same path in the same millisecond must not
// both win.
import { getDb } from '../db.js'
import { CLAIM_TTL_MS, decideClaim, type ClaimDecision, type FileClaim } from '../file-claims.js'

let ensured = false

/** Created lazily: this table is only touched by installs that use the gate,
 *  and keeping it out of the main schema keeps the fork's diff small. */
function ensureTable(): void {
  if (ensured) return
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS file_claims (
      path TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      note TEXT
    )
  `)
  ensured = true
}

function rowToClaim(row: { path: string; agent: string; claimed_at: number; note: string | null }): FileClaim {
  return { path: row.path, agent: row.agent, claimedAt: row.claimed_at, note: row.note }
}

export function readClaim(path: string): FileClaim | null {
  ensureTable()
  const row = getDb().prepare('SELECT path, agent, claimed_at, note FROM file_claims WHERE path = ?').get(path) as
    { path: string; agent: string; claimed_at: number; note: string | null } | undefined
  return row ? rowToClaim(row) : null
}

/** Every claim still inside its TTL, newest first. */
export function listLiveClaims(now: number = Date.now(), ttlMs: number = CLAIM_TTL_MS): FileClaim[] {
  ensureTable()
  const rows = getDb()
    .prepare('SELECT path, agent, claimed_at, note FROM file_claims WHERE claimed_at > ? ORDER BY claimed_at DESC')
    .all(now - ttlMs) as Array<{ path: string; agent: string; claimed_at: number; note: string | null }>
  return rows.map(rowToClaim)
}

/**
 * Claim a path for an agent, or report who holds it.
 *
 * The read and the write happen in ONE transaction: without it two agents can
 * both see "free" and both write, which is the very race the registry exists to
 * prevent.
 */
export function claimPath(
  path: string,
  agent: string,
  note: string | null = null,
  now: number = Date.now(),
  ttlMs: number = CLAIM_TTL_MS,
): ClaimDecision {
  ensureTable()
  const db = getDb()
  const tx = db.transaction((): ClaimDecision => {
    const row = db.prepare('SELECT path, agent, claimed_at, note FROM file_claims WHERE path = ?').get(path) as
      { path: string; agent: string; claimed_at: number; note: string | null } | undefined
    const decision = decideClaim(row ? rowToClaim(row) : null, agent, now, ttlMs)
    if (decision.allowed) {
      db.prepare(
        `INSERT INTO file_claims (path, agent, claimed_at, note) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET agent = excluded.agent, claimed_at = excluded.claimed_at, note = excluded.note`,
      ).run(path, agent, now, note)
    }
    return decision
  })
  return tx()
}

/** Release one path (only the holder may), or every path an agent holds. */
export function releaseClaims(agent: string, path?: string): number {
  ensureTable()
  const db = getDb()
  const result = path
    ? db.prepare('DELETE FROM file_claims WHERE path = ? AND agent = ?').run(path, agent)
    : db.prepare('DELETE FROM file_claims WHERE agent = ?').run(agent)
  return result.changes
}

/** Drop expired rows. Cheap indexed delete; keeps the table from growing. */
export function sweepExpiredClaims(now: number = Date.now(), ttlMs: number = CLAIM_TTL_MS): number {
  ensureTable()
  return getDb().prepare('DELETE FROM file_claims WHERE claimed_at <= ?').run(now - ttlMs).changes
}
