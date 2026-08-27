import { describe, it, expect } from 'vitest'
import { computeAgentActivityLabel } from '../agent-activity-label.js'
import { detectPaneState } from '../pane-state.js'

// Boss reported five separate times (most recently 2026-08-17) that an agent
// visibly working in its own terminal window still showed as not-working on
// the dashboard. Two of the reports point at gaps this file locks down:
//
//   1. A plain `run_in_background` bash command (or a compaction, or anything
//      else with no textual signal detectPaneState/detectsBackgroundAgentActivity
//      recognize) still counts as "working" if the pane content is visibly
//      changing between polls -- computeAgentActivityLabel's pane-diff check.
//   2. That check is DISPLAY-ONLY: detectPaneState itself (the message-delivery
//      gate) must keep classifying the same pane as 'idle', or a future change
//      here risks repeating the 94-consecutive-retry starvation regression on
//      an idle session.

const SEP = '─'.repeat(80)

// A footer that is otherwise idle by every recognized pattern (no spinner, no
// token count, no FleetView sub-agent row) but has one line of scrollback that
// changes between two captures -- e.g. a `run_in_background` command printing
// its own output with nothing else changing.
function idlePaneWithScrollbackLine(line: string): string {
  return [
    '',
    line,
    SEP,
    '❯ ',
    SEP,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
}

describe('computeAgentActivityLabel: pane-diff fallback', () => {
  it('reports working on the first sighting of a not-yet-cached pane', () => {
    const key = 'test-agent-first-sight-' + Math.random()
    const pane = idlePaneWithScrollbackLine('build: step 1/9')
    // First observation has nothing to diff against -- treated as a change
    // (matches "just started" rather than risking a false negative on boot).
    expect(computeAgentActivityLabel(true, pane, key)).toBe('working')
  })

  it('settles to idle once the pane stops changing', () => {
    const key = 'test-agent-settle-' + Math.random()
    const pane = idlePaneWithScrollbackLine('build: step 3/9')
    computeAgentActivityLabel(true, pane, key) // first sighting: 'working'
    computeAgentActivityLabel(true, pane, key) // still within the grace window
    // Same content, well past the grace window: no longer "just changed".
    const original = Date.now
    Date.now = () => original() + 10_000
    try {
      expect(computeAgentActivityLabel(true, pane, key)).toBe('idle')
    } finally {
      Date.now = original
    }
  })

  it('goes back to working the instant a genuinely idle pane changes', () => {
    const key = 'test-agent-background-task-' + Math.random()
    const before = idlePaneWithScrollbackLine('build: step 3/9')
    const after = idlePaneWithScrollbackLine('build: step 4/9')
    // Both captures are 'idle' per the core detector -- no busy footer, no
    // FleetView row. This is exactly the plain-background-task case that had
    // no other signal before this fallback existed.
    expect(detectPaneState(before)).toBe('idle')
    expect(detectPaneState(after)).toBe('idle')
    computeAgentActivityLabel(true, before, key)
    expect(computeAgentActivityLabel(true, after, key)).toBe('working')
  })

  it('never overrides typing (parked/pasted text) even when it first appears', () => {
    const key = 'test-agent-typing-' + Math.random()
    const paneWithParkedText = [
      '',
      SEP,
      '❯ some pasted text nobody submitted',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(paneWithParkedText)).toBe('typing')
    // Even on first sighting (which would otherwise read as "changed"),
    // 'typing' must stay 'idle' -- this is the exact case that lit the button
    // on a dead agent before the 'typing' guard existed.
    expect(computeAgentActivityLabel(true, paneWithParkedText, key)).toBe('idle')
  })

  it('does not touch the core busy gate (detectPaneState) -- display-only', () => {
    const key = 'test-agent-core-gate-' + Math.random()
    const before = idlePaneWithScrollbackLine('polling...')
    const after = idlePaneWithScrollbackLine('polling.....')
    computeAgentActivityLabel(true, before, key)
    computeAgentActivityLabel(true, after, key)
    // The activity label went 'working', but the delivery-critical predicate
    // is untouched: this pane is still 'idle' and still safe to send into.
    expect(detectPaneState(after)).toBe('idle')
  })
})

// Boss, 2026-08-27: Marvin showed "várakozik" while the Szakértő on the SAME
// weekly-out account state showed "keret elfogyott". The only difference was a
// session restart that wiped Marvin's "You've hit your weekly limit" banner, so
// the pane-only detector could no longer see it. The durable quotaExhausted
// verdict (from the rate-limit snapshot) closes that blind spot.
describe('computeAgentActivityLabel: durable quota-exhausted signal', () => {
  // A fresh startup / restart screen: no limit banner anywhere, parked prompt.
  const restartedPaneNoBanner = [
    ' ▐▛███▛█   Claude Code v2.1.246',
    '▝▜██████▀  Sonnet 5 · Claude Pro',
    SEP,
    '❯ ',
    SEP,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')

  it('reports limited when the snapshot says out-of-quota even with no pane banner', () => {
    const key = 'test-agent-quota-nobanner-' + Math.random()
    // Without the durable signal this restarted pane would read idle/working,
    // never 'limited' -- exactly the false "várakozik" Boss saw on Marvin.
    expect(computeAgentActivityLabel(true, restartedPaneNoBanner, key, true)).toBe('limited')
  })

  it('does not report limited when the snapshot says the account is fine', () => {
    const key = 'test-agent-quota-fine-' + Math.random()
    // Parked text reads 'typing' -> 'idle', and quotaExhausted=false must not
    // upgrade it to limited (fresh-install agent with no/clean snapshot).
    const parked = [SEP, '❯ some parked text', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(computeAgentActivityLabel(true, parked, key, false)).toBe('idle')
  })

  it('still reports limited from the live banner alone (snapshot not needed)', () => {
    const key = 'test-agent-quota-banner-' + Math.random()
    const bannerPane = [
      "● Usage limit reached again · continuing automatically at 8pm",
      "  ⎿  You've hit your weekly limit · resets 8pm (Europe/Budapest)",
      SEP,
      '❯ ',
    ].join('\n')
    expect(computeAgentActivityLabel(true, bannerPane, key, false)).toBe('limited')
  })

  it('defaults quotaExhausted to false for existing 3-arg callers', () => {
    const key = 'test-agent-quota-default-' + Math.random()
    const parked = [SEP, '❯ parked', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(computeAgentActivityLabel(true, parked, key)).toBe('idle')
  })
})
