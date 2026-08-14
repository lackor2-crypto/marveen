// The context-restart gate could not see any sub-agent's context (2026-08-12).
//
// readContextTokensFromProjectDir() locates the transcript under a Claude config
// root. An agent running on its own Claude account is launched with
// CLAUDE_CONFIG_DIR pointing at store/accounts/<acct>, so without that argument
// the lookup lands in ~/.claude, finds nothing and returns null. The gate called
// it with one argument. Every sweep therefore decided
// "context-tokens-unmeasurable (fail-closed)" and blocked -- silently, at debug
// level -- while the agent sat at 327311 tokens against a 100000 threshold. Boss
// reported this twice as "the cleanup does not work", and it did not.
//
// Measured on this install at the time of the fix, for agent lackor3:
//   readContextTokensFromProjectDir(dir)             -> null
//   readContextTokensFromProjectDir(dir, configDir)  -> 326387
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { projectsDirFor } from '../web/active-model.js'
import { chooseReclaimAction, normalizeGateConfig, COMPACT_RETRY_WINDOW_MS } from '../context-restart-gate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', 'web')

function source(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
}

describe('context readers are account-aware', () => {
  it('projectsDirFor honours an explicit config root', () => {
    const own = projectsDirFor('/srv/app/agents/probe', '/srv/app/store/accounts/acct')
    expect(own).toBe('/srv/app/store/accounts/acct/projects/-srv-app-agents-probe')
    // Without it the lookup falls back to the home config root, which is a
    // different account's transcripts -- or, more often, nothing at all.
    expect(projectsDirFor('/srv/app/agents/probe')).not.toBe(own)
  })

  // Both runners read the same measurement. Neither may drop the config root.
  for (const file of ['context-restart-gate-runner.ts', 'context-guard-runner.ts']) {
    it(`${file} passes a resolved config dir to the token reader`, () => {
      const src = source(file)
      // Either reader is fine (the gate uses the state-carrying one so it can
      // tell a fresh session from a broken measurement), but neither may be
      // called without the config root.
      const calls = [...src.matchAll(/readContext(?:Tokens|Reading)FromProjectDir\(([^)]*)\)/g)].map((m) => m[1])
      expect(calls.length).toBeGreaterThan(0)
      for (const args of calls) {
        expect(args).toContain(',')
        expect(args).toMatch(/configDir/)
      }
      expect(src).toMatch(/resolveAgentConfigDir|readAgentClaudeConfigDir/)
    })
  }

  // The gate's own decisions were invisible: logged at debug while the logger
  // runs at info. A published status is what makes "why has it not cleared?"
  // answerable without a code read.
  it('the gate publishes its live decision', () => {
    const src = source('context-restart-gate-runner.ts')
    expect(src).toContain('writeGateStatus(')
    const store = source('context-restart-gate-store.ts')
    expect(store).toContain('context-restart-gate-status.json')
    // Observability must never be able to break the gate itself.
    expect(store).toMatch(/catch \{[^}]*\}\s*\n?\s*}\s*\n\s*export function readGateStatus/)
  })
})

// The gate compacts; it never wipes. Both halves of the old escalation were
// wrong (2026-08-14): it measured regrowth as a failed compaction, and it
// answered that with /clear. Wiping a session is a person's call now.
describe('chooseReclaimAction', () => {
  const base = {
    lastCompactAt: null as number | null,
    lastCompactTokens: null as number | null,
    lastCompactMinSeen: null as number | null,
    nowMs: 1_000_000_000,
  }

  it('compacts when nothing has been tried yet', () => {
    expect(chooseReclaimAction(base).action).toBe('compact')
  })

  it('can never return clear, whatever the evidence', () => {
    const cases = [
      base,
      { ...base, lastCompactAt: base.nowMs - 60_000, lastCompactTokens: 120_000, lastCompactMinSeen: 119_000 },
      { ...base, lastCompactAt: base.nowMs - 60_000, lastCompactTokens: 120_000, lastCompactMinSeen: null },
      { ...base, lastCompactAt: base.nowMs - 60_000, lastCompactTokens: 0, lastCompactMinSeen: 0 },
    ]
    for (const c of cases) expect(['compact', 'hold']).toContain(chooseReclaimAction(c).action)
  })

  // THE bug this rewrite exists for. A compaction that took the session from
  // 120k down to 9k worked -- it does not stop working because the agent then
  // did an hour of useful work and grew back to 119k. The old code compared the
  // pre-compaction size against the LIVE size, read that as "compaction is
  // useless", and wiped the conversation for it.
  it('does not punish regrowth after a compaction that demonstrably worked', () => {
    const d = chooseReclaimAction({
      ...base, lastCompactAt: base.nowMs - 60_000,
      lastCompactTokens: 120_000, lastCompactMinSeen: 9_000,   // live size is back at 119k
    })
    expect(d.action).toBe('compact')
  })

  // Evidence of real failure: the session never got smaller at any point.
  it('holds when the previous compaction never shrank the session', () => {
    const d = chooseReclaimAction({
      ...base, lastCompactAt: base.nowMs - 60_000,
      lastCompactTokens: 120_000, lastCompactMinSeen: 119_000,
    })
    expect(d.action).toBe('hold')
    expect(d.reason).toContain('120000 -> 119000')
    expect(d.reason).toContain('manual')
  })

  // Re-sending /compact every sweep would be the same thrashing loop, one level
  // up. Holding is the point: it stops, and says why.
  it('holds rather than retrying while a dispatched compaction is unmeasured', () => {
    const d = chooseReclaimAction({
      ...base, lastCompactAt: base.nowMs - 60_000,
      lastCompactTokens: 120_000, lastCompactMinSeen: null,
    })
    expect(d.action).toBe('hold')
  })

  // Outside the window a still-large context is new growth, not proof of failure.
  it('compacts again once the previous attempt is old', () => {
    const d = chooseReclaimAction({
      ...base, lastCompactAt: base.nowMs - (COMPACT_RETRY_WINDOW_MS + 1),
      lastCompactTokens: 120_000, lastCompactMinSeen: 119_000,
    })
    expect(d.action).toBe('compact')
  })

  it('retries on a legacy record with no recorded size', () => {
    const d = chooseReclaimAction({ ...base, lastCompactAt: base.nowMs - 60_000, lastCompactTokens: null })
    expect(d.action).toBe('compact')
  })

  // preferCompact is gone: there is no longer a config that turns compaction
  // off in favour of wiping, because wiping is not an automatic option at all.
  it('carries no preferCompact switch any more', () => {
    expect('preferCompact' in normalizeGateConfig({})).toBe(false)
    const gate = readFileSync(join(__dirname, '..', 'context-restart-gate.ts'), 'utf8')
    expect(gate).not.toContain('preferCompact')
  })

  // A guard against the escalation creeping back in.
  it('leaves no path from the sweep to /clear', () => {
    const runner = source('context-restart-gate-runner.ts')
    expect(runner).not.toContain("'/clear'")
    expect(runner).toContain('isCompactionInFlight(')
  })
})
