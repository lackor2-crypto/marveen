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
      const calls = [...src.matchAll(/readContextTokensFromProjectDir\(([^)]*)\)/g)].map((m) => m[1])
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

// Compact-before-clear (Boss approved 2026-08-12): a threshold that only ever
// wipes was never what he asked for. /clear stays as the fallback for what
// compaction cannot fix -- Claude Code refuses to compact a short session, and a
// context dominated by one huge turn can survive it.
describe('chooseReclaimAction', () => {
  const base = { contextTokens: 120_000, preferCompact: true, lastCompactAt: null, lastCompactTokens: null, nowMs: 1_000_000_000 }

  it('compacts when nothing has been tried yet', () => {
    expect(chooseReclaimAction(base).action).toBe('compact')
  })

  it('wipes when compaction is switched off for the agent', () => {
    expect(chooseReclaimAction({ ...base, preferCompact: false }).action).toBe('clear')
  })

  // Evidence of failure, not a timer: the previous compaction left the context
  // where it was, so compacting again would just burn another round.
  it('escalates to clear when the previous compaction did not shrink anything', () => {
    const d = chooseReclaimAction({ ...base, contextTokens: 119_000, lastCompactAt: base.nowMs - 60_000, lastCompactTokens: 120_000 })
    expect(d.action).toBe('clear')
    expect(d.reason).toContain('120000 -> 119000')
  })

  it('compacts again when the previous compaction clearly worked', () => {
    // The real measurement on this install: 101222 -> 5597, then growth back up.
    const d = chooseReclaimAction({ ...base, contextTokens: 101_222, lastCompactAt: base.nowMs - 60_000, lastCompactTokens: 300_000 })
    expect(d.action).toBe('compact')
  })

  // Outside the window a still-large context is new growth, not proof of failure.
  it('compacts again once the previous attempt is old', () => {
    const d = chooseReclaimAction({ ...base, contextTokens: 120_000, lastCompactAt: base.nowMs - (COMPACT_RETRY_WINDOW_MS + 1), lastCompactTokens: 120_000 })
    expect(d.action).toBe('compact')
  })

  it('does not wipe on a legacy record with no recorded size', () => {
    const d = chooseReclaimAction({ ...base, lastCompactAt: base.nowMs - 60_000, lastCompactTokens: null })
    expect(d.action).toBe('compact')
  })

  it('defaults preferCompact to on, and honours an explicit false', () => {
    expect(normalizeGateConfig({}).preferCompact).toBe(true)
    expect(normalizeGateConfig({ preferCompact: false }).preferCompact).toBe(false)
  })
})
