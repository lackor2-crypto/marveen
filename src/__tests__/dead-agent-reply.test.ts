// Tests for the dead sub-agent Telegram reply (kanban d3ce7696, Boss uzenet 821).
//
// decideDeadAgentReply is pure -- no tmux, no filesystem, no network -- so the
// exact rule ("react only to Boss's own inbound message, never to an
// autonomous state change") is exercised without any I/O, mirroring
// shouldWakeForTelegramInbox in telegram-inbox-wake.test.ts.

import { describe, it, expect } from 'vitest'
import { decideDeadAgentReply, deadAgentReplyText, DEAD_AGENT_REPLY_TEXT } from '../web/dead-agent-reply.js'

const BASE = {
  isRunning: false,
  downStreak: 1, // one below the debounce threshold of 2
  debounceThreshold: 2,
  pending: { updateId: 42, chatId: 8736799466 },
  lastRepliedUpdateId: null as number | null,
}

describe('decideDeadAgentReply (pure gate decision)', () => {
  it('replies once the agent has been confirmed dead across the debounce window and a message is pending', () => {
    const r = decideDeadAgentReply(BASE)
    expect(r.downStreak).toBe(2)
    expect(r.reply).toEqual({ chatId: 8736799466, updateId: 42 })
    expect(r.lastRepliedUpdateId).toBe(42)
  })

  it('does NOT reply on the first down reading -- a restart blip must not fire', () => {
    const r = decideDeadAgentReply({ ...BASE, downStreak: 0 })
    expect(r.downStreak).toBe(1)
    expect(r.reply).toBeNull()
  })

  it('does NOT reply, and RESETS state, purely because the agent came back alive (no message)', () => {
    const r = decideDeadAgentReply({ ...BASE, isRunning: true, pending: null, lastRepliedUpdateId: 7 })
    expect(r.downStreak).toBe(0)
    expect(r.lastRepliedUpdateId).toBeNull()
    expect(r.reply).toBeNull()
  })

  it('does NOT reply when the agent is confirmed dead but nothing is pending -- a crash alone must never speak', () => {
    const r = decideDeadAgentReply({ ...BASE, pending: null })
    expect(r.reply).toBeNull()
  })

  it('does NOT reply when the pending update has no chat to answer into', () => {
    const r = decideDeadAgentReply({ ...BASE, pending: { updateId: 42, chatId: null } })
    expect(r.reply).toBeNull()
  })

  it('does NOT reply twice for the exact same pending update_id (no duplicate spam)', () => {
    const r = decideDeadAgentReply({ ...BASE, lastRepliedUpdateId: 42 })
    expect(r.reply).toBeNull()
    expect(r.lastRepliedUpdateId).toBe(42)
  })

  it('replies again when a NEW message arrives after one already answered', () => {
    const r = decideDeadAgentReply({ ...BASE, lastRepliedUpdateId: 41 })
    expect(r.reply).toEqual({ chatId: 8736799466, updateId: 42 })
  })

  it('keeps accumulating downStreak past the threshold without re-triggering extra state churn', () => {
    const r = decideDeadAgentReply({ ...BASE, downStreak: 5, lastRepliedUpdateId: 42 })
    expect(r.downStreak).toBe(6)
    expect(r.reply).toBeNull()
  })
})

describe('deadAgentReplyText', () => {
  it('renders the Hungarian text with the agent name interpolated', () => {
    const text = deadAgentReplyText('hu', 'Segédmunkás')
    expect(text).toContain('Segédmunkás')
    expect(text).toContain('nem élek')
  })

  it('renders English for a non-Hungarian install', () => {
    const text = deadAgentReplyText('en', 'Helper')
    expect(text).toContain('Helper')
    expect(text).toContain('not alive')
  })

  it('falls back to Hungarian for an unknown language code', () => {
    expect(deadAgentReplyText('xx', 'X')).toBe(DEAD_AGENT_REPLY_TEXT['hu']!('X'))
  })
})
