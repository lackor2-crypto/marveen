// Boss, twice in one evening, watching his agent climb past a setting he had
// made: "nem lehet ezt megkadalyozni hogy 80 ezertol feljebb menjen?"
//
// Not from outside, not entirely: every ceiling this fork can enforce needs the
// agent to be idle, and an agent that works for an hour straight is not idle
// once in that hour. Claude Code's own --autocompact window is the one that
// acts mid-turn, so it goes underneath ours as the net.
//
// Two things must hold, and both are the kind that break silently:
//   - the value stays inside the range the CLI accepts (100k-1M), whatever is
//     in .env,
//   - EVERY launch path carries the flag. There are three (the dashboard and
//     two watchdog scripts), and a fleet where only some agents have a ceiling
//     is exactly the split-behaviour this repo has been bitten by before.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('the autocompact window is clamped to what the CLI accepts', () => {
  const config = read('src/config.ts')

  it('clamps to the documented 100k-1M range', () => {
    expect(config).toContain('AUTOCOMPACT_MIN = 100_000')
    expect(config).toContain('AUTOCOMPACT_MAX = 1_000_000')
    expect(config).toMatch(/Math\.min\(AUTOCOMPACT_MAX, Math\.max\(AUTOCOMPACT_MIN,/)
  })

  it('treats 0 or a nonsense value as "no flag" rather than as a number', () => {
    expect(config).toMatch(/Number\.isFinite\(autocompactRaw\) && autocompactRaw > 0/)
    expect(config).toMatch(/:\s*0\b/)
  })

  it('is documented for the operator', () => {
    expect(read('.env.example')).toContain('AUTOCOMPACT_TOKENS')
  })
})

describe('every launch path carries the flag', () => {
  // The dashboard-started agents.
  it('the dashboard adds it to the spawn command', () => {
    const src = read('src/web/agent-process.ts')
    expect(src).toContain('autocompactFlag()')
    expect(src).toMatch(/\$\{autocompactFlag\(\)\}/)
  })

  // Both watchdogs respawn agents on their own, without the dashboard.
  for (const script of ['scripts/watchdog.sh', 'scripts/channel-watchdog.sh']) {
    it(`${script} adds it to the respawn command`, () => {
      const src = read(script)
      expect(src).toContain('AUTOCOMPACT_FLAG')
      expect(src).toContain('${AUTOCOMPACT_FLAG}')
      // Read from .env, never hardcoded to this install.
      expect(src).toContain('AUTOCOMPACT_TOKENS=')
    })
  }
})

describe('the flag is probed, never assumed', () => {
  // An unknown flag would stop an agent from starting at all. A context-size
  // convenience must never be able to take the fleet down.
  it('the dashboard checks --help before using it', () => {
    const src = read('src/web/agent-process.ts')
    expect(src).toMatch(/--help/)
    expect(src).toContain("help.includes('--autocompact')")
  })

  for (const script of ['scripts/watchdog.sh', 'scripts/channel-watchdog.sh']) {
    it(`${script} checks --help before using it`, () => {
      expect(read(script)).toMatch(/--help[\s\S]{0,80}grep -q -- '--autocompact'/)
    })
  }
})
