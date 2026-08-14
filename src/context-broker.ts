// Pure logic for the context-broker designation (kanban 90d945b5).
//
// Motivation (Boss, 2026-08-13): the main assistant moves to a cheap model and
// becomes an orchestrator. Its job is no longer "be the brain" but "prepare the
// work package": understand the request, collect exactly the files/functions/
// errors that matter, and hand a small, task-specific package to whichever
// model is strong enough for the job. The expensive model should spend its
// tokens on thinking, not on grepping the machine.
//
// That role has to be assignable, not baked in: an account runs out of quota,
// a plan runs out of money, an agent is stopped. So the owner picks the broker
// with ONE checkbox on the agent card, and exactly one agent can hold it -- the
// designation is a single field here rather than a per-agent flag, so "only one
// at a time" is structural and cannot drift out of sync.
//
// The fallback chain is the other half of Boss's requirement: if the designated
// broker cannot work right now, the fleet must not sit and wait for it. Another
// running agent takes the role temporarily, and the resolution says WHY, so the
// dashboard can show it instead of silently behaving differently.
//
// I/O (reading the store, probing tmux, reading rate-limit snapshots) lives in
// src/web/context-broker-store.ts; this module is pure so it can be tested
// without a running fleet.

import { tierForPct, STALE_AFTER_MS, type RateLimitTier } from './rate-limit-status.js'

export interface BrokerConfig {
  /** Agent id designated as context broker, or null when nobody is. */
  designated: string | null
  /** Epoch ms of the last change, or null when never set. */
  updatedAt: number | null
  /**
   * Hand a delegate a FRESH window before the first command of a new task.
   *
   * Boss proposed this on 2026-08-14 and asked whether it was a bad idea. It is
   * a good one, and it is the piece that makes the role pay for itself: the
   * point of a generator is that the worker receives a small, curated packet,
   * and that only holds if the worker is not still carrying the last task. A
   * task handover is also the one moment where discarding context is safe --
   * the replacement arrives in the same breath.
   *
   * It is guarded, not blind: never on the generator itself (it would erase the
   * packet it just built), never on an agent that is working, has unread inbox
   * or has unfinished task state, and always followed immediately by the
   * packet. A clear with nothing behind it is amnesia, not a clean start.
   *
   * Default off. This wipes conversations, so it starts off and stays off until
   * someone deliberately turns it on.
   */
  cleanStart: boolean
  /**
   * Above this many seconds of expected work, an expensive agent should hand
   * the job back to the generator instead of running it itself.
   *
   * Boss, 2026-08-14: "a draga agent csak rovid kereseket indithat a gepen, de
   * ha hoszabb akkor adja vissza a kerest annak aki neki kiadta a parancsot."
   * The reasoning matches the design document: the expensive model's budget
   * should go on judgement, not on watching a build scroll past. Long output is
   * what actually fills a context window, and it is cheap to produce elsewhere.
   *
   * 0 disables the rule.
   */
  handBackAfterSeconds: number
  /**
   * Who does what in the pipeline. Each role is held by at most one agent, and
   * an agent may hold several.
   *
   * Deliberately NOT derived from the model. The owner ticks a box on a card,
   * and whatever runs behind that card -- Claude, GPT, Gemma, something added
   * next month -- holds the role. A rule that read model names would have
   * quietly excluded most of this fleet, and would need editing every time a
   * new provider arrives.
   *
   * null everywhere is the normal state: the generator then decides for itself
   * who to hand each piece of work to.
   */
  roles: BrokerRoles
}

/** The roles an agent can be given on its card. */
export const BROKER_ROLE_IDS = ['planner', 'implementer', 'checker'] as const
export type BrokerRoleId = typeof BROKER_ROLE_IDS[number]
export type BrokerRoles = Record<BrokerRoleId, string | null>

export const EMPTY_ROLES: BrokerRoles = { planner: null, implementer: null, checker: null }

function normalizeRoles(raw: unknown): BrokerRoles {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const out: BrokerRoles = { ...EMPTY_ROLES }
  for (const id of BROKER_ROLE_IDS) {
    const v = o[id]
    out[id] = (typeof v === 'string' && v.trim()) ? v.trim() : null
  }
  return out
}

/**
 * Give `agent` a role, or take it away. Returns a NEW map.
 *
 * Assigning is exclusive by construction: whoever held the role loses it in the
 * same value, so two cards can never both show themselves as the planner. This
 * is the same shape as the generator designation, and for the same reason --
 * the UI must not have to clear the other boxes itself.
 */
export function assignRole(roles: BrokerRoles, role: BrokerRoleId, agent: string | null): BrokerRoles {
  return { ...normalizeRoles(roles), [role]: (agent && agent.trim()) ? agent.trim() : null }
}

/** Every role `agent` currently holds, in a stable order. */
export function rolesOf(roles: BrokerRoles, agent: string): BrokerRoleId[] {
  return BROKER_ROLE_IDS.filter((id) => roles[id] === agent)
}

export const DEFAULT_BROKER_CONFIG: BrokerConfig = {
  designated: null,
  updatedAt: null,
  cleanStart: false,
  handBackAfterSeconds: 0,
  roles: { planner: null, implementer: null, checker: null },
}

export function normalizeBrokerConfig(raw: unknown): BrokerConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const designated = (typeof o.designated === 'string' && o.designated.trim()) ? o.designated.trim() : null
  const updatedAt = (typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) && o.updatedAt > 0)
    ? Math.floor(o.updatedAt)
    : null
  // Strictly true, like every other destructive switch here: a truthy string
  // from a hand-written request must not be enough to start wiping sessions.
  const cleanStart = o.cleanStart === true
  const rawSeconds = Number(o.handBackAfterSeconds)
  const handBackAfterSeconds = Number.isFinite(rawSeconds) && rawSeconds > 0
    ? Math.min(3600, Math.floor(rawSeconds))
    : 0
  return { designated, updatedAt, cleanStart, handBackAfterSeconds, roles: normalizeRoles(o.roles) }
}

export interface BrokerCandidate {
  agent: string
  /** Whether the agent's tmux session is alive right now. */
  running: boolean
  /** Worst usage percentage across the plan windows, or null when unknown. */
  usedPct: number | null
  /** Epoch ms of the usage snapshot, or null when there is none. */
  usageAt: number | null
}

export type BrokerReason =
  /** The designated agent holds the role and can work. */
  | 'designated'
  /** Designated agent is not running; someone else stands in. */
  | 'fallback-stopped'
  /** Designated agent is out of (or nearly out of) quota; someone else stands in. */
  | 'fallback-quota'
  /** Nobody is designated -- callers prepare their own context. */
  | 'unset'
  /** Somebody is designated but neither they nor any stand-in can work now. */
  | 'unavailable'

export interface BrokerResolution {
  /** Who the owner picked (what the checkbox shows). */
  designated: string | null
  /** Who actually does the work right now; null means "do it yourself". */
  effective: string | null
  reason: BrokerReason
  /** Set when effective !== designated: the agent that was stepped over. */
  steppedOver: string | null
}

/**
 * A candidate whose usage snapshot is older than this is treated as UNKNOWN
 * rather than as its frozen number: an idle agent stops writing statusline
 * snapshots, and a stale 96% would otherwise disqualify an agent that has long
 * since had its window reset.
 */
function effectiveTier(c: BrokerCandidate, now: number): RateLimitTier {
  if (c.usedPct === null) return 'normal'
  if (c.usageAt !== null && now - c.usageAt > STALE_AFTER_MS) return 'normal'
  return tierForPct(c.usedPct)
}

/** Usable = alive and not at the "no real work" end of its plan window. */
function usable(c: BrokerCandidate, now: number): boolean {
  return c.running && effectiveTier(c, now) !== 'critical'
}

/**
 * Rank stand-ins: most headroom first, unknown usage counted as plenty (an
 * agent that never reported is likelier fresh than exhausted), name as the
 * tiebreak so the pick is deterministic and the same across dashboard restarts.
 */
function rankStandIns(candidates: BrokerCandidate[], now: number, exclude: string): BrokerCandidate[] {
  return candidates
    .filter((c) => c.agent !== exclude && usable(c, now))
    .sort((a, b) => {
      const ap = a.usedPct === null ? -1 : a.usedPct
      const bp = b.usedPct === null ? -1 : b.usedPct
      return ap !== bp ? ap - bp : a.agent.localeCompare(b.agent)
    })
}

/**
 * Decide who brokers context right now.
 *
 * Fail-open by design: when there is no designation, or nobody can take it, the
 * answer is `effective: null`, which the skill reads as "prepare your own
 * context". A coordination convenience must never be able to stop the fleet --
 * this repo has already survived one silent fleet freeze caused by a helper
 * that failed closed.
 */
export function resolveBroker(
  cfg: BrokerConfig,
  candidates: BrokerCandidate[],
  now: number = Date.now(),
): BrokerResolution {
  const designated = cfg.designated
  if (!designated) return { designated: null, effective: null, reason: 'unset', steppedOver: null }

  const self = candidates.find((c) => c.agent === designated) || null
  if (self && usable(self, now)) {
    return { designated, effective: designated, reason: 'designated', steppedOver: null }
  }

  const standIn = rankStandIns(candidates, now, designated)[0] || null
  if (!standIn) {
    return { designated, effective: null, reason: 'unavailable', steppedOver: designated }
  }

  // "Not running" is reported ahead of quota: a stopped agent is the thing the
  // owner can act on, and an agent that is both stopped and near its limit is
  // stopped first as far as anyone can tell from outside.
  const reason: BrokerReason = (!self || !self.running) ? 'fallback-stopped' : 'fallback-quota'
  return { designated, effective: standIn.agent, reason, steppedOver: designated }
}
