// Pure logic for the proactive context-restart gate.
//
// The ledger-replay, taskstate-replay, and daily-log-digest SessionStart hooks
// can inject a rich context snapshot into every fresh session -- but only when
// the session STARTS. This gate decides when a /clear (soft restart via the
// send lane) is appropriate so those hooks carry the agent forward cheaply,
// before the context grows deep enough that the in-TUI auto-compact has to do
// it the hard (expensive, lossy) way.
//
// The trigger is simple: context >= thresholdTokens.
// The hard part is the GATE: a /clear mid-task cuts work in flight, and that is
// exactly what we want to avoid. The gate blocks whenever ANY live-work signal
// is present. FAIL-CLOSED throughout: an unmeasurable signal blocks, not allows.
//
// Zero model tokens at runtime -- every check is a deterministic SQL query,
// file read, or pane/process snapshot. The I/O lives in
// src/web/context-restart-gate-runner.ts; this module only reasons.

export const DEFAULT_THRESHOLD_TOKENS = 150_000
/**
 * Secondary floor, as a fraction of the model's own context window. The owner
 * locked the rule on 2026-08-10: "150k tokens OR 50% of the window, whichever
 * comes first". The absolute cap is the PRIMARY limiter (a 150k session is
 * expensive on every model, whatever its window); the percentage only exists so
 * a small-window model does not sail past a sane fraction of its own window
 * before the absolute cap is ever reached. On a 1M window 50% would be 500k,
 * far above 150k, so it never binds there -- which is exactly the intent
 * ("50% is too high for a 1M window").
 */
export const DEFAULT_THRESHOLD_PCT = 0.5
export const DEFAULT_STALE_CUTOFF_MS  = 2 * 60 * 60 * 1000   // 2 h
export const DEFAULT_RETRY_INTERVAL_MS = 5 * 60 * 1000        // 5 min
export const DEFAULT_PERSISTENT_BLOCK_ALERT_MS = 2 * 60 * 60 * 1000  // 2 h

/** How a context size reading turned out. Declared HERE, in the pure-logic
 *  module, because three files used to each keep their own copy of this union
 *  and adding a state meant remembering all three -- exactly the kind of drift
 *  that makes one surface report a condition the next one cannot express.
 *  The reader (src/web/active-model.ts) re-exports it. */
export type ContextReadingState = 'measured' | 'fresh' | 'no-usage' | 'quota-blocked' | 'unknown'

export interface GateConfig {
  /** Master toggle. Default false (opt-in per agent). */
  enabled: boolean
  /**
   * Trigger: soft-restart when the measured context token count reaches this.
   * Absolute token count, not a window fraction -- the right number depends on
   * session quality and coherence, not on the model's max-window size. 400k
   * gives the 1M-window models 600k of breathing room for the clean transition;
   * on a 200k-window model this value exceeds the full window, so the gate
   * never fires (the hard guard at 90%/97% handles those sessions instead).
   */
  thresholdTokens: number
  /**
   * After this many ms a dispatched agent_message (pending/delivered) is
   * treated as stale: it was likely abandoned and no longer blocks. We still
   * log when staleness was the only reason we opened, so the pattern is
   * visible rather than silently normalised.
   */
  staleCutoffMs: number
  /** How often the runner re-evaluates when blocked. */
  retryIntervalMs: number
  /**
   * Send bigme a block-alert when the gate has been continuously blocked for
   * this long. A permanently-blocked gate is itself a signal something is wrong.
   */
  persistentBlockAlertMs: number
}

export function normalizeGateConfig(raw: unknown): GateConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const posInt = (v: unknown, dflt: number): number =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.floor(v) : dflt
  return {
    enabled: o.enabled === true,
    thresholdTokens:         posInt(o.thresholdTokens,         DEFAULT_THRESHOLD_TOKENS),
    staleCutoffMs:           posInt(o.staleCutoffMs,           DEFAULT_STALE_CUTOFF_MS),
    retryIntervalMs:         posInt(o.retryIntervalMs,         DEFAULT_RETRY_INTERVAL_MS),
    persistentBlockAlertMs:  posInt(o.persistentBlockAlertMs,  DEFAULT_PERSISTENT_BLOCK_ALERT_MS),
    // Opt-OUT, unlike `enabled`: once the gate is on, summarising beats wiping.
  }
}

export const DEFAULT_GATE_CONFIG: GateConfig = normalizeGateConfig({})

export interface GateInputs {
  nowMs: number

  /**
   * Actual measured context token count from the transcript; null when the
   * session has no readable transcript (fresh start, no history yet).
   */
  contextTokens: number | null

  /**
   * Why contextTokens is null, when it is (see ContextReadingState):
   *   'fresh'    -- live transcript found, no turn run yet. The SMALLEST
   *                 possible context, so it blocks WITHOUT the fail-closed
   *                 alert escalation, exactly like below-threshold. Reporting
   *                 this as "unmeasurable" is what made the gate alert about
   *                 sessions that had nothing to reclaim.
   *   'no-usage' -- turns exist but carry no token numbers, and nothing says
   *                 why. Size genuinely unknown -> fail-closed, reason names it.
   *   'quota-blocked' -- same missing number, but the transcript states the
   *                 cause: the turns were rejected on a usage limit. Still
   *                 fail-closed for sizing, but reported as the external wall
   *                 it is instead of as a broken measurement.
   *   'unknown'/absent -- unreadable transcript -> fail-closed.
   */
  contextState?: ContextReadingState

  /** Quota wall read off the transcript, when contextState is 'quota-blocked'
   *  (or when a measured session is walled right now). Only used to make the
   *  block reason say WHEN the agent can work again. */
  contextQuota?: { resetsAt: number | null; rateLimitType: string | null } | null

  /**
   * Pane state from detectPaneState() / detectsUsageLimit().
   *
   * The TypeScript PaneState ('idle'|'busy'|'typing'|'unknown'|'error') does
   * not have a 'limited' value; pass paneUsageLimited separately for that
   * signal. null = pane not capturable (fail-closed → block).
   */
  paneState: 'idle' | 'busy' | 'typing' | 'unknown' | 'error' | null
  paneUsageLimited: boolean   // detectsUsageLimit(pane) -- usage cap banner
  /**
   * The reset moment lifted verbatim out of the usage-limit banner
   * ("Aug 20, 8pm (Europe/Budapest)"), or null when the banner carries none.
   * Display only: it goes into the block reason so whoever reads the status --
   * a person on the card, or the main agent reading an alert -- can see that
   * the wall ENDS at a known time instead of having to ask whether the session
   * is dead. Never used in a comparison; the gate does not need to.
   */
  paneLimitResetText?: string | null

  /**
   * Current phase of the hard context-guard for this agent. When the hard
   * guard is actively managing the session (await-handoff, await-ready), we
   * back off completely so the two mechanisms never both touch the pane.
   */
  hardGuardPhase: string  // 'idle' | 'cooldown' | 'await-handoff' | 'await-ready'

  /**
   * Count of agent_messages FROM this agent with status IN (pending, delivered)
   * and created_at within staleCutoffMs. These represent live dispatched work
   * the agent is waiting for.
   */
  pendingOutboundCount: number
  /**
   * True if there are dispatched messages that WOULD have blocked but are
   * older than staleCutoffMs. We let those through, but log the staleness.
   */
  hasStaleOutbound: boolean

  /**
   * Whether the session's claude process has live child processes -- Task-tool
   * subagents or background Bash commands that have not yet returned.
   *
   * null = unmeasurable (pane PID unreadable, ps failed, etc.) → FAIL-CLOSED
   * (block). This is the most fragile signal; see the runner for limitations.
   */
  hasChildProcesses: boolean | null

  /** Last inbound channel message has no later outbound (unresolved turn). */
  hasOpenQuestion: boolean

  /**
   * store/agent-taskstate/<agent>.json exists with consumed=false and a
   * non-empty nextAction -- the agent has an in-flight structured task.
   */
  hasLiveTaskState: boolean

  /**
   * The agent's local drain queue (inbox-pending.jsonl and any claimed
   * inbox-draining-*.jsonl) still holds unprocessed inbound messages.
   *
   * Fork-specific safeguard (card de5c046f): /clear is delivered as a normal
   * prompt, and this fork's channel-inbox-drain hook empties + unlinks the queue
   * on that prompt without reading it -- so a /clear fired while messages are
   * pending would drop them into the wiped context and nothing would bring them
   * back. A pending inbound is live work, exactly like an open ledger question,
   * so it blocks.
   */
  hasPendingInbox: boolean
}

export type GateAction = 'allow' | 'block' | 'block-alert'

export interface GateDecision {
  action: GateAction
  reason: string
  /** Runner should log a note that stale outbound messages were ignored. */
  noteStaleOutbound?: boolean
}

/**
 * One gate evaluation for one agent. Pure: the runner gathers all inputs and
 * executes the returned action.
 *
 * @param firstBlockedAt  Epoch ms when continuous blocking started for this
 *                        agent, or null if not currently in a blocking streak.
 *                        Used to escalate to 'block-alert' after the persistent
 *                        block threshold.
 */
export function decideGate(
  inputs: GateInputs,
  cfg: GateConfig,
  firstBlockedAt: number | null,
): GateDecision {
  if (!cfg.enabled) {
    // Disabled: return block (not alert) -- the gate being off is expected.
    return { action: 'block', reason: 'gate-disabled' }
  }

  // Trigger check first: no point evaluating the gate conditions if we are
  // still below the threshold.
  if (inputs.contextTokens === null) {
    if (inputs.contextState === 'fresh') {
      return { action: 'block', reason: 'fresh-session (no turn run yet, nothing to reclaim)' }
    }
    // A quota wall is not a broken measurement, so it must not escalate into
    // a "measurement broken" alert: nothing is wrong with the reader, the agent
    // simply cannot run a turn until the window reopens, and it heals itself.
    // Boss, 2026-08-24: the Segedmunkas sat behind the weekly wall from 07:49
    // and the gate kept repeating the same sentence it prints for a brand-new
    // session, so nothing on the board said the agent was unable to work.
    if (inputs.contextState === 'quota-blocked') {
      const resetsAt = inputs.contextQuota?.resetsAt ?? null
      const when = resetsAt !== null ? new Date(resetsAt).toISOString() : 'unknown time'
      const which = inputs.contextQuota?.rateLimitType ?? 'usage'
      return {
        action: 'block',
        reason: `quota-blocked (every turn rejected: ${which} limit, reopens ${when} -- agent cannot work, NOT a measurement fault)`,
      }
    }
    const why = inputs.contextState === 'no-usage'
      ? 'context-tokens-unmeasurable (turns carry no token counts -- fail-closed)'
      : 'context-tokens-unmeasurable (fail-closed)'
    return block(firstBlockedAt, inputs.nowMs, cfg, why)
  }
  if (inputs.contextTokens < cfg.thresholdTokens) {
    return { action: 'block', reason: `below-threshold (${inputs.contextTokens} < ${cfg.thresholdTokens})` }
  }

  // Interlock: hard guard is actively managing this session. Stand aside so
  // the two mechanisms never simultaneously touch the pane.
  if (inputs.hardGuardPhase === 'await-handoff' || inputs.hardGuardPhase === 'await-ready') {
    return block(firstBlockedAt, inputs.nowMs, cfg, `hard-guard-armed (phase: ${inputs.hardGuardPhase})`)
  }

  // ---- Gate conditions (FAIL-CLOSED) ----------------------------------------

  // Pane guard: anything that is not a confirmed idle state blocks.
  if (inputs.paneState === null) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'pane-not-capturable (fail-closed)')
  }
  // Quota wall is checked BEFORE the busy/typing guard, and it does NOT
  // escalate to an alert. Both halves were wrong until 2026-08-19:
  //
  //  - ORDER. A rate-limited pane still LOOKS busy (parked text in the box, a
  //    spinner line in the footer -- see paneShowsLimitBlock's note), so
  //    detectPaneState returns 'busy' and the guard above matched first. The
  //    usage-limit branch was unreachable for exactly the panes it was written
  //    for. Quota exhaustion is the strictly more specific condition, so it
  //    must be asked first.
  //  - SEVERITY. block() escalates to 'block-alert' after persistentBlockAlertMs,
  //    and a quota wall lasts until the window rolls over -- days, not hours. So
  //    every capped agent eventually alerted the main agent with the mid-turn
  //    wording, and the main agent read it as a wedged session: on 2026-08-16 it
  //    reported usalackor as "39 orja lefagyott (mid-turn freeze, kapu:
  //    pane-busy)" and proposed a kill/reset, when the pane in fact said
  //    "You've hit your weekly limit - resets Aug 20, 8pm - progress saved".
  //    Killing it would have thrown away the saved turn.
  //
  // A quota wall is expected, self-resolving, and its end time is known, which
  // puts it with gate-disabled / below-threshold / fresh-session: a plain block
  // that never raises an alarm. Nothing to remediate -- the window rolls over.
  if (inputs.paneUsageLimited) {
    const until = inputs.paneLimitResetText ? `, resets ${inputs.paneLimitResetText}` : ''
    return {
      action: 'block',
      reason: `pane-usage-limited (quota wall${until} -- waiting for the window, NOT stuck; do not kill)`,
    }
  }
  if (inputs.paneState === 'busy' || inputs.paneState === 'typing') {
    return block(firstBlockedAt, inputs.nowMs, cfg, `pane-${inputs.paneState} (mid-turn, not safe)`)
  }
  if (inputs.paneState === 'unknown' || inputs.paneState === 'error') {
    return block(firstBlockedAt, inputs.nowMs, cfg, `pane-${inputs.paneState} (fail-closed)`)
  }
  // paneState === 'idle' from here.

  // Child process guard: live children of the claude process = Task-tool
  // subagent or background Bash still running.
  // null = unmeasurable → fail-closed.
  if (inputs.hasChildProcesses === null) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'child-process-check-failed (fail-closed)')
  }
  if (inputs.hasChildProcesses) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'live-child-processes (Task-tool or background Bash)')
  }

  // Dispatched external work: agent_messages this agent sent that have not
  // yet received a result.
  if (inputs.pendingOutboundCount > 0) {
    return block(firstBlockedAt, inputs.nowMs, cfg,
      `pending-outbound-messages (${inputs.pendingOutboundCount} within ${Math.round(cfg.staleCutoffMs / 3_600_000)}h cutoff)`)
  }

  // Inbound channel question with no reply yet.
  if (inputs.hasOpenQuestion) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'open-question-in-ledger (unanswered inbound)')
  }

  // Structured in-flight task state.
  if (inputs.hasLiveTaskState) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'live-task-state (nextAction set, not consumed)')
  }

  // Unprocessed inbound in the local drain queue -- /clear would eat it (de5c046f).
  if (inputs.hasPendingInbox) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'pending-inbox (unprocessed inbound would be lost to /clear)')
  }

  // All gate conditions clear.
  return {
    action: 'allow',
    reason: `context ${inputs.contextTokens} >= ${cfg.thresholdTokens}, all gate conditions clear`,
    noteStaleOutbound: inputs.hasStaleOutbound,
  }
}

function block(
  firstBlockedAt: number | null,
  nowMs: number,
  cfg: GateConfig,
  reason: string,
): GateDecision {
  const elapsed = firstBlockedAt !== null ? nowMs - firstBlockedAt : 0
  const action: GateAction = elapsed >= cfg.persistentBlockAlertMs ? 'block-alert' : 'block'
  return { action, reason }
}

// ---- Reclaim strategy: compact, or stop and let a human decide --------------

/**
 * 'hold' means "do nothing this sweep". There is deliberately no 'clear': the
 * gate cannot wipe a session, only a person can (the card's button).
 */
export type ReclaimAction = 'compact' | 'hold'

/**
 * A compaction that did not shrink the context by at least this fraction is
 * treated as having failed. 0.1 is deliberately forgiving: a real compaction on
 * this install went 101222 -> 5597 tokens (94%), so anything under a tenth means
 * the summariser could not do its job, not that it did it modestly.
 */
export const COMPACT_MIN_REDUCTION = 0.1

/**
 * How long a previous compaction stays relevant. Past this, a still-high context
 * is new growth rather than evidence that compaction failed, so we compact again
 * rather than escalating to a wipe.
 */
export const COMPACT_RETRY_WINDOW_MS = 60 * 60_000

/**
 * Which command should reclaim this session's context? Pure.
 *
 * The gate NEVER wipes. It used to escalate to /clear when it judged the
 * previous compaction useless, and BOTH halves of that were wrong (2026-08-14):
 *
 *  - The judgement was wrong. It compared the size BEFORE the last compaction
 *    against the size NOW, so ordinary regrowth read as failure. A session that
 *    compacted 68k -> 10k and then worked its way back to 62k inside the hour
 *    scored as "compaction did not reduce the context" -- when it had in fact
 *    reduced it by 85%. On this install the context regrows that far in minutes.
 *  - The response was wrong. /clear is the most destructive thing available
 *    here, and it fired exactly when the measurement was least trustworthy.
 *    Reclaiming context is never worth silently discarding a conversation, so
 *    /clear is now manual only: a button someone presses, never a timer's call.
 *
 * The evidence is now lastCompactMinSeen, the smallest context observed since
 * the compaction was dispatched. That answers the question actually being asked
 * ("did it ever shrink?") and no amount of later regrowth can falsify it.
 *
 * When a compaction demonstrably failed we HOLD instead of escalating. Sending
 * /compact again every sweep would be its own thrashing loop -- the very
 * failure this change exists to end -- so the gate stops, says why, and leaves
 * the destructive option to a human. After the retry window it will try once
 * more, because by then a still-large context is new growth, not old evidence.
 */
export function chooseReclaimAction(params: {
  lastCompactAt: number | null
  lastCompactTokens: number | null
  lastCompactMinSeen: number | null
  nowMs: number
}): { action: ReclaimAction; reason: string } {
  const { lastCompactAt, lastCompactTokens, lastCompactMinSeen, nowMs } = params
  if (lastCompactAt === null) {
    return { action: 'compact', reason: 'no previous compaction' }
  }
  if (nowMs - lastCompactAt > COMPACT_RETRY_WINDOW_MS) {
    return { action: 'compact', reason: 'previous compaction is outside the retry window' }
  }
  if (lastCompactTokens === null || lastCompactTokens <= 0) {
    // Legacy state with no recorded size: no evidence of failure, so try again.
    return { action: 'compact', reason: 'previous compaction size unknown' }
  }
  if (lastCompactMinSeen === null) {
    // Dispatched but never re-measured: the compaction may still be running.
    // Waiting one sweep costs nothing; guessing costs the session.
    return { action: 'hold', reason: 'previous compaction not measured yet' }
  }
  const reduction = (lastCompactTokens - lastCompactMinSeen) / lastCompactTokens
  if (reduction < COMPACT_MIN_REDUCTION) {
    return {
      action: 'hold',
      reason: `previous compaction never shrank this session (${lastCompactTokens} -> ${lastCompactMinSeen} at its lowest); `
        + 'not retrying -- /clear is manual only',
    }
  }
  return {
    action: 'compact',
    reason: `previous compaction worked (${lastCompactTokens} -> ${lastCompactMinSeen}), the context grew back, compacting again`,
  }
}
