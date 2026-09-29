// The startup parity check reads the main agent's hooks from the config dir the
// main agent RUNS on. Measured 2026-09-29: the main agent ran with
// CLAUDE_CONFIG_DIR=~/.claude-marvin, the boot backfill had wired two new
// template hooks there, and the check -- still reading ~/.claude -- reported them
// as missing from the main agent (a false "agent parity" alert on every start).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'parity-cfgdir-'))
const REPO = join(SANDBOX, 'repo')
const ISOLATED = join(SANDBOX, 'home', '.claude-bot')
const alerts: string[] = []

vi.mock('../config.js', () => ({
  PROJECT_ROOT: join(SANDBOX, 'repo'),
  STORE_DIR: join(SANDBOX, 'repo', 'store'),
  MAIN_AGENT_ID: 'main-bot',
}))
vi.mock('../web/agent-scaffold.js', () => ({
  agentSettingsPath: () => join(SANDBOX, 'home', '.claude-bot', 'settings.json'),
}))
vi.mock('../web/channel-monitor.js', () => ({ sendAlert: (t: string) => { alerts.push(t) } }))
vi.mock('../web/skill-library-parity.js', () => ({
  skillLibraryParity: () => ({ verdict: 'ok', missing: [], checked: [], errors: [] }),
}))
vi.mock('../logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('../owner-lang.js', () => ({ ol: (hu: string) => hu }))

const { checkAgentParity } = await import('../web/agent-parity-check.js')

const hook = (script: string) => ({ type: 'command', command: `python3 /x/scripts/hooks/${script}` })
function writeSettings(path: string, scripts: string[]): void {
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: scripts.map(hook) }] } }))
}

describe('startup parity check: the main agent\'s OWN config dir', () => {
  beforeEach(() => {
    alerts.length = 0
    rmSync(REPO, { recursive: true, force: true })
    mkdirSync(join(REPO, 'templates'), { recursive: true })
    mkdirSync(join(REPO, 'store'), { recursive: true })
    mkdirSync(ISOLATED, { recursive: true })
    writeSettings(join(REPO, 'templates', 'settings.json.template'), ['alpha.py', 'skill-scope-gate.py'])
  })
  afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

  it('hooks wired into the isolated dir count: no drift, no alert', () => {
    writeSettings(join(ISOLATED, 'settings.json'), ['alpha.py', 'skill-scope-gate.py'])
    const r = checkAgentParity()
    expect(r.drift).toEqual([])
    expect(alerts).toEqual([])
  })

  it('a hook missing from the isolated dir is still reported (it reads THAT file)', () => {
    writeSettings(join(ISOLATED, 'settings.json'), ['alpha.py'])
    const r = checkAgentParity()
    expect(r.drift).toEqual([{ script: 'skill-scope-gate.py', direction: 'subagent-only' }])
    expect(alerts.join(' ')).toContain('skill-scope-gate.py')
  })
})
