import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createApproval,
  logAgentDispatch,
  resolveAgentDispatch,
  resolveLatestAgentDispatch,
  getAgentReliability,
  getAgentReliabilities,
  getDb,
} from '../db.js'

describe('agent dispatch reliability log', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('returns null score when no dispatches exist for the agent', () => {
    const r = getAgentReliability('gemma')
    expect(r.score).toBe(null)
    expect(r.total).toBe(0)
    expect(r.successes).toBe(0)
    expect(r.failures).toBe(0)
  })

  it('logs a dispatch, resolves it as success, and computes a score', () => {
    const id = logAgentDispatch('gemma', 'verification', 'approval-1')
    expect(id).toBeGreaterThan(0)

    // Still dispatched → no resolved rows yet
    let r = getAgentReliability('gemma')
    expect(r.total).toBe(1)
    expect(r.successes).toBe(0)
    // An unresolved 'dispatched' row counts as a failure (never answered = no success)
    expect(r.failures).toBe(1)
    expect(r.score).toBe(0) // 0 successes / 1 total → score 0

    // Resolve as success
    const ok = resolveAgentDispatch(id, 'success')
    expect(ok).toBe(true)

    r = getAgentReliability('gemma')
    expect(r.successes).toBe(1)
    expect(r.failures).toBe(0)
    expect(r.score).toBe(10)
  })

  it('resolveLatestAgentDispatch correlates by (agent, target_id) and status', () => {
    const id = logAgentDispatch('north', 'verification', 'approval-42')
    expect(id).toBeGreaterThan(0)

    // Simulating verify-result: find latest dispatched for (north, approval-42)
    const ok = resolveLatestAgentDispatch('north', 'approval-42', 'failed', 'verification_failed', 'found a bug')
    expect(ok).toBe(true)

    const r = getAgentReliability('north')
    expect(r.successes).toBe(0)
    expect(r.failures).toBe(1)
    expect(r.score).toBe(0)
  })

  it('resolveLatestAgentDispatch is a no-op when no dispatched row exists', () => {
    const ok = resolveLatestAgentDispatch('north', 'never-dispatched', 'success')
    expect(ok).toBe(false)
  })

  it('computes score from a mix of success and failure dispatches', () => {
    for (let i = 0; i < 8; i++) {
      const id = logAgentDispatch('gemma', 'verification', `appr-${i}`)
      resolveAgentDispatch(id, 'success')
    }
    for (let i = 0; i < 2; i++) {
      const id = logAgentDispatch('gemma', 'verification', `appr-fail-${i}`)
      resolveAgentDispatch(id, 'failed')
    }

    const r = getAgentReliability('gemma')
    expect(r.total).toBe(10)
    expect(r.successes).toBe(8)
    expect(r.failures).toBe(2)
    expect(r.score).toBe(8) // 80% → 8
    expect(r.successRate).toBeCloseTo(0.8)
  })

  it('getAgentReliabilities returns scores for all agents with dispatches', () => {
    logAgentDispatch('gemma', 'verification', 'a1')
    logAgentDispatch('north', 'verification', 'a2')
    const idG = logAgentDispatch('gemma', 'verification', 'a3')
    resolveAgentDispatch(idG, 'success')

    const result = getAgentReliabilities()
    expect(Object.keys(result).sort()).toEqual(['gemma', 'north'])
    expect(result.gemma.total).toBe(2)
    expect(result.gemma.successes).toBe(1)
    expect(result.gemma.score).toBe(5) // 50% → 5
    expect(result.north.total).toBe(1)
    expect(result.north.score).toBe(0) // 0/1 → 0
  })

  it('respects the rolling window and excludes old dispatches', () => {
    const db = getDb()
    // Insert a dispatch from 8 days ago (outside the 7-day window)
    const oldTime = Math.floor(Date.now() / 1000) - 8 * 86400
    db.prepare(`
      INSERT INTO agent_dispatch_log (agent_id, dispatch_type, target_id, status, created_at, resolved_at)
      VALUES ('gemma', 'verification', 'old', 'success', ?, ?)
    `).run(oldTime, oldTime + 10)

    // A recent success should be counted
    const id = logAgentDispatch('gemma', 'verification', 'new')
    resolveAgentDispatch(id, 'success')

    const r = getAgentReliability('gemma', 7)
    expect(r.total).toBe(1) // only the recent one
    expect(r.score).toBe(10)
  })

  it('records dispatch errors with error_type and error_detail', () => {
    const id = logAgentDispatch('gemma', 'verification', 'appr')
    resolveAgentDispatch(id, 'rate_limited', '429', 'OpenRouter rate limit exceeded', 1500)

    const row = getDb().prepare('SELECT * FROM agent_dispatch_log WHERE id = ?').get(id) as any
    expect(row.status).toBe('rate_limited')
    expect(row.error_type).toBe('429')
    expect(row.error_detail).toBe('OpenRouter rate limit exceeded')
    expect(row.duration_ms).toBe(1500)
  })
})
