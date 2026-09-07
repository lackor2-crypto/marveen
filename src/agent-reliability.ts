// Pure logic for the free-agent "reliability" badge (kanban 502005f0). Boss,
// 2026-08-09: the badge measures whether an agent can be dispatched
// SUCCESSFULLY at all (no 429/402/crash/never-responds) -- NOT the quality
// of what it says. A verification request that got a 'pass' or a 'fail'
// answer both count as a successful dispatch here; only a request that never
// got ANY answer back (still 'pending' long after it should have replied)
// counts against the score.
import type { ApprovalVerification } from './db.js'
import { NO_RESPONSE_NOT_WAITING } from './approval-verification-sweep.js'

/** A pending verification older than this is presumed dead (provider error,
 *  crash, rate-limit -- something kept the agent from ever calling back),
 *  not "still thinking". Verification prompts are short review tasks. */
export const STUCK_PENDING_THRESHOLD_MS = 10 * 60 * 1000

export interface ReliabilityScore {
  /** 0-10, higher = more usable. null when there isn't enough history yet. */
  score: number | null
  sampleSize: number
  okCount: number
  stuckCount: number
}

/**
 * rows: an agent's approval_verifications, most-recent-first (as returned by
 * getRecentVerificationsForAgent). nowMs only affects still-'pending' rows.
 */
export function computeReliabilityScore(rows: ApprovalVerification[], nowMs: number): ReliabilityScore {
  let okCount = 0
  let stuckCount = 0
  for (const row of rows) {
    if (row.status === 'pass' || row.status === 'fail') {
      okCount++
      continue
    }
    // 'noresponse' (2026-08-23): the sweep already decided this one never came
    // back. Count it directly instead of re-deriving it from the age, so the
    // badge agrees with what the approvals page shows.
    if (row.status === 'noresponse') {
      // KIVETEL: a sor nem azert zarult le, mert az agens hallgatott, hanem
      // mert a MUNKA szunt meg alatta (a kartya kikerult a varakozobol, vagy
      // megszuletett a dontes -- Boss 2026-09-07). Ezt sem mellette, sem
      // ellene nem szamoljuk: egy visszavont feladat elmulasztasat felrona a
      // jelzo, holott az agensnek semmi dolga nem volt vele.
      if (row.report === NO_RESPONSE_NOT_WAITING) continue
      stuckCount++
      continue
    }
    // status === 'pending'
    const ageMs = nowMs - row.requested_at * 1000
    if (ageMs >= STUCK_PENDING_THRESHOLD_MS) stuckCount++
    // else: legitimately still in flight -- neither counted for nor against.
  }
  const sampleSize = okCount + stuckCount
  if (sampleSize === 0) return { score: null, sampleSize: 0, okCount, stuckCount }
  const score = Math.round((okCount / sampleSize) * 10)
  return { score, sampleSize, okCount, stuckCount }
}
