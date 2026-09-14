// Pure decision logic for the kanban -> agent dispatch (option D).
//
// When a kanban card is moved to `in_progress`, the dashboard wakes the
// assigned agent by enqueuing an inter-agent message (createAgentMessage ->
// the existing message-router, which gives us retry / dedup / trust-wrapping /
// busy-receiver handling for free). This module decides WHO, if anyone, should
// be woken. Kept pure so the decision tree is unit-tested without tmux/db.
//
// Rules (mirroring the assignee semantics from PR #251):
//   - empty / unknown assignee        -> null  (no dispatch)
//   - the human owner (OWNER_NAME)     -> null  (humans never get a prompt)
//   - the bot / main agent, ONLY if it can work -> MAIN_AGENT_ID
//   - a sub-agent, ONLY if its session is running AND it can work -> that id
//     (a non-running OR quota-blocked target is a silent no-op; the card just
//      stays in in_progress rather than queuing a message for a session that
//      cannot run it)
//
// "Can work" (isBlocked === false) extends the original "is running" gate:
// Boss, 2026-09-14 -- a card dispatched to an agent that is awake but at its
// usage wall injects work into a session that rejects every turn, exactly the
// trap that lost the scheduled gold analysis. Awake is not able. A named target
// that cannot work is treated like a stopped one (no dispatch, no silent
// re-route of the operator's deliberate assignment); the never-lost scheduler
// path is where 'any' auto-picks a working agent instead. Fresh install: no
// rate-limit snapshot yet -> isBlocked returns false -> dispatch proceeds.

export interface DispatchResolveOpts {
  ownerName: string
  botName: string
  mainAgentId: string
  agentNames: string[]
  isRunning: (name: string) => boolean
  // Optional so unrelated callers/tests keep working; the production caller
  // (routes/kanban.ts) always passes the real predicate. Absent -> never
  // blocked, i.e. the pre-existing running-only behaviour.
  isBlocked?: (name: string) => boolean
}

export function resolveKanbanDispatchTarget(
  assignee: string | null | undefined,
  opts: DispatchResolveOpts,
): string | null {
  const a = (assignee ?? '').trim()
  if (!a) return null
  const lower = a.toLowerCase()
  const isBlocked = opts.isBlocked ?? (() => false)

  // Human owner never triggers an agent.
  if (a === opts.ownerName) return null

  // Bot / main agent (matched by display name or canonical id) -> main session,
  // but only if it can actually work: dispatching a card into a quota-blocked
  // main session injects a prompt it will never run.
  if (lower === opts.botName.toLowerCase() || lower === opts.mainAgentId.toLowerCase()) {
    return isBlocked(opts.mainAgentId) ? null : opts.mainAgentId
  }

  // Sub-agent: case-insensitive name match, dispatched only if it is running
  // AND not at its usage wall.
  const match = opts.agentNames.find((n) => n.toLowerCase() === lower)
  if (match && opts.isRunning(match) && !isBlocked(match)) return match

  return null
}
