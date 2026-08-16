// Tests for the sub-agent Telegram inbox wake-nudge.
//
// The pure gate decision (shouldWakeForTelegramInbox) is tested exhaustively
// with no filesystem or tmux, mirroring shouldWakeMainAgent. All five conditions
// (hasPending + age + debounce + session-exists + session-idle) are exercised.

import { describe, it, expect } from 'vitest'
import { shouldWakeForTelegramInbox, wakeBackoffMs, inboxStuckEscalation } from '../web/telegram-inbox-wake.js'

const BASE = {
  inboxAgeMs: 60_000,
  hasPending: true,
  now: 1_000_000_000,
  lastWakeAt: 0,
  sessionExists: true,
  sessionIdle: true,
  minAgeMs: 25_000,
  debounceMs: 60_000,
}

describe('shouldWakeForTelegramInbox (pure gate decision)', () => {
  it('wakes when inbox has pending content, is old enough, session idle, debounce elapsed', () => {
    expect(shouldWakeForTelegramInbox(BASE)).toBe(true)
  })

  it('does NOT wake when there is nothing pending', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, hasPending: false })).toBe(false)
  })

  it('does NOT wake for a fresh inbox (age gate, strict >)', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, inboxAgeMs: 10_000 })).toBe(false)
    // exactly at the threshold is still not old enough
    expect(shouldWakeForTelegramInbox({ ...BASE, inboxAgeMs: 25_000 })).toBe(false)
    expect(shouldWakeForTelegramInbox({ ...BASE, inboxAgeMs: 25_001 })).toBe(true)
  })

  it('does NOT wake within the debounce window of the last nudge', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, lastWakeAt: BASE.now - 30_000 })).toBe(false)
    // exactly at the debounce boundary is allowed
    expect(shouldWakeForTelegramInbox({ ...BASE, lastWakeAt: BASE.now - 60_000 })).toBe(true)
  })

  it('does NOT wake when the sub-agent session is absent', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, sessionExists: false })).toBe(false)
  })

  it('does NOT wake when the session is busy/mid-turn -- avoids the inject race', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, sessionIdle: false })).toBe(false)
  })

  it('stops nudging once the per-agent attempt budget is exhausted', () => {
    // debounce elapsed and everything else ready, but attempts >= maxAttempts
    expect(shouldWakeForTelegramInbox({
      ...BASE, lastWakeAt: 0, attempts: 5, maxAttempts: 5,
    })).toBe(false)
    // one under the budget still wakes (backoff window permitting)
    expect(shouldWakeForTelegramInbox({
      ...BASE, lastWakeAt: 0, attempts: 4, maxAttempts: 5,
    })).toBe(true)
  })

  it('applies exponential backoff: a higher attempt count needs a longer gap', () => {
    const commonDebounce = { ...BASE, debounceMs: 60_000, maxDebounceMs: 30 * 60_000 }
    // attempt 2 -> effective gap 60s * 2^2 = 240s. 200s since last nudge: too soon.
    expect(shouldWakeForTelegramInbox({
      ...commonDebounce, attempts: 2, lastWakeAt: BASE.now - 200_000,
    })).toBe(false)
    // 240s since last nudge: exactly at the backed-off boundary -> allowed.
    expect(shouldWakeForTelegramInbox({
      ...commonDebounce, attempts: 2, lastWakeAt: BASE.now - 240_000,
    })).toBe(true)
  })
})

describe('wakeBackoffMs (exponential gap with cap)', () => {
  it('is the base gap at attempt 0 (unchanged first-retry behaviour)', () => {
    expect(wakeBackoffMs(0, 60_000, 30 * 60_000)).toBe(60_000)
  })
  it('doubles per attempt', () => {
    expect(wakeBackoffMs(1, 60_000, 30 * 60_000)).toBe(120_000)
    expect(wakeBackoffMs(3, 60_000, 30 * 60_000)).toBe(480_000)
  })
  it('never exceeds the cap', () => {
    expect(wakeBackoffMs(10, 60_000, 30 * 60_000)).toBe(30 * 60_000)
  })
})

// The failure this covers is not "the nudge did not fire" but "nobody could tell
// that it did not". Boss, 2026-08-16: two Telegram messages sat in
// inbox-pending.jsonl for ten minutes behind a silent `continue`, and he had to
// open the agent's terminal by hand to get an answer. Every decline is now
// accounted for: a throttled warn line, and past the alert age one message to the
// main agent per stranded backlog.
const ESC = {
  inboxAgeMs: 120_000,
  now: 1_000_000_000,
  lastSkipLogAt: undefined as number | undefined,
  alertedMtimeMs: undefined as number | undefined,
  mtimeMs: 500,
  warnMs: 60_000,
  skipLogMs: 30_000,
  alertMs: 180_000,
}

describe('inboxStuckEscalation (pure: does the owner get told?)', () => {
  it('stays quiet while the wait is still normal', () => {
    expect(inboxStuckEscalation({ ...ESC, inboxAgeMs: 59_999 })).toEqual({ log: false, alert: false })
  })

  it('logs once the inbox has sat past the warn age', () => {
    expect(inboxStuckEscalation(ESC)).toEqual({ log: true, alert: false })
  })

  it('throttles the log so a stuck inbox cannot flood the file', () => {
    const justLogged = { ...ESC, lastSkipLogAt: ESC.now - 29_999 }
    expect(inboxStuckEscalation(justLogged).log).toBe(false)
    expect(inboxStuckEscalation({ ...justLogged, lastSkipLogAt: ESC.now - 30_000 }).log).toBe(true)
  })

  it('alerts the main agent once the message is old enough to matter', () => {
    expect(inboxStuckEscalation({ ...ESC, inboxAgeMs: 180_000 }).alert).toBe(true)
  })

  it('alerts only ONCE for the same backlog', () => {
    const alerted = { ...ESC, inboxAgeMs: 600_000, alertedMtimeMs: ESC.mtimeMs }
    expect(alerted.alertedMtimeMs).toBe(ESC.mtimeMs)
    expect(inboxStuckEscalation(alerted).alert).toBe(false)
  })

  it('alerts again when a NEW message arrives (mtime advances)', () => {
    const fresh = { ...ESC, inboxAgeMs: 600_000, alertedMtimeMs: ESC.mtimeMs, mtimeMs: ESC.mtimeMs + 1 }
    expect(inboxStuckEscalation(fresh).alert).toBe(true)
  })

  it('never alerts without logging first -- the log is the cheaper signal', () => {
    const r = inboxStuckEscalation({ ...ESC, inboxAgeMs: 600_000 })
    expect(r.alert && !r.log).toBe(false)
  })
})
