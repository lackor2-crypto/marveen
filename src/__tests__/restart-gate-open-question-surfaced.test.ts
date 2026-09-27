import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb, openInboundQuestionMessageId, hasOpenInboundQuestion } from '../db.js'
import { openQuestionBlocks } from '../web/context-restart-gate-runner.js'

// #413, rebuilt from upstream 4fb9fbcb (LEDGERACK905): an unanswered inbound
// holds the restart gate only until the ledger drain has shown it to the
// agent. Before, a bare "ok" that rightly gets no answer held it shut with no
// age cap at all.

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

function log(agent: string, dir: 'in' | 'out', messageId: string | null, createdAt: number) {
  getDb().prepare(
    `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
     VALUES (?, '1', ?, ?, 'x', '', ?)`,
  ).run(agent, dir, messageId, createdAt)
}

describe('openQuestionBlocks', () => {
  it('nothing open -> does not block', () => {
    expect(openQuestionBlocks(null, null)).toBe(false)
    expect(openQuestionBlocks(null, '42')).toBe(false)
  })
  it('open and not yet surfaced -> blocks', () => {
    expect(openQuestionBlocks('42', null)).toBe(true)
  })
  it('open and surfaced by the drain -> released', () => {
    expect(openQuestionBlocks('42', '42')).toBe(false)
  })
  it('the drain surfaced a DIFFERENT message -> still blocks', () => {
    expect(openQuestionBlocks('43', '42')).toBe(true)
  })
  it('open with no identifiable id -> blocks (unknown reads as unseen)', () => {
    expect(openQuestionBlocks('', '42')).toBe(true)
  })
})

describe('openInboundQuestionMessageId', () => {
  it('agrees with hasOpenInboundQuestion and names the message', () => {
    const a = 'gate-oq-a'
    expect(openInboundQuestionMessageId(a)).toBeNull()
    log(a, 'in', '100', 1000)
    expect(openInboundQuestionMessageId(a)).toBe('100')
    expect(hasOpenInboundQuestion(a)).toBe(true)
    log(a, 'out', '101', 1001)
    expect(openInboundQuestionMessageId(a)).toBeNull()
    expect(hasOpenInboundQuestion(a)).toBe(false)
  })
  it("returns '' for an open inbound without a message id", () => {
    const a = 'gate-oq-b'
    log(a, 'in', null, 2000)
    expect(openInboundQuestionMessageId(a)).toBe('')
  })
})

describe('wiring', () => {
  it('the gate reads the drain marker the hook writes', () => {
    const runner = readFileSync(join(__dirname, '..', 'web', 'context-restart-gate-runner.ts'), 'utf-8')
    const hook = readFileSync(join(__dirname, '..', '..', 'scripts', 'hooks', 'ledger-live-drain.py'), 'utf-8')
    expect(hook).toContain('.ledger-drain-')
    expect(runner).toContain('`.ledger-drain-${safe}`')
    expect(runner).toMatch(/openQuestionBlocks\(openInboundQuestionMessageId\(ledgerId\),\s*drainSurfacedMessageId\(ledgerId\)\)/)
  })
})
