// Role-based automatic context nullification (kartya #275).
//
// When an agent hands out role-based work (planner / implementer / checker), the
// participants must start from a clean window: a curated work package is worth
// little if the receiver is still carrying the previous task, and a handover is
// the one moment where dropping context is safe, because the replacement arrives
// with it. Before #275 this was a MANUAL instruction printed to the generator
// (broker-role.py CLEAN_START), acted on one agent at a time, by hand. This
// module makes it ONE call: resolve the role holders, spare the dispatcher, and
// /clear the rest -- each guarded exactly like the manual per-agent button.
//
// The safeguards, in one place so no path can forget one:
//   - NEVER the dispatcher (self). Its context is the package it just built.
//     Enforced structurally in the pure planRoleClear() -- the dispatcher is
//     removed before any I/O, so it cannot be cleared even by a bug here.
//   - Only an IDLE pane. sendPromptToSession waits for the pane to idle and,
//     with onBusyTimeout:'abort', sends NOTHING into a busy pane -- mid-turn
//     protection so a working agent never loses a half-finished turn.
//   - Host-aware and exact-target. The send routes through runTmux ->
//     buildTmuxInvocation, which is ssh-wrapped per the agent's host and
//     normalises every -t target to its exact form (the nemotronnano vs
//     nemotronnano9 prefix hazard, see tmux-target.ts).
//   - Unprocessed inbox is not silently wiped. A holder whose local drain queue
//     still holds inbound is reported needs-confirm and skipped unless force.
//
// Fresh-install: with an empty store the roles are all null, so planRoleClear
// returns nothing and clearRoleParticipants clears nobody -- a valid state, not
// an error. The report distinguishes "nobody assigned" (assignedCount 0) from a
// holder that is assigned but has no reachable panel ('not-running'): the zero
// means two different things and the caller can tell them apart.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir, readAgentRemoteHost } from './agent-config.js'
import { isMainChannelsAgent, MAIN_CHANNELS_SESSION } from './main-agent.js'
import { agentSessionName, isAgentRunning, sendPromptToSession } from './agent-process.js'
import { readBrokerConfig } from './context-broker-store.js'
import { planRoleClear, type BrokerRoleId } from '../context-broker.js'
import { logger } from '../logger.js'

/**
 * Count the sub-agent's unprocessed inbound messages sitting in its local drain
 * queue. Both inbox-pending.jsonl AND inbox-draining-*.jsonl count -- an
 * interrupted earlier drain leaves a claimed draining file that still holds real
 * messages (lackor3, 2026-08-11). Provider-agnostic: sweeps every channel dir.
 * A /clear would discard whatever is counted here, so the callers gate on it.
 */
export function countPendingInbox(name: string): number {
  try {
    const chDir = join(agentDir(name), '.claude', 'channels')
    if (!existsSync(chDir)) return 0
    let count = 0
    for (const provider of readdirSync(chDir)) {
      const dir = join(chDir, provider)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      let files: string[] = []
      try { files = readdirSync(dir) } catch { files = [] }
      for (const f of files) {
        if (f === 'inbox-pending.jsonl' || f.startsWith('inbox-draining-')) {
          try {
            count += readFileSync(join(dir, f), 'utf-8').split('\n').filter((l) => l.trim()).length
          } catch { /* unreadable file -> ignore */ }
        }
      }
    }
    return count
  } catch { return 0 }
}

export type ClearOutcome =
  /** /clear was sent into an idle pane. */
  | 'cleared'
  /** The pane never idled within the budget, so nothing was sent (mid-turn protection). */
  | 'busy'
  /** Unprocessed inbound would be lost; skipped unless force:true. */
  | 'needs-confirm'
  /** No live session/panel to send into (stopped or unknown agent). */
  | 'not-running'
  /** A vscode:<project> code-bridge role holder -- it has no tmux panel to clear. */
  | 'no-panel-code-bridge'
  /** The send threw (tmux/ssh failure). */
  | 'error'

export interface ClearResult { outcome: ClearOutcome; pending?: number }

/**
 * Clear one agent's conversation, with every guard the manual per-agent button
 * applies. Shared so the role-based sweep and the single-agent button cannot
 * drift apart on what "safe to clear" means. `force` skips only the inbox guard.
 */
export async function clearAgentContext(name: string, opts: { force?: boolean } = {}): Promise<ClearResult> {
  const isMain = isMainChannelsAgent(name)
  // An unknown or stopped agent has no pane: nothing to clear, and that is not
  // an error -- it is the "assigned but not reachable" case the report surfaces.
  if (!isMain && !existsSync(agentDir(name))) return { outcome: 'not-running' }
  if (!isMain && !isAgentRunning(name)) return { outcome: 'not-running' }

  if (!isMain && opts.force !== true) {
    const pending = countPendingInbox(name)
    if (pending > 0) return { outcome: 'needs-confirm', pending }
  }

  const session = isMain ? MAIN_CHANNELS_SESSION : agentSessionName(name)
  const host = isMain ? null : readAgentRemoteHost(name)
  try {
    const result = await sendPromptToSession(session, '/clear', host, {
      waitForIdle: true, onBusyTimeout: 'abort', idleTimeoutMs: 4000,
    })
    return { outcome: result === 'aborted-busy' ? 'busy' : 'cleared' }
  } catch (err) {
    logger.warn({ err, name }, 'Role-based context clear failed for one agent')
    return { outcome: 'error' }
  }
}

export interface RoleParticipantResult {
  agent: string
  roles: BrokerRoleId[]
  outcome: ClearOutcome
  pending?: number
}

export interface RoleClearReport {
  /** Who dispatched, and is therefore spared. null when the caller named nobody. */
  dispatcher: string | null
  /** Distinct role holders in the config, dispatcher included. 0 = nobody assigned. */
  assignedCount: number
  /** One entry per agent actually attempted (assigned minus dispatcher). */
  results: RoleParticipantResult[]
  /** How many were actually cleared -- for a one-line confirmation. */
  clearedCount: number
}

/**
 * Nullify the context of every role participant except the dispatcher. Reads the
 * live role assignments, so a fresh install (all roles null) clears nobody and
 * reports assignedCount 0 rather than mistaking "nothing assigned" for a failure.
 */
export async function clearRoleParticipants(
  opts: { dispatcher?: string | null; force?: boolean } = {},
): Promise<RoleClearReport> {
  const dispatcher = (opts.dispatcher && opts.dispatcher.trim()) ? opts.dispatcher.trim() : null
  const plan = planRoleClear(readBrokerConfig().roles, dispatcher)
  const results: RoleParticipantResult[] = []
  for (const agent of plan.toClear) {
    const roles = plan.rolesByAgent[agent] ?? []
    // A role can be held by a VS Code code-bridge project, addressed as
    // "vscode:<project>" (see the context-broker POST route). That is never a
    // fleet tmux session, so there is no pane to send-keys into -- report it
    // rather than aiming a /clear at a session name that does not exist.
    if (agent.startsWith('vscode:')) {
      results.push({ agent, roles, outcome: 'no-panel-code-bridge' })
      continue
    }
    const r = await clearAgentContext(agent, { force: opts.force })
    results.push({ agent, roles, outcome: r.outcome, pending: r.pending })
  }
  return {
    dispatcher,
    assignedCount: plan.assigned.length,
    results,
    clearedCount: results.filter((r) => r.outcome === 'cleared').length,
  }
}
