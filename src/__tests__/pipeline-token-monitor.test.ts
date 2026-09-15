import { describe, it, expect } from 'vitest'
// The monitor is an .mjs CLI whose pure helpers are exported for exactly this.
// Importing it must NOT run the CLI (it guards on process.argv[1]).
import {
  encodeProjectPath,
  readEnvValue,
  parseUsageText,
  collapseByMessageId,
  sumUsage,
  estimateSingleAgent,
  buildReport,
  normalizeRun,
} from '../../scripts/pipeline-token-monitor.mjs'

// One assistant turn's transcript often spans several JSONL lines that repeat
// the SAME message.id and the SAME usage object (once per streamed tool block).
// Counting them naively doubles the tokens; the fixture below reproduces that.
function assistantLine(opts: {
  id: string
  sessionId?: string
  ts: string
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
  model?: string
  thinking?: string
}): string {
  const content: unknown[] = []
  if (opts.thinking) content.push({ type: 'thinking', thinking: opts.thinking })
  content.push({ type: 'text', text: 'ok' })
  return JSON.stringify({
    type: 'assistant',
    sessionId: opts.sessionId ?? 'sess-A',
    timestamp: opts.ts,
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-opus-4-8',
      content,
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
      },
    },
  })
}

describe('encodeProjectPath', () => {
  it('replaces every non-alphanumeric/non-dash char with a dash', () => {
    expect(encodeProjectPath('/home/boss/marveen')).toBe('-home-boss-marveen')
    expect(encodeProjectPath('/a/b-c/d.e')).toBe('-a-b-c-d-e')
  })
})

describe('readEnvValue', () => {
  it('reads a key, tolerating quotes and comments, and returns null when absent', () => {
    const env = ['# comment', 'WEB_PORT=3420', 'OWNER_NAME="Boss"', 'EMPTY='].join('\n')
    expect(readEnvValue('WEB_PORT', env)).toBe('3420')
    expect(readEnvValue('OWNER_NAME', env)).toBe('Boss')
    expect(readEnvValue('EMPTY', env)).toBe('')
    expect(readEnvValue('MISSING', env)).toBeNull()
  })
})

describe('collapseByMessageId', () => {
  it('collapses rows sharing a message id by taking the max per field', () => {
    const rows = [
      { messageId: 'm1', inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, ts: 1, model: 'x' },
      { messageId: 'm1', inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, ts: 1, model: 'x' },
      { messageId: 'm2', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, ts: 2, model: 'x' },
    ]
    const out = collapseByMessageId(rows as never)
    expect(out).toHaveLength(2)
    // m1 collapsed to ONE row with the max output (40, not 5+40=45)
    expect(out[0].outputTokens).toBe(40)
    expect(out[0].inputTokens).toBe(100)
  })

  it('passes through rows without a message id', () => {
    const rows = [
      { messageId: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, ts: 1, model: null },
      { messageId: null, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, ts: 2, model: null },
    ]
    expect(collapseByMessageId(rows as never)).toHaveLength(2)
  })
})

describe('parseUsageText', () => {
  it('parses assistant usage and collapses a multi-line tool turn to one', () => {
    const text = [
      assistantLine({ id: 'm1', ts: '2026-09-15T10:00:00Z', input: 200, output: 10 }),
      // same turn repeated (tool streaming) -- must NOT double-count
      assistantLine({ id: 'm1', ts: '2026-09-15T10:00:00Z', input: 200, output: 50 }),
      assistantLine({ id: 'm2', ts: '2026-09-15T10:01:00Z', input: 20, output: 5, thinking: 'abcd' }),
      '',
      '{ not json',
    ].join('\n')
    const calls = parseUsageText(text, 'usalackor')
    expect(calls).toHaveLength(2)
    const totals = sumUsage(calls)
    expect(totals.turns).toBe(2)
    expect(totals.inputTokens).toBe(220) // 200 + 20, NOT 200+200+20
    expect(totals.outputTokens).toBe(55) // max(10,50)=50 + 5
    expect(totals.thinkingTokens).toBe(1) // ceil("abcd".length/4)=1
    expect(totals.model).toBe('claude-opus-4-8')
  })

  it('ignores non-assistant lines and lines without usage', () => {
    const text = [
      JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-09-15T10:00:00Z', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-09-15T10:00:01Z', message: { id: 'x', content: [] } }),
    ].join('\n')
    expect(parseUsageText(text)).toHaveLength(0)
  })
})

describe('sumUsage weightedTokens', () => {
  it('weights cache-read at ~0.1x and counts fresh input + output at full', () => {
    const calls = parseUsageText(
      assistantLine({ id: 'm1', ts: '2026-09-15T10:00:00Z', input: 100, output: 50, cacheRead: 1000, cacheCreation: 10 }),
    )
    const t = sumUsage(calls)
    // 100 + 10 + 50 + ceil(1000*0.1)=100  => 260
    expect(t.weightedTokens).toBe(260)
  })
})

describe('estimateSingleAgent', () => {
  it('models one context load (the biggest role) plus every role output', () => {
    const perRole = {
      tervezo: { turns: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, weightedTokens: 1200 },
      implementalo: { turns: 1, inputTokens: 5000, outputTokens: 800, cacheReadTokens: 0, cacheCreationTokens: 500, thinkingTokens: 0, weightedTokens: 6300 },
      ellenorzo: { turns: 1, inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, weightedTokens: 2300 },
    }
    const grand = { turns: 3, inputTokens: 8000, outputTokens: 1300, cacheReadTokens: 0, cacheCreationTokens: 500, thinkingTokens: 0, weightedTokens: 9800 }
    const est = estimateSingleAgent(perRole, grand)
    // biggest context = implementalo: 5000 + 500 = 5500
    expect(est.inputTokens).toBe(5500)
    // outputs preserved across all roles
    expect(est.outputTokens).toBe(1300)
    expect(est.weightedTokens).toBe(6800) // 5500 + 1300
    // split overhead = 9800 - 6800 = 3000
    expect(est.splitOverheadWeighted).toBe(3000)
    expect(est.method).toBe('estimate')
  })

  it('never reports negative overhead', () => {
    const perRole = { solo: { turns: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, weightedTokens: 110 } }
    const grand = { turns: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, weightedTokens: 110 }
    const est = estimateSingleAgent(perRole, grand)
    expect(est.splitOverheadWeighted).toBeGreaterThanOrEqual(0)
  })
})

describe('normalizeRun', () => {
  it('accepts the run-3837120e legacy shape (run + baseline, no events)', () => {
    const r = normalizeRun({ run: 'run-abc', card: '#257', roles: { tervezo: 'usalackor' }, baseline: { 'lackor2-bot': { fiveHourPct: 0 } } })
    expect(r.runId).toBe('run-abc')
    expect(r.card).toBe('#257')
    expect(r.roles.tervezo).toBe('usalackor')
    expect(r.events).toEqual([])
  })

  it('accepts the run-2026 legacy shape (runId + sessionMap + events)', () => {
    const r = normalizeRun({ runId: 'run-xyz', cardId: '58ceda58', sessionMap: { 's1': 'orchestrator' }, events: [{ ts: 1, kind: 'start' }] })
    expect(r.runId).toBe('run-xyz')
    expect(r.sessionMap.s1).toBe('orchestrator')
    expect(r.events).toHaveLength(1)
  })
})

describe('buildReport', () => {
  it('aggregates per role, sums hand-off, and labels the single-agent estimate', () => {
    const transcripts: Record<string, string> = {
      's-plan': assistantLine({ id: 'p1', sessionId: 's-plan', ts: '2026-09-15T10:00:00Z', input: 1000, output: 200 }),
      's-impl': [
        assistantLine({ id: 'i1', sessionId: 's-impl', ts: '2026-09-15T10:05:00Z', input: 5000, output: 800, cacheCreation: 500 }),
        assistantLine({ id: 'i1', sessionId: 's-impl', ts: '2026-09-15T10:05:00Z', input: 5000, output: 800, cacheCreation: 500 }),
      ].join('\n'),
    }
    const run = normalizeRun({
      runId: 'run-test',
      card: '#257',
      startedAt: Date.parse('2026-09-15T10:00:00Z'),
      roles: { tervezo: 'usalackor', implementalo: 'kod-hid' },
      sessionMap: { 's-plan': 'tervezo', 's-impl': 'implementalo', 's-missing': 'ellenorzo' },
      events: [
        { ts: Date.parse('2026-09-15T10:00:00Z'), kind: 'start' },
        { ts: Date.parse('2026-09-15T10:02:00Z'), kind: 'handoff', note: 'terv atadva', payloadChars: 4000 },
      ],
    })
    const rep = buildReport(run, (sid: string) => parseUsageText(transcripts[sid] || '', ''))

    expect(rep.perRole.tervezo.inputTokens).toBe(1000)
    expect(rep.perRole.implementalo.inputTokens).toBe(5000) // collapsed, not 10000
    expect(rep.grandTotal.inputTokens).toBe(6000)
    // hand-off: 4000 chars -> ceil(4000/4)=1000 tok est
    expect(rep.handoff.chars).toBe(4000)
    expect(rep.handoff.tokEst).toBe(1000)
    // a mapped session with no transcript is reported as MISSING, not as zero
    expect(rep.sessionsMissing).toContain('s-missing')
    // estimate is clearly a model
    expect(rep.singleAgentEstimate.method).toBe('estimate')
    // timeline carries elapsed offsets
    expect(rep.timeline[1].elapsedMs).toBe(120000)
  })
})
