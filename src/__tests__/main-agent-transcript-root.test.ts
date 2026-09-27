import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'

// #413 -- the main agent's transcript root. Every reader passed `undefined`
// for the main agent (= the shared ~/.claude), while its channels session runs
// on its own CLAUDE_CONFIG_DIR. Measured 2026-09-27: live transcript under
// ~/.claude-marvin written 03:10, guard + gate reading a 20-hour-old file under
// ~/.claude. Rebuilt from upstream d5d323af (GATEVAK917) + 10b4f331
// (GUARDCFGMASOLAT917) on our own resolver.

const effective = vi.hoisted(() => ({ dir: '' }))

vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    readAgentClaudeConfigDir: () => null,
    readAgentClaudePlan: () => null,
    resolveMainAgentConfigDir: () => null,
    mainAgentEffectiveConfigDir: () => effective.dir,
  }
})

const { resolveAgentConfigDirForRead } = await import('../web/claude-plans.js')

describe('resolveAgentConfigDirForRead(MAIN_AGENT_ID)', () => {
  beforeEach(() => { effective.dir = '' })

  it('returns the isolated root the main channels session actually runs on', () => {
    effective.dir = '/srv/x/.channels-config'
    expect(resolveAgentConfigDirForRead(MAIN_AGENT_ID)).toBe('/srv/x/.channels-config')
  })

  it('returns null (shared default) when the main agent runs on ~/.claude', () => {
    effective.dir = join(homedir(), '.claude')
    expect(resolveAgentConfigDirForRead(MAIN_AGENT_ID)).toBeNull()
  })

  it('a sub-agent never inherits the main agent root', () => {
    effective.dir = '/srv/x/.channels-config'
    expect(resolveAgentConfigDirForRead('some-sub-agent', '/nonexistent-root')).toBeNull()
  })
})

describe('every main-agent transcript reader goes through the one resolver', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  it.each([
    'web/context-guard-runner.ts',
    'web/context-restart-gate-runner.ts',
    'web/routes/agents.ts',
  ])('%s has no main-agent exemption from the config root', (file) => {
    const s = src(file)
    expect(s).not.toMatch(/MAIN_AGENT_ID \? undefined/)
    expect(s).not.toMatch(/isMain \? undefined/)
    expect(s).toContain('resolveAgentConfigDirForRead(name)')
  })

  it.each([
    'web/routes/marveen.ts',
    'web/main-agent-model.ts',
  ])('%s reads the main transcript from the resolved root', (file) => {
    expect(src(file)).toContain('resolveAgentConfigDirForRead(MAIN_AGENT_ID)')
  })
})
