// The four things in this install that can shrink an agent's context, in ONE
// place, with the rules for which of them may run together.
//
// Why this module exists (Boss, 2026-08-14): "kb 3 fajta tomoritesi eljaras van
// most a marvinban. lehet hogy ossze is utkoznek egymassal mar." They did. Each
// mechanism was added on its own and configured in its own file -- a CLI flag in
// .env, a threshold in store/context-restart-gate.json, a name in
// store/context-broker.json, two buttons in the UI -- so nothing anywhere could
// answer the only question that matters: which one actually fires first?
//
// The answer, measured on this install on 2026-08-14, was the worst possible
// one. AUTOCOMPACT_TOKENS was 100000, Claude Code fires autocompact at ~69% of
// its window setting, so the CLI compacted at ~69k -- BELOW every agent's gate
// threshold (50k, 80k, 100k, 200k). The mechanism that always won was the only
// one with no checkpoint, no idle check and no instructions, and it ran 29 times
// in one day on a single agent, roughly two million tokens spent on compacting
// rather than on work. Claude Code itself printed "Autocompact is thrashing".
//
// So ordering is not a detail here, it IS the feature:
//
//   manual  <  gate/ceiling  <  CLI autocompact
//
// Cheapest and most deliberate first; the blunt instrument last, as a net that
// should ideally never be touched.

/** The measured ratio between the --autocompact setting and where it fires.
 *
 *  Not documented by Claude Code; derived from 46 compactions in this install's
 *  transcripts, which fired at an average of 69207 tokens against a 100000
 *  setting. Treat it as approximate -- it is used to keep a SAFE MARGIN below
 *  the CLI, never to predict an exact token count.
 */
export const AUTOCOMPACT_TRIGGER_RATIO = 0.69

/** Claude Code's own hard floor for --autocompact: "auto, or 100k-1M tokens". */
export const AUTOCOMPACT_MIN_TOKENS = 100_000
export const AUTOCOMPACT_MAX_TOKENS = 1_000_000

/** Roughly where `--autocompact <n>` actually fires. */
export function effectiveAutocompactTokens(setting: number): number {
  return Math.round(setting * AUTOCOMPACT_TRIGGER_RATIO)
}

/**
 * The gate must stay clear of the CLI by more than rounding noise, or the CLI
 * silently takes over again. 15% of the CLI's firing point is enough to absorb
 * the ratio being approximate without wasting much of the window.
 */
export const GATE_HEADROOM_RATIO = 0.15

/** The highest gate threshold that still lets the gate win. */
export function maxGateTokensFor(autocompactSetting: number): number {
  const fires = effectiveAutocompactTokens(autocompactSetting)
  return Math.floor(fires * (1 - GATE_HEADROOM_RATIO))
}

/**
 * A floor for the gate. Below this the gate is the thrashing, rather than the
 * cure for it: every compaction costs a full-price uncached turn afterwards, so
 * compacting a small context is strictly more expensive than carrying it.
 */
export const GATE_MIN_TOKENS = 30_000

export type MechanismId = 'manual' | 'gate' | 'cli' | 'broker'

export type Severity = 'error' | 'warning'

export interface MechanismIssue {
  /** Which control the owner has to change to fix it. */
  mechanism: MechanismId
  severity: Severity
  /** A key in web/lang/*.js; the UI owns the wording, this module owns the rule. */
  messageKey: string
  /** Values interpolated into that message. */
  params: Record<string, string | number>
}

export interface MechanismState {
  /** Gate + end-of-turn ceiling: the same threshold drives both. */
  gateEnabled: boolean
  gateTokens: number
  /** The --autocompact value the agent was launched with. */
  autocompactTokens: number
  /** Is this agent the designated context generator? */
  brokerDesignated: boolean
  /** Does the context generator wipe a delegate before its first task command? */
  brokerCleanStart: boolean
}

/**
 * Everything wrong with a combination, worst first. Empty means the four can
 * safely run together as configured.
 *
 * 'error' means the combination is self-defeating and the UI must not let the
 * owner save it. 'warning' means it works but wastes money, which is his call
 * to make, not mine.
 */
export function findMechanismIssues(s: MechanismState): MechanismIssue[] {
  const issues: MechanismIssue[] = []

  if (s.gateEnabled) {
    const fires = effectiveAutocompactTokens(s.autocompactTokens)
    const maxGate = maxGateTokensFor(s.autocompactTokens)

    // THE bug, as a rule. A gate set above where the CLI fires is not a gate at
    // all: the CLI reaches the context first, every single time, and the gate's
    // threshold becomes a number on a card that never does anything. This is
    // why usalackor sat at a 200000 setting while being compacted at ~69k.
    if (s.gateTokens > maxGate) {
      issues.push({
        mechanism: 'gate',
        severity: 'error',
        messageKey: 'ctx.issue.gate_above_cli',
        params: {
          gateK: Math.round(s.gateTokens / 1000),
          firesK: Math.round(fires / 1000),
          maxK: Math.round(maxGate / 1000),
          cliK: Math.round(s.autocompactTokens / 1000),
        },
      })
    }

    // Not an error -- it works -- but it is the expensive way to work, and the
    // owner was never shown the trade. Compaction destroys the prompt cache, so
    // the turn after one costs full price instead of ~10%; compacting a small
    // context therefore spends more than carrying it would have.
    if (s.gateTokens < GATE_MIN_TOKENS) {
      issues.push({
        mechanism: 'gate',
        severity: 'warning',
        messageKey: 'ctx.issue.gate_too_low',
        params: { gateK: Math.round(s.gateTokens / 1000), minK: Math.round(GATE_MIN_TOKENS / 1000) },
      })
    }
  } else {
    // With the gate off, the CLI is the ONLY automatic mechanism left, and it
    // is the one that compacts mid-turn with no checkpoint. Allowed, but the
    // owner should know that is what he just chose.
    issues.push({
      mechanism: 'gate',
      severity: 'warning',
      messageKey: 'ctx.issue.gate_off',
      params: { firesK: Math.round(effectiveAutocompactTokens(s.autocompactTokens) / 1000) },
    })
  }

  // Clean start hands a delegate a fresh window before the first command of a
  // task. On the context generator itself that would wipe the very context it
  // exists to assemble -- it would be erasing its own work product.
  if (s.brokerCleanStart && s.brokerDesignated) {
    issues.push({
      mechanism: 'broker',
      severity: 'error',
      messageKey: 'ctx.issue.clean_start_on_broker',
      params: {},
    })
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
}

/** May this combination be saved at all? */
export function isMechanismStateValid(s: MechanismState): boolean {
  return !findMechanismIssues(s).some((i) => i.severity === 'error')
}

/**
 * Clamp a gate threshold into the band where it can actually win, so the UI can
 * offer a working number instead of only refusing a broken one.
 */
export function clampGateTokens(gateTokens: number, autocompactTokens: number): number {
  return Math.max(GATE_MIN_TOKENS, Math.min(maxGateTokensFor(autocompactTokens), gateTokens))
}
