import { describe, it, expect, beforeAll, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const BASE = 1720000000

beforeAll(() => {
  initDatabase(':memory:')
  const db = getDb()

  const insertTurn = db.prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, model)
    VALUES (?, 'sess-1', ?, ?, ?, ?, ?, ?)
  `)
  // agent-a: 3 turns. A Boss message lands between turn1 and turn2 -> turn2 is
  // Boss-triggered. No message before turn1 or between turn2/turn3.
  insertTurn.run('agent-a', BASE, 1000, 100, 0, 0, 'opus')
  insertTurn.run('agent-a', BASE + 60, 2000, 100, 500, 0, 'opus')
  insertTurn.run('agent-a', BASE + 120, 1500, 100, 0, 0, 'opus')
  // agent-b: 1 turn, no inbound messages at all -> never Boss-triggered.
  insertTurn.run('agent-b', BASE + 30, 900, 50, 0, 0, null)

  const insertInbound = db.prepare(`
    INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
    VALUES (?, 'chat-1', 'in', ?, 'hi', '2026', ?)
  `)
  insertInbound.run('agent-a', 'm1', BASE + 30) // lands between turn1 (BASE) and turn2 (BASE+60)
})

describe('getContextUsage', () => {
  it('sums input+cache_read+cache_creation into upContextTokens', async () => {
    const { getContextUsage } = await import('../web/token-usage.js')
    const { turns } = getContextUsage({ agent: 'agent-a' })
    expect(turns[1].upContextTokens).toBe(2000 + 500 + 0)
  })

  it('flags only the turn that followed a Boss inbound message', async () => {
    const { getContextUsage } = await import('../web/token-usage.js')
    const { turns } = getContextUsage({ agent: 'agent-a' })
    expect(turns.map(t => t.bossTriggered)).toEqual([false, true, false])
  })

  it('never flags a turn for an agent with no inbound messages', async () => {
    const { getContextUsage } = await import('../web/token-usage.js')
    const { turns } = getContextUsage({ agent: 'agent-b' })
    expect(turns.every(t => !t.bossTriggered)).toBe(true)
  })

  it('does not double-count one inbound message across two later turns', async () => {
    const { getContextUsage } = await import('../web/token-usage.js')
    const { byAgent } = getContextUsage({ agent: 'agent-a' })
    const a = byAgent.find(x => x.agent === 'agent-a')
    expect(a!.bossTriggeredTurns).toBe(1)
  })

  it('builds a per-agent summary with turn count, latest and peak context', async () => {
    const { getContextUsage } = await import('../web/token-usage.js')
    const { byAgent } = getContextUsage({ agent: 'agent-a' })
    const a = byAgent.find(x => x.agent === 'agent-a')!
    expect(a.turns).toBe(3)
    expect(a.latestUpContextTokens).toBe(1500)
    expect(a.maxUpContextTokens).toBe(2500)
  })

  it('respects the agent filter', async () => {
    const { getContextUsage } = await import('../web/token-usage.js')
    const { turns } = getContextUsage({ agent: 'agent-b' })
    expect(turns).toHaveLength(1)
    expect(turns[0].agent).toBe('agent-b')
  })

  it('returns empty result for an agent with no rows', async () => {
    const { getContextUsage } = await import('../web/token-usage.js')
    const result = getContextUsage({ agent: 'nobody' })
    expect(result.turns).toEqual([])
    expect(result.byAgent).toEqual([])
  })
})

describe('exportContextUsageMarkdown', () => {
  it('renders a per-agent summary table and a per-turn table', async () => {
    const { getContextUsage, exportContextUsageMarkdown } = await import('../web/token-usage.js')
    const result = getContextUsage({ agent: 'agent-a' })
    const md = exportContextUsageMarkdown(result, BASE)
    expect(md).toContain('# Kontextus-meret figyelo')
    expect(md).toContain('agent-a')
    expect(md).toMatch(/\|\s*igen\s*\|/)
  })
})
