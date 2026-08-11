// Pure logic for file claims: who is allowed to edit which file right now
// (kanban 37129602).
//
// Why (Boss, 2026-08-11, twice): several agents work in ONE checkout, and
// nothing tells them when two of them open the same file. It is not theory --
// in a single evening web/app.js was being edited by the setup-wizard agent and
// by the Szakerto at the same time, and scripts/gold-data.py sat uncommitted
// from a third. The industry answer for 2026 is a worktree per agent, and that
// is layer A of this card; but a worktree cannot help the LIVE checkout the
// running install is served from, which is exactly where the collisions
// happened. So: a claim registry (layer B) that says who holds what, and a
// PreToolUse gate (layer C) that refuses an edit when someone else holds it.
//
// Two properties matter more than completeness:
//   - it must FAIL OPEN. A gate that blocks editing when the dashboard is down
//     would freeze the whole fleet, and this repo has already lived through one
//     silent fleet-freeze caused by a hook (see _TMP_PREFIXES in
//     agent-scaffold.ts). Every uncertain case resolves to "allowed".
//   - claims must EXPIRE. An agent that dies mid-edit must not lock a file
//     forever; the holder refreshes while it works, and a stale claim decays.
//
// This module is dependency-free so the decision is unit-testable without a
// database or a clock. The I/O lives in src/web/file-claims-store.ts.

/** How long a claim stays valid without being refreshed. Long enough to cover
 *  a slow edit-test cycle, short enough that a crashed agent frees the file
 *  before anyone is blocked for real. */
export const CLAIM_TTL_MS = 20 * 60_000

/** A live claim on one repo-relative path. */
export interface FileClaim {
  path: string
  agent: string
  claimedAt: number
  /** Free-text hint shown to whoever is blocked ("kanban 7951be7d"). */
  note: string | null
}

export type ClaimDecision =
  | { allowed: true; reason: 'free' | 'own' | 'expired' }
  | { allowed: false; reason: 'held'; holder: string; heldForMs: number; note: string | null }

/** True when a claim is old enough to be ignored. */
export function isClaimExpired(claim: Pick<FileClaim, 'claimedAt'>, now: number, ttlMs: number = CLAIM_TTL_MS): boolean {
  return now - claim.claimedAt >= ttlMs
}

/**
 * May `agent` edit a path that currently carries `existing`?
 *
 * A missing or expired claim is free. The agent's own claim is always fine --
 * that is the refresh path, and an agent must never be able to lock itself out.
 */
export function decideClaim(
  existing: FileClaim | null,
  agent: string,
  now: number,
  ttlMs: number = CLAIM_TTL_MS,
): ClaimDecision {
  if (!existing) return { allowed: true, reason: 'free' }
  if (existing.agent === agent) return { allowed: true, reason: 'own' }
  if (isClaimExpired(existing, now, ttlMs)) return { allowed: true, reason: 'expired' }
  return {
    allowed: false,
    reason: 'held',
    holder: existing.agent,
    heldForMs: now - existing.claimedAt,
    note: existing.note,
  }
}

// Paths nobody should ever be blocked on. Guarding them buys nothing and costs
// real deadlocks:
//   - an agent's OWN directory is private to it by construction;
//   - store/ is runtime state written by every agent constantly (claims,
//     snapshots, logs) -- claiming it would serialise the whole fleet;
//   - anything outside the repo is not shared work in the first place.
const NEVER_GUARDED = [
  /^store\//,
  /^logs?\//,
  /^node_modules\//,
  /^\.git\//,
  /(^|\/)\.env$/,
  /\.log$/,
  /(^|\/)HANDOFF\.md$/,
]

/**
 * Whether a repo-relative path takes part in claiming at all.
 *
 * `agentsOwnPrefix` is the editing agent's own directory (e.g.
 * "agents/lackor3/"), which is excluded for that agent only -- another agent
 * writing into someone else's agent directory IS a collision worth catching.
 */
export function isGuardedPath(relPath: string, agentsOwnPrefix: string | null): boolean {
  if (!relPath || relPath.startsWith('..')) return false
  if (agentsOwnPrefix && relPath.startsWith(agentsOwnPrefix)) return false
  return !NEVER_GUARDED.some(re => re.test(relPath))
}

/** Human sentence for a blocked edit. Written for the agent that reads it, so
 *  it says what to do rather than only what happened. */
export function describeBlock(path: string, holder: string, heldForMs: number, note: string | null): string {
  const mins = Math.max(1, Math.round(heldForMs / 60_000))
  const noteText = note ? ` (${note})` : ''
  return `A(z) ${path} fajlon most ${holder} dolgozik${noteText}, ${mins} perce. `
    + 'Ne ird felul: vagy varj amig elengedi, vagy egyeztess vele agens-uzenetben, '
    + 'vagy dolgozz sajat git worktree-ben (scripts/agent-worktree.sh) es merge-eld kesobb.'
}
