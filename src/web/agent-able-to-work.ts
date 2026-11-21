// "Can this agent run a task right now?" -- the ONE capability gate for every place that hands work to an agent (the
// scheduler, the kanban dispatch). Awake is not able: an agent at its usage wall OR signed out (TG 7172 / #956) takes
// nothing. Kept apart from agent-availability-watch.ts so the two checks stay separately substitutable in tests.
import { isAgentQuotaBlocked } from './agent-availability.js'
import { isAgentSignedOut } from './agent-availability-watch.js'

export function isAgentUnableToWork(agent: string, now: number = Date.now()): boolean {
  return isAgentQuotaBlocked(agent, now) || isAgentSignedOut(agent, now)
}
