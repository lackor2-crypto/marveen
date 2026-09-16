import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Regression for kanban #293: the main channels agent runs on an ISOLATED
// CLAUDE_CONFIG_DIR since #290 (MAIN_AGENT_CONFIG_DIR / .channels-config), but the
// hook/settings writers hardcoded ~/.claude -- so NO fleet hook (telegram_progress
// "Dolgozom rajta", rate-limit-guard, audit-log, no-stray-files gate) reached it.
// mainAgentEffectiveConfigDir() reunites the writers with the dir the agent reads,
// and agentSettingsPath(MAIN_AGENT_ID) + ensureAgentHooks(MAIN_AGENT_ID) follow it.

let SANDBOX = ''
let CFG_SETTING = '' // MAIN_AGENT_CONFIG_DIR (explicit)
let ISO_SETTING = '' // MAIN_AGENT_ISOLATED_CONFIG ('1' = on)

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'MAIN_AGENT_CONFIG_DIR' ? CFG_SETTING
        : key === 'MAIN_AGENT_ISOLATED_CONFIG' ? ISO_SETTING
          : actual.getEffectiveSettingValue(key),
  }
})

const { mainAgentEffectiveConfigDir } = await import('../web/agent-config.js')
const { agentSettingsPath, ensureAgentHooks } = await import('../web/agent-scaffold.js')
const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')

const ISO_DIR = join(PROJECT_ROOT, '.channels-config')

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'maineff-'))
  mkdirSync(join(SANDBOX, 'home', '.claude'), { recursive: true })
  mkdirSync(join(SANDBOX, 'home', '.claude-bot'), { recursive: true })
  CFG_SETTING = ''
  ISO_SETTING = ''
  // The isolated dir must not leak between cases; each case that wants it
  // creates it explicitly.
  rmSync(ISO_DIR, { recursive: true, force: true })
})
afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  rmSync(ISO_DIR, { recursive: true, force: true })
})

describe('mainAgentEffectiveConfigDir', () => {
  it('falls back to the shared ~/.claude when nothing is configured (fresh install)', () => {
    expect(mainAgentEffectiveConfigDir()).toBe(join(SANDBOX, 'home', '.claude'))
  })

  it('uses the explicit MAIN_AGENT_CONFIG_DIR when set and present', () => {
    CFG_SETTING = join(SANDBOX, 'home', '.claude-bot')
    expect(mainAgentEffectiveConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })

  it('uses the fleet-isolated .channels-config only once it has been provisioned', () => {
    ISO_SETTING = '1'
    // Not yet provisioned -> shared root (fresh install with isolation flag on
    // but no dir/token yet is the SAFE default, not a broken logged-out launch).
    expect(mainAgentEffectiveConfigDir()).toBe(join(SANDBOX, 'home', '.claude'))
    // Launcher provisioned it -> the writers must target it.
    mkdirSync(ISO_DIR, { recursive: true })
    expect(mainAgentEffectiveConfigDir()).toBe(ISO_DIR)
  })

  it('prefers the explicit dir over the fleet-isolated one', () => {
    CFG_SETTING = join(SANDBOX, 'home', '.claude-bot')
    ISO_SETTING = '1'
    mkdirSync(ISO_DIR, { recursive: true })
    expect(mainAgentEffectiveConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })
})

describe('agentSettingsPath(MAIN_AGENT_ID)', () => {
  it('is the settings.json inside the effective config dir, not a hardcoded ~/.claude', () => {
    CFG_SETTING = join(SANDBOX, 'home', '.claude-bot')
    expect(agentSettingsPath(MAIN_AGENT_ID)).toBe(join(SANDBOX, 'home', '.claude-bot', 'settings.json'))
  })
})

describe('ensureAgentHooks(MAIN_AGENT_ID) reaches the running config dir', () => {
  it('writes the telegram_progress hook into the isolated dir, NOT the shared ~/.claude', () => {
    CFG_SETTING = join(SANDBOX, 'home', '.claude-bot')
    const changed = ensureAgentHooks(MAIN_AGENT_ID)
    expect(changed).toBe(true)

    const isolated = join(SANDBOX, 'home', '.claude-bot', 'settings.json')
    expect(existsSync(isolated)).toBe(true)
    const isolatedJson = readFileSync(isolated, 'utf-8')
    // The very hook whose absence Boss reported ("Dolgozom rajta" never posted).
    expect(isolatedJson).toContain('telegram_progress.py')

    // The shared ~/.claude must NOT have received the main agent's fleet hooks
    // from this call -- that file is the operator's own, and writing there is
    // exactly the pre-#290 coupling this fix removes.
    const shared = join(SANDBOX, 'home', '.claude', 'settings.json')
    if (existsSync(shared)) {
      expect(readFileSync(shared, 'utf-8')).not.toContain('telegram_progress.py')
    }
  })
})
