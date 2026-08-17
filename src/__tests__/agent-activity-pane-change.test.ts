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
