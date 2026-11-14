// #824: the store/ bookkeeping of the live browser suite, kept in one place so it can be unit-tested.
//
// The disposable server writes into THIS checkout's store/ (the path is fixed in src/config.ts). Besides the database and the
// token it leaves rate-limit-status/, locks/, cache/ ... behind. The teardown used to remove only the database and the token,
// so a vitest run in the same checkout afterwards read that leftover usage history and the code-bridge limit tests went red
// (measured 2026-11-14: code-bridge-limit-hold, 2 tests). The marker therefore records what store/ held BEFORE the server
// started, and the teardown removes everything that was not there.
import fs from 'node:fs'
import path from 'node:path'

export const MARKER_NAME = '.browser-live-owned'

interface Marker { startedAt: number; before: string[] }

function readMarker(marker: string): Marker | null {
  try {
    const j = JSON.parse(fs.readFileSync(marker, 'utf8'))
    if (j && Array.isArray(j.before)) return { startedAt: Number(j.startedAt) || 0, before: j.before.map(String) }
  } catch { /* legacy marker (a bare timestamp) or unreadable */ }
  return null
}

/** Called before the server starts. Returns an error text when store/ holds a database this suite did not create. */
export function prepareStore(store: string, now = Date.now()): { refuse?: string } {
  fs.mkdirSync(store, { recursive: true })
  const marker = path.join(store, MARKER_NAME)
  const dbFile = path.join(store, 'claudeclaw.db')
  if (fs.existsSync(marker)) {
    // a crashed earlier run of this suite: its leftovers are ours, and the old snapshot stays the truth
    cleanStore(store)
  } else if (fs.existsSync(dbFile)) {
    return { refuse: 'REFUSING: ' + dbFile + ' exists and was not created by the live browser suite (a live install?). Run the suite from a clean checkout / worktree.' }
  }
  const before = fs.readdirSync(store).filter((f) => f !== MARKER_NAME)
  fs.writeFileSync(marker, JSON.stringify({ startedAt: now, before } satisfies Marker))
  return {}
}

/** Removes what the suite's server created in store/ -- only when the suite's own marker is there, so a live install is never touched. */
export function cleanStore(store: string): void {
  const marker = path.join(store, MARKER_NAME)
  if (!fs.existsSync(marker)) return
  const snap = readMarker(marker)
  for (const f of fs.readdirSync(store)) {
    if (f === MARKER_NAME) continue
    // legacy marker: no snapshot, so only the two files the first version of the suite is known to create
    const ours = snap ? !snap.before.includes(f) : (f.startsWith('claudeclaw.db') || f === '.dashboard-token')
    if (ours) fs.rmSync(path.join(store, f), { recursive: true, force: true })
  }
  fs.rmSync(marker, { force: true })
}
