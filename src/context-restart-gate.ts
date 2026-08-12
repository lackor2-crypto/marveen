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

export const DEFAULT_THRESHOLD_TOKENS = 400_000
export const DEFAULT_STALE_CUTOFF_MS  = 2 * 60 * 60 * 1000   // 2 h
export const DEFAULT_RETRY_INTERVAL_MS = 5 * 60 * 1000        // 5 min
export const DEFAULT_PERSISTENT_BLOCK_ALERT_MS = 2 * 60 * 60 * 1000  // 2 h

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
  /**
   * Reclaim context with /compact (keeps a summary) before falling back to
   * /clear (wipes). Boss approved the switch on 2026-08-12 after reporting that
   * a threshold which only ever wipes is not what he wanted: "az AUTOMATIKUS
   * tisztitas is elsonek a nagy fajlokat vegye ki, tegye irasba, ugy tomoritsen".
   *
   * Default true. /clear remains the fallback for the case /compact cannot fix:
   * Claude Code refuses to compact a short session ("Not enough messages to
   * compact"), and a session whose bulk is a single huge turn may stay above the
   * threshold afterwards.
   */
  preferCompact: boolean
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
    preferCompact: o.preferCompact !== false,
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
   *   'no-usage' -- turns exist but carry no token numbers (a quota-limited
   *                 agent: every turn is a <synthetic> reply). Size genuinely
   *                 unknown -> stays fail-closed, with a reason that names it.
   *   'unknown'/absent -- unreadable transcript -> fail-closed.
   */
  contextState?: 'measured' | 'fresh' | 'no-usage' | 'unknown'

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
  if (inputs.paneState === 'busy' || inputs.paneState === 'typing') {
    return block(firstBlockedAt, inputs.nowMs, cfg, `pane-${inputs.paneState} (mid-turn, not safe)`)
  }
  if (inputs.paneUsageLimited) {
    // Session hit usage cap. /clear cannot be processed anyway, and the pane
    // is not truly idle. The stuck-modal-guard (PR #937) owns remediation here.
    return block(firstBlockedAt, inputs.nowMs, cfg, 'pane-usage-limited (quota cap, stuck-modal-guard owns this)')
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

// ---- Reclaim strategy: compact first, clear as the fallback -----------------

export type ReclaimAction = 'compact' | 'clear'

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
 * The gate only reaches here when every safety condition already passed, so the
 * question is not "is it safe" but "what is the least destructive thing that can
 * work". /compact keeps a summary and costs one round of latency; /clear is
 * instant and total. We prefer the first and escalate only on evidence that it
 * did not help.
 */
export function chooseReclaimAction(params: {
  contextTokens: number
  preferCompact: boolean
  lastCompactAt: number | null
  lastCompactTokens: number | null
  nowMs: number
}): { action: ReclaimAction; reason: string } {
  const { contextTokens, preferCompact, lastCompactAt, lastCompactTokens, nowMs } = params
  if (!preferCompact) {
    return { action: 'clear', reason: 'preferCompact disabled' }
  }
  if (lastCompactAt === null) {
    return { action: 'compact', reason: 'no previous compaction' }
  }
  if (nowMs - lastCompactAt > COMPACT_RETRY_WINDOW_MS) {
    return { action: 'compact', reason: 'previous compaction is outside the retry window' }
  }
  if (lastCompactTokens === null || lastCompactTokens <= 0) {
    // Legacy state with no recorded size: no evidence of failure, so no wipe.
    return { action: 'compact', reason: 'previous compaction size unknown' }
  }
  const reduction = (lastCompactTokens - contextTokens) / lastCompactTokens
  if (reduction < COMPACT_MIN_REDUCTION) {
    return {
      action: 'clear',
      reason: `previous compaction did not reduce the context (${lastCompactTokens} -> ${contextTokens})`,
    }
  }
  return {
    action: 'compact',
    reason: `previous compaction worked (${lastCompactTokens} -> ${contextTokens}), compacting again`,
  }
}
