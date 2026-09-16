import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// MAIN_AGENT_CONFIG_DIR: an EXPLICIT CLAUDE_CONFIG_DIR for the main channels
// agent, for the operator whose bot has its own Claude login (separate from the
// fleet's). Distinct from MAIN_AGENT_ISOLATED_CONFIG, which authenticates from
// the fleet setup-token and therefore cannot keep the two identities apart.
let SANDBOX = ''
let SETTING = ''

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'MAIN_AGENT_CONFIG_DIR' ? SETTING : actual.getEffectiveSettingValue(key),
  }
})

const { resolveMainAgentConfigDir } = await import('../web/agent-process.js')
const { provisionMainAgentConfigDir } = await import('../web/agent-config.js')
const { resolveAgentConfigDir } = await import('../web/claude-plans.js')
const { MAIN_AGENT_ID } = await import('../config.js')

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'maincfg-'))
  mkdirSync(join(SANDBOX, 'home', '.claude-bot'), { recursive: true })
  SETTING = ''
})
afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('resolveMainAgentConfigDir', () => {
  it('returns null when the setting is unset (shared ~/.claude, unchanged default)', () => {
    expect(resolveMainAgentConfigDir()).toBeNull()
  })

  it('resolves an absolute path that exists', () => {
    SETTING = join(SANDBOX, 'home', '.claude-bot')
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })

  it('expands a leading ~ against the home dir', () => {
    SETTING = '~/.claude-bot'
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })

  it('returns null (not the unresolved path) when the dir does not exist', () => {
    // Falling back to the shared root is the safe failure: launching with a
    // non-existent CLAUDE_CONFIG_DIR would start the bot logged-out.
    SETTING = join(SANDBOX, 'home', '.claude-nope')
    expect(resolveMainAgentConfigDir()).toBeNull()
  })

  it('trims surrounding whitespace from a hand-edited .env value', () => {
    SETTING = `  ${join(SANDBOX, 'home', '.claude-bot')}  `
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })
})

// The whole point of moving the resolver into agent-config.ts: the dashboard
// READERS resolve the main agent's config dir through resolveAgentConfigDir(),
// so the account badge, the default-login dependents and the drift check read
// the SAME dir the launcher boots the main agent from -- instead of the main
// agent uniquely defaulting to the shared ~/.claude that VS Code also writes to.
describe('resolveAgentConfigDir(MAIN_AGENT_ID) honours the isolated dir', () => {
  it('falls back to null (shared ~/.claude, unchanged) when the setting is unset', () => {
    // No per-agent override for the main agent, no MAIN_AGENT_CONFIG_DIR -> null,
    // byte-identical to the pre-change behaviour.
    expect(resolveAgentConfigDir(MAIN_AGENT_ID).configDir).toBeNull()
  })

  it('returns the explicit MAIN_AGENT_CONFIG_DIR when set', () => {
    SETTING = join(SANDBOX, 'home', '.claude-bot')
    expect(resolveAgentConfigDir(MAIN_AGENT_ID).configDir).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })
})

// The login button ACTIVATES the isolation, so it must be able to log into a dir
// that does not exist yet. resolveMainAgentConfigDir() (the reader) deliberately
// returns null for a missing dir; provisionMainAgentConfigDir() (the login path)
// CREATES it, so `claude auth login` can write .credentials.json inside. Without
// this the operator could never activate the isolation from the UI: the login
// would fall back to ~/.claude and never populate the configured dir.
describe('provisionMainAgentConfigDir', () => {
  it('returns null and creates nothing when the setting is unset', () => {
    expect(provisionMainAgentConfigDir()).toBeNull()
  })

  it('CREATES a not-yet-existing dir and returns it (activation from the UI)', () => {
    const target = join(SANDBOX, 'home', '.claude-bot-new')
    SETTING = target
    // The read-only resolver still refuses it (does not exist yet)...
    expect(resolveMainAgentConfigDir()).toBeNull()
    // ...but the login path provisions it so the credentials can land inside.
    expect(provisionMainAgentConfigDir()).toBe(target)
    expect(existsSync(target) && statSync(target).isDirectory()).toBe(true)
    // Once populated, the reader picks it up too.
    expect(resolveMainAgentConfigDir()).toBe(target)
  })

  it('expands a leading ~ before creating', () => {
    SETTING = '~/.claude-bot-tilde'
    const target = join(SANDBOX, 'home', '.claude-bot-tilde')
    expect(provisionMainAgentConfigDir()).toBe(target)
    expect(existsSync(target)).toBe(true)
  })
})

describe('launcher wiring', () => {
  const HELPER = readFileSync(join(__dirname, '../../scripts/main-agent-isolated-config.mjs'), 'utf-8')
  const CHANNELS = readFileSync(join(__dirname, '../../scripts/channels.sh'), 'utf-8')

  it('the helper prefers the explicit dir over the isolated one', () => {
    expect(HELPER).toMatch(/const explicit = resolveMainAgentConfigDir\(\)[\s\S]*if \(explicit\)/)
  })

  it('the helper tags each path with its mode so the caller knows how to authenticate', () => {
    expect(HELPER).toMatch(/explicit\\t/)
    expect(HELPER).toMatch(/isolated\\t/)
  })

  it('channels.sh never injects the fleet token for an explicit dir', () => {
    // The explicit dir carries its OWN .credentials.json -- exporting the fleet
    // token there would silently authenticate the bot as the fleet.
    const explicitBranch = CHANNELS.match(/if \[ "\$_cfg_mode" = "explicit" \]; then\n([\s\S]*?)\n\s*else/)
    expect(explicitBranch).not.toBeNull()
    expect(explicitBranch?.[1]).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/)
    expect(explicitBranch?.[1]).toMatch(/CLAUDE_CONFIG_DIR/)
  })
})
