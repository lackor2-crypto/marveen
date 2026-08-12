// Boss, 2026-08-12, watching the gate compact his own session: "latom compacting
// van. csinalod is. de miert nem zold a kartyadon a terminal gomb ilyenkor?
// hiszen dolgozol!!!" The Activity feed derives "working" from the tmux pane,
// and a compaction spinner carries none of the busy signals a normal turn does,
// so a session busy for over a minute read as idle.
//
// The dashboard sends the /compact itself, so it does not have to recognise the
// spinner -- it just has to remember. What it must never do is remember
// FOREVER: a stuck "busy" flag is how this repo once starved its own scheduler
// for 94 consecutive retries, and the gate itself only ever acts on an idle
// agent, so a permanent mark would quietly disable compaction altogether.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  markCompactionStarted,
  isCompactionInFlight,
  settleCompaction,
  clearCompactionMarks,
} from '../web/compaction-inflight.js'

const T0 = 1_700_000_000_000
const MINUTE = 60_000

beforeEach(() => { clearCompactionMarks() })

describe('compaction in flight', () => {
  it('reports nothing for an agent that was never marked', () => {
    expect(isCompactionInFlight('lackor3', T0)).toBe(false)
  })

  it('reports a marked agent as busy', () => {
    markCompactionStarted('lackor3', 195_140, T0)
    expect(isCompactionInFlight('lackor3', T0 + 30_000)).toBe(true)
  })

  it('keeps agents separate', () => {
    markCompactionStarted('lackor3', 195_140, T0)
    expect(isCompactionInFlight('gypsy', T0 + 1_000)).toBe(false)
  })

  it('expires on its own so a crashed or refused compaction cannot pin an agent', () => {
    markCompactionStarted('lackor3', 195_140, T0)
    // Claude Code refuses to compact a short session, and says so instead of
    // running. Nothing would ever clear the mark in that case.
    expect(isCompactionInFlight('lackor3', T0 + 5 * MINUTE)).toBe(false)
  })
})

describe('settleCompaction', () => {
  it('clears the mark once the context measurably shrank', () => {
    markCompactionStarted('lackor3', 195_140, T0)
    // The real measurement from that evening: 195140 -> 59k.
    expect(settleCompaction('lackor3', 59_000, T0 + 80_000)).toBe(false)
    expect(isCompactionInFlight('lackor3', T0 + 81_000)).toBe(false)
  })

  it('holds while the number has not moved yet', () => {
    markCompactionStarted('lackor3', 195_140, T0)
    // Compaction is still running: usage is only written on the next turn, so
    // the reader still returns the pre-compaction figure.
    expect(settleCompaction('lackor3', 195_140, T0 + 20_000)).toBe(true)
  })

  it('holds on a GROWN context (that is a new turn, not a finished compaction)', () => {
    markCompactionStarted('lackor3', 195_140, T0)
    expect(settleCompaction('lackor3', 201_000, T0 + 20_000)).toBe(true)
  })

  it('holds when the context is unmeasurable rather than treating null as done', () => {
    // A quota-limited agent reports no numbers at all. That is not evidence the
    // compaction finished, so the mark stands until it expires.
    markCompactionStarted('lackor2-bot', null, T0)
    expect(settleCompaction('lackor2-bot', null, T0 + 20_000)).toBe(true)
    expect(settleCompaction('lackor2-bot', null, T0 + 5 * MINUTE)).toBe(false)
  })

  it('does nothing for an unmarked agent', () => {
    expect(settleCompaction('gypsy', 1_000, T0)).toBe(false)
  })
})
