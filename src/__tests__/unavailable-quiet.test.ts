// #543: the menu watcher must not report (or send keys to) an agent that is proven unavailable.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { quietForUnavailable } from '../unavailable-quiet.js'
import type { AgentAvailability } from '../availability-transitions.js'

const NOW = 1_800_000_000_000
const MAX = 180_000
const row = (over: Partial<AgentAvailability>): AgentAvailability => ({ agent: 'a1', available: false, reason: 'quota', since: NOW - 60_000, resetsAt: NOW + 3_600_000, measuredAt: NOW - 30_000, ...over })

describe('quietForUnavailable', () => {
  it('a spent quota, freshly measured: quiet, with the reset time', () => {
    expect(quietForUnavailable([row({})], 'a1', NOW, MAX)).toEqual({ quiet: true, reason: 'quota', resetsAt: NOW + 3_600_000 })
  })
  it('a stopped agent: quiet', () => {
    expect(quietForUnavailable([row({ reason: 'stopped', resetsAt: null })], 'a1', NOW, MAX)).toEqual({ quiet: true, reason: 'stopped', resetsAt: null })
  })
  it('an available agent is reported as before', () => {
    expect(quietForUnavailable([row({ available: true, reason: 'ok' })], 'a1', NOW, MAX)).toEqual({ quiet: false })
  })
  it('"I cannot see" is not "unavailable": no row, an old measurement, a future one, no name', () => {
    expect(quietForUnavailable([], 'a1', NOW, MAX)).toEqual({ quiet: false })
    expect(quietForUnavailable([row({ agent: 'other' })], 'a1', NOW, MAX)).toEqual({ quiet: false })
    expect(quietForUnavailable([row({ measuredAt: NOW - MAX - 1 })], 'a1', NOW, MAX)).toEqual({ quiet: false })
    expect(quietForUnavailable([row({ measuredAt: NOW + MAX + 1 })], 'a1', NOW, MAX)).toEqual({ quiet: false })
    expect(quietForUnavailable([row({})], '', NOW, MAX)).toEqual({ quiet: false })
  })
})

describe('the menu watcher uses it (wiring)', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf8')
  it('the quiet branch comes first, keeps the login notice, and sends neither an alert nor a key', () => {
    const at = src.indexOf('const quiet = quietVerdictFor(')
    expect(at).toBeGreaterThan(0)
    const branch = src.slice(at, src.indexOf('} else if (paneNow == null) {', at))
    expect(branch).toContain('if (quiet.quiet && !(paneNow != null && detectsLoginInProgress(paneNow))) {')
    expect(branch).not.toContain('sendAlert(')
    expect(branch).not.toContain('send-keys')
    // every agent alike: the main agent is looked up by its configured id, never by a name in the code
    expect(src).toContain("quietVerdictFor(t.isMarveen ? MAIN_AGENT_ID : (t.agentName ?? ''))")
  })
  it('a failure to read availability means "not quiet"', () => {
    expect(src).toMatch(/function quietVerdictFor\(agent: string\): QuietVerdict \{\s*try \{[\s\S]*?\} catch \{\s*return \{ quiet: false \}/)
  })
})
