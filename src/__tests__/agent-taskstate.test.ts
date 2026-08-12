import { describe, it, expect, afterEach } from 'vitest'
import {
  shouldReplayTaskState,
  isEmptyTaskState,
  buildTaskStateInjection,
  writeTaskState,
  readTaskState,
  markConsumed,
  clearTaskState,
  sweepOrphanTaskStates,
  TASKSTATE_TTL_MS,
  type AgentTaskState,
} from '../web/agent-taskstate.js'

const NOW = 1_700_000_000_000
const rec = (over: Partial<AgentTaskState> = {}): AgentTaskState => ({
  agent: 'tester',
  doneSteps: ['did A'],
  alreadyDelegated: [],
  nextAction: 'do B',
  pendingDecision: '',
  summary: 'building X',
  objective: '',
  phase: '',
  constraints: [],
  decisions: [],
  rejected: [],
  filesChanged: [],
  exactValues: [],
  openQuestions: [],
  ts: NOW,
  consumed: false,
  ...over,
})

// Compact task-state re-injection (#4). Pure-fn coverage is the safety core.
describe('shouldReplayTaskState', () => {
  it('replays a fresh unconsumed record on compact', () => {
    expect(shouldReplayTaskState(rec(), 'compact', NOW + 1000)).toBe(true)
  })
  it('replays on resume too', () => {
    expect(shouldReplayTaskState(rec(), 'resume', NOW + 1000)).toBe(true)
  })
  // A crash/watchdog respawn mid-task arrives as source=startup, so withholding
  // the record there defeated the feature's whole purpose (2026-07-27).
  it('replays on startup too (crash respawn mid-task)', () => {
    expect(shouldReplayTaskState(rec(), 'startup', NOW + 1000)).toBe(true)
  })
  it('does NOT replay an unknown source', () => {
    expect(shouldReplayTaskState(rec(), 'clear', NOW + 1000)).toBe(false)
  })
  it('does NOT replay an empty record on startup either', () => {
    const empty = rec({ doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '', summary: 'idle' })
    expect(shouldReplayTaskState(empty, 'startup', NOW + 1000)).toBe(false)
  })
  it('does NOT replay a consumed record on startup either', () => {
    expect(shouldReplayTaskState(rec({ consumed: true }), 'startup', NOW + 1000)).toBe(false)
  })
  it('does NOT replay a consumed record', () => {
    expect(shouldReplayTaskState(rec({ consumed: true }), 'compact', NOW + 1000)).toBe(false)
  })
  it('does NOT replay a null record', () => {
    expect(shouldReplayTaskState(null, 'compact', NOW)).toBe(false)
  })
  it('does NOT replay past the TTL (orphan)', () => {
    expect(shouldReplayTaskState(rec(), 'compact', NOW + TASKSTATE_TTL_MS + 1)).toBe(false)
  })
  it('replays right up to the TTL boundary', () => {
    expect(shouldReplayTaskState(rec(), 'compact', NOW + TASKSTATE_TTL_MS)).toBe(true)
  })
  it('does NOT replay an empty (no-task) record', () => {
    const empty = rec({ doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '', summary: 'idle' })
    expect(shouldReplayTaskState(empty, 'compact', NOW + 1)).toBe(false)
  })
})

describe('isEmptyTaskState', () => {
  it('true when no steps/delegations/next/pending', () => {
    expect(isEmptyTaskState({ doneSteps: [], alreadyDelegated: [], nextAction: '  ', pendingDecision: '' })).toBe(true)
  })
  it('false when a nextAction exists', () => {
    expect(isEmptyTaskState({ doneSteps: [], alreadyDelegated: [], nextAction: 'do B', pendingDecision: '' })).toBe(false)
  })
  it('false when already-delegated exists (the re-delegation guard data)', () => {
    expect(isEmptyTaskState({ doneSteps: [], alreadyDelegated: ['gave Zara the frontend'], nextAction: '', pendingDecision: '' })).toBe(false)
  })
})

describe('buildTaskStateInjection', () => {
  it('carries the sentinel + structured do-not-resend lists', () => {
    const out = buildTaskStateInjection(rec({
      doneSteps: ['merged #276'],
      alreadyDelegated: ['Zara: frontend modal'],
      nextAction: 'open the PR',
      pendingDecision: 'whether to gate on RESPAWN_ENABLED',
    }))
    expect(out).toContain('TASK-FOLYTATAS (NEM uj feladat)')
    expect(out).toContain('NE delegald ujra') // anti-re-delegation framing
    expect(out).toContain('merged #276')        // done step
    expect(out).toContain('Zara: frontend modal') // already-delegated item
    expect(out).toContain('open the PR')         // next action
    expect(out).toContain('whether to gate')     // pending decision
  })
})

// Light I/O round-trip on the real store dir, with cleanup.
describe('task-state store I/O', () => {
  const A = 'vitest-taskstate-agent'
  afterEach(() => clearTaskState(A))

  it('write -> read round-trips and arms (consumed=false, fresh ts)', () => {
    writeTaskState(A, { summary: 's', nextAction: 'next', doneSteps: ['x'] }, NOW)
    const r = readTaskState(A)!
    expect(r.consumed).toBe(false)
    expect(r.ts).toBe(NOW)
    expect(r.nextAction).toBe('next')
    expect(r.doneSteps).toEqual(['x'])
  })

  it('markConsumed flips the flag so the next replay is suppressed', () => {
    writeTaskState(A, { nextAction: 'next' }, NOW)
    markConsumed(A)
    const r = readTaskState(A)!
    expect(r.consumed).toBe(true)
    expect(shouldReplayTaskState(r, 'compact', NOW + 1)).toBe(false)
  })

  it('sweepOrphanTaskStates drops a record older than the TTL', () => {
    writeTaskState(A, { nextAction: 'next' }, NOW)
    const swept = sweepOrphanTaskStates(NOW + TASKSTATE_TTL_MS + 1)
    expect(swept).toBeGreaterThanOrEqual(1)
    expect(readTaskState(A)).toBeNull()
  })

  it('sanitizes the agent name (no path traversal in the filename)', () => {
    // A traversal-y name must not escape the store dir; it sanitizes to safe chars.
    writeTaskState('../../etc/passwd', { nextAction: 'x' }, NOW)
    // readable back via the same sanitized key, and no file outside the dir.
    const r = readTaskState('../../etc/passwd')
    expect(r).not.toBeNull()
    clearTaskState('../../etc/passwd')
  })
})

// Structured state fields (kanban 55af1bfe): decisions, ruled-out approaches,
// pinned constraints and exact values are what a rolling summary loses first.
describe('structured state fields', () => {
  const A = 'structured-tester'
  afterEach(() => clearTaskState(A))

  it('round-trips the new fields through write/read', () => {
    writeTaskState(A, {
      objective: 'ship the checkpoint',
      phase: 'IMPLEMENTING',
      constraints: ['no schema changes'],
      decisions: ['additive fields, because old records must still replay'],
      rejected: ['a second store -- the record already exists'],
      filesChanged: ['src/web/agent-taskstate.ts -- new fields'],
      exactValues: ['STATE_ITEM_MAX=300'],
      openQuestions: ['threshold tiers?'],
      nextAction: 'run the suite',
    }, NOW)
    const r = readTaskState(A)!
    expect(r.objective).toBe('ship the checkpoint')
    expect(r.phase).toBe('IMPLEMENTING')
    expect(r.constraints).toEqual(['no schema changes'])
    expect(r.rejected).toEqual(['a second store -- the record already exists'])
    expect(r.exactValues).toEqual(['STATE_ITEM_MAX=300'])
  })

  // Backward compatibility: a record written before this change has none of the
  // new keys and must still read, replay and render exactly as before.
  it('reads a legacy 5-field record without the new keys', () => {
    writeTaskState(A, { summary: 'legacy', doneSteps: ['a'], nextAction: 'b' }, NOW)
    const r = readTaskState(A)!
    expect(r.constraints).toEqual([])
    expect(r.objective).toBe('')
    expect(shouldReplayTaskState(r, 'compact', NOW + 1)).toBe(true)
    expect(buildTaskStateInjection(r)).toContain('KOVETKEZO AKCIO')
  })

  it('treats decisions/rejected/constraints alone as worth replaying', () => {
    const r = rec({ doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '', rejected: ['tried X, failed'] })
    expect(isEmptyTaskState(r)).toBe(false)
    expect(shouldReplayTaskState(r, 'compact', NOW + 1)).toBe(true)
  })

  it('still treats a genuinely empty record as empty', () => {
    const r = rec({ doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '' })
    expect(isEmptyTaskState(r)).toBe(true)
  })

  // Lost-in-the-middle defense: constraints near the top, the single next action last.
  it('orders the injection with constraints first and next action last', () => {
    const text = buildTaskStateInjection(rec({
      constraints: ['never touch prod'],
      rejected: ['polling -- too slow'],
      nextAction: 'run the suite',
    }))
    expect(text.indexOf('KOTOTT KOVETELMENYEK')).toBeLessThan(text.indexOf('MAR KESZ'))
    expect(text.indexOf('MAR ELVETVE')).toBeLessThan(text.indexOf('KOVETKEZO AKCIO'))
    expect(text.trimEnd().endsWith('run the suite')).toBe(true)
  })

  // The checkpoint must not become a context hog itself.
  it('caps list length and item length', () => {
    writeTaskState(A, { decisions: Array.from({ length: 40 }, (_, i) => `d${i}`), exactValues: ['x'.repeat(500)] }, NOW)
    const r = readTaskState(A)!
    expect(r.decisions).toHaveLength(25)
    expect(r.exactValues[0]).toHaveLength(300)
  })
})
