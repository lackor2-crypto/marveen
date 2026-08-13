// I/O for the context-broker designation (kanban 90d945b5).
//
// The designation is ONE field in ONE file, not a per-agent flag map: the owner
// checks a box on an agent card, and checking another one has to clear the
// first. Storing a single name makes "only one at a time" true by construction,
// so no client-side clearing pass can leave two agents both believing they hold
// the role.
//
// Pure decision logic lives in ../context-broker.ts; this module reads the
// store, probes who is actually alive, and reads the plan-usage snapshots that
// the statusline hook writes at zero token cost.

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { listAgentNames } from './agent-config.js'
import { agentSessionName, sessionExistsOnHost } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { readRateLimitSnapshot } from './rate-limit-status-io.js'
import {
  normalizeBrokerConfig,
  resolveBroker,
  DEFAULT_BROKER_CONFIG,
  type BrokerCandidate,
  type BrokerConfig,
  type BrokerResolution,
} from '../context-broker.js'

const STORE_PATH = join(PROJECT_ROOT, 'store', 'context-broker.json')

/** The designation as stored; nobody designated by default. */
export function readBrokerConfig(): BrokerConfig {
  try {
    return normalizeBrokerConfig(JSON.parse(readFileSync(STORE_PATH, 'utf-8')))
  } catch {
    return { ...DEFAULT_BROKER_CONFIG }
  }
}

/**
 * Designate an agent, or pass null to leave the role empty. Writing the whole
 * file (rather than merging) is the point: the previous holder is cleared in
 * the same atomic write that names the new one.
 */
export function writeBrokerConfig(designated: string | null): BrokerConfig {
  const cfg = normalizeBrokerConfig({ designated, updatedAt: Date.now() })
  atomicWriteFileSync(STORE_PATH, JSON.stringify(cfg, null, 2))
  return cfg
}

/** Every agent that could hold the role: the main orchestrator and the fleet. */
export function listBrokerCandidateNames(): string[] {
  return [MAIN_AGENT_ID, ...listAgentNames()]
}

function hasLiveSession(agent: string): boolean {
  const session = agent === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(agent)
  return sessionExistsOnHost(null, session)
}

/**
 * Live view of one agent: is it running, and how much of its plan window is
 * gone. The percentage is the worse of the 5h and 7d windows -- an agent whose
 * weekly window is spent cannot broker context however fresh its 5-hour one is.
 */
export function readBrokerCandidate(agent: string): BrokerCandidate {
  const snap = readRateLimitSnapshot(agent)
  const windows = [snap?.fiveHour?.usedPct ?? null, snap?.sevenDay?.usedPct ?? null]
    .filter((p): p is number => p !== null)
  // The fuller window decides: an agent whose weekly window is spent cannot
  // broker context however fresh its 5-hour one looks.
  const usedPct = windows.length ? Math.max(...windows) : null
  return {
    agent,
    running: hasLiveSession(agent),
    usedPct,
    usageAt: snap?.updatedAt && snap.updatedAt > 0 ? snap.updatedAt : null,
  }
}

export function listBrokerCandidates(): BrokerCandidate[] {
  return listBrokerCandidateNames().map(readBrokerCandidate)
}

/** Who brokers context right now, and why -- see resolveBroker for the rules. */
export function resolveEffectiveBroker(now: number = Date.now()): BrokerResolution {
  return resolveBroker(readBrokerConfig(), listBrokerCandidates(), now)
}
