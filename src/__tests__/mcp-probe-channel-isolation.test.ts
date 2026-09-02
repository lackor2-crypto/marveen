// A health probe must never be able to reach a LIVE channel state directory.
//
// MEASURED 2026-09-02 (kanban #193). The telegram plugin resolves
//
//     STATE_DIR = TELEGRAM_STATE_DIR ?? (CLAUDE_CONFIG_DIR ?? ~/.claude)/channels/telegram
//
// and, before it starts polling, SIGTERMs whatever pid `<STATE_DIR>/bot.pid`
// names. refreshMcpStatus() probes the install default FIRST -- no
// CLAUDE_CONFIG_DIR, no TELEGRAM_STATE_DIR -- so that one probe landed in the
// live bridge's own state dir and killed its poller. 305 of the 359 recorded
// takeovers in ~/.cache/claude-cli-nodejs/-home-boss-marveen carry the
// `claude mcp list` signature (8 log lines, one SIGINT, "connection closed
// after 2s"); the other 54 are legitimate `--channels` session starts.
//
// The counter-evidence from the same measurement: the two sub-agent pollers,
// which DO get an explicit TELEGRAM_STATE_DIR, had been up 6h40m while the main
// bridge's unisolated poller was 26 minutes old.
//
// WHY THE PROBES ARE TESTED BEHAVIOURALLY. The first draft of this file scanned
// the source for the string `channelProbeStateEnv()` -- and a mental revert
// proved it worthless: stripping the env from runMcpList left the OTHER call in
// the same file, so the scan stayed green while the bridge-killing probe was
// back. So each probe now really runs, against a stub `claude` on PATH that
// dumps its environment, and the assertion is on what the child actually got.
// The source scan that remains has one narrow job: notice a NEW probe site.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  channelProbeStateEnv, channelStateNowhereDirs,
  CHANNEL_STATE_ENV_VAR, CHANNEL_TOKEN_ENV_VARS,
} from '../web/mcp-probe-env.js'
import { getProvider, type ChannelProviderType } from '../channel-provider.js'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')
const webDir = join(projectRoot, 'src', 'web')

describe('channelProbeStateEnv (a szonda nem er el elo csatorna-allapotot)', () => {
  it('minden csatorna-szolgaltatohoz ad egy allapot-konyvtar valtozot', () => {
    const env = channelProbeStateEnv()
    const expected = [...Object.values(CHANNEL_STATE_ENV_VAR), ...CHANNEL_TOKEN_ENV_VARS].sort()
    expect(Object.keys(env).sort()).toEqual(expected)
    // Guard against a silently emptied map: an empty object would satisfy the
    // comparison above on its own.
    expect(Object.values(CHANNEL_STATE_ENV_VAR).length).toBeGreaterThanOrEqual(5)
    expect(expected).toContain('TELEGRAM_STATE_DIR')
  })

  it('a bot-tokeneket kiuriti, hogy a plugin a token-kapunal alljon meg', () => {
    const env = channelProbeStateEnv()
    // The plugin's `if (!TOKEN)` gate fires BEFORE its mkdirSync/bot.pid work,
    // so a blanked token is what keeps "semmit nem hoz letre a lemezen" true
    // even if a token ever leaks into the dashboard's environment.
    expect(CHANNEL_TOKEN_ENV_VARS.length).toBeGreaterThanOrEqual(4)
    for (const tokenVar of CHANNEL_TOKEN_ENV_VARS) {
      expect(env[tokenVar], `${tokenVar} nincs kiuritve`).toBe('')
    }
  })

  it('egyik ertek sem mutat valodi csatorna-konyvtarba', () => {
    const env = channelProbeStateEnv()
    const home = homedir()
    const stateVars = Object.values(CHANNEL_STATE_ENV_VAR) as string[]
    for (const [key, value] of Object.entries(env).filter(([k]) => stateVars.includes(k))) {
      expect(value.startsWith(tmpdir()), `${key} nem a temp alatt van: ${value}`).toBe(true)
      expect(value).toContain('marveen-mcp-probe')
      // The two places that actually hold bot tokens: the shared default, and
      // anything under the agents tree.
      expect(value.startsWith(join(home, '.claude', 'channels'))).toBe(false)
      expect(value).not.toContain(`${sep}agents${sep}`)
    }
  })

  it('semmit nem hoz letre a lemezen', () => {
    const env = channelProbeStateEnv()
    for (const stateVar of Object.values(CHANNEL_STATE_ENV_VAR)) {
      const value = env[stateVar]!
      expect(existsSync(value), `letrejott: ${value}`).toBe(false)
      expect(existsSync(dirname(value)), `letrejott a szulo: ${dirname(value)}`).toBe(false)
    }
  })

  it('ugyanaz a bazis egy folyamaton belul, es kitalalhatatlan', () => {
    const a = channelProbeStateEnv()
    const b = channelProbeStateEnv()
    expect(a).toEqual(b)
    // Per-process + random: a predictable /tmp path is a planting target, and a
    // planted .env would hand the probe a foreign bot token.
    expect(dirname(a.TELEGRAM_STATE_DIR)).toMatch(/marveen-mcp-probe-\d+-[0-9a-f]{12}$/)
  })
})

// --- the behavioural half -----------------------------------------------------

const HAS_SH = process.platform !== 'win32'

/** A stub `claude` first on PATH that records the environment it was given. */
function stubClaude(): { dir: string; dump: string } {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-probe-test-'))
  const dump = join(dir, 'env.txt')
  const bin = join(dir, 'claude')
  writeFileSync(bin, `#!/bin/sh\nenv > '${dump}'\necho 'No MCP servers configured.'\nexit 0\n`, { mode: 0o755 })
  return { dir, dump }
}

function dumpedEnv(dump: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(dump, 'utf-8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

/**
 * What every probe's child process must be true of, whatever route it took.
 * The live directories are named explicitly rather than "not the probe dir":
 * a probe pointed at a THIRD live dir would pass a negative-only assertion.
 */
function expectIsolated(env: Record<string, string>, home: string) {
  for (const varName of Object.values(CHANNEL_STATE_ENV_VAR)) {
    expect(env[varName], `${varName} hianyzik a szonda kornyezetebol`).toBeTruthy()
  }
  expect(env.TELEGRAM_STATE_DIR).toContain('marveen-mcp-probe')
  expect(env.TELEGRAM_STATE_DIR).not.toBe(join(home, '.claude', 'channels', 'telegram'))
  expect(env.TELEGRAM_STATE_DIR.startsWith(join(home, '.claude'))).toBe(false)
  expect(env.TELEGRAM_STATE_DIR).not.toContain(`${sep}agents${sep}`)
  for (const tokenVar of CHANNEL_TOKEN_ENV_VARS) {
    expect(env[tokenVar] ?? '', `${tokenVar} eljutott a szondahoz`).toBe('')
  }
}

describe.skipIf(!HAS_SH)('a valodi szonda-hivasok izolalt kornyezetet adnak at', () => {
  let stub: { dir: string; dump: string }
  let savedPath: string | undefined
  let fakeHome: string

  beforeEach(() => {
    stub = stubClaude()
    savedPath = process.env.PATH
    // A HOME of its own, so the assertions below can name "the live channel
    // dir" without the test being able to touch the real one.
    fakeHome = mkdtempSync(join(tmpdir(), 'marveen-probe-home-'))
    mkdirSync(join(fakeHome, '.claude', 'channels', 'telegram'), { recursive: true })
    process.env.PATH = `${stub.dir}${process.platform === 'win32' ? ';' : ':'}${savedPath ?? ''}`
    // The dashboard is routinely started from an agent's tmux pane, so a LIVE
    // state dir in the inherited environment is a realistic starting point --
    // and the one the fix has to override, not merely add to.
    process.env.TELEGRAM_STATE_DIR = join(fakeHome, '.claude', 'channels', 'telegram')
    // Likewise a token: the assertion below has to watch an OVERRIDE happen, not
    // an absence. A leaked token would let the plugin start a second poller.
    process.env.TELEGRAM_BOT_TOKEN = '123456789:AAH-not-a-real-token'
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.TELEGRAM_STATE_DIR
    delete process.env.TELEGRAM_BOT_TOKEN
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath
    rmSync(stub.dir, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('refreshMcpStatus() (a Kapcsolatok lap szondaja)', async () => {
    const mod = await import('../web/mcp-runner.js')
    await mod.refreshMcpStatus()
    expect(existsSync(stub.dump), 'a szonda el sem indult').toBe(true)
    const env = dumpedEnv(stub.dump)
    expectIsolated(env, fakeHome)
  })

  it('refreshMcpListCache() (a Csatlakozok lap szondaja)', async () => {
    const mod = await import('../web/mcp-list.js')
    await mod.refreshMcpListCache()
    expect(existsSync(stub.dump), 'a szonda el sem indult').toBe(true)
    const env = dumpedEnv(stub.dump)
    expectIsolated(env, fakeHome)
  })
})

// --- coverage: no probe site may be added without coming through here ---------

/** Every source file that spawns `claude mcp <something>`, found by scanning. */
function filesSpawningClaudeMcp(): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.ts')) continue
      // `['mcp', 'list']` / `[bin, 'mcp', 'login', ...]` -- the two argv shapes
      // the CLI is actually invoked with.
      if (/['"]mcp['"]\s*,\s*['"](list|login)['"]/.test(readFileSync(full, 'utf-8'))) {
        hits.push(entry.name)
      }
    }
  }
  walk(webDir)
  return hits.sort()
}

describe('szonda-leltar', () => {
  it('pontosan a ket ismert hely spawnol `claude mcp`-t', () => {
    // Not a style rule: each probe site needs its OWN behavioural test above,
    // because a shared source scan cannot tell one call site from another (that
    // is exactly how the first draft of this file passed while broken). A new
    // file here means: add its test, then update this list.
    expect(filesSpawningClaudeMcp()).toEqual(['mcp-list.ts', 'mcp-runner.ts'])
  })

  it('a bejelentkezo tmux-panel is izolalt', () => {
    // `claude auth login` runs on the install default whenever the login is for
    // the default account. spawnArgs() is module-private, so this is checked in
    // the source -- but scoped to that function's body, so isolation elsewhere
    // in the file cannot stand in for it.
    const src = readFileSync(join(webDir, 'claude-auth-runner.ts'), 'utf-8')
    const body = src.match(/function spawnArgs\([\s\S]*?\n\}/)
    expect(body, 'spawnArgs() eltunt a claude-auth-runner.ts-bol').not.toBeNull()
    expect(body![0]).toContain('channelProbeStateEnv()')
  })
})

// --- the credential list is DERIVED, not hand-maintained ----------------------

describe('CHANNEL_TOKEN_ENV_VARS a szolgaltato-nyilvantartasbol szarmazik', () => {
  const providers = Object.keys(CHANNEL_STATE_ENV_VAR) as ChannelProviderType[]

  it('minden szolgaltato osszes sajat kulcsat tartalmazza', () => {
    // The hand-written list named four variables while the registry already
    // described nine, so googlechat and teams were simply absent. Deriving is
    // what makes a NEW provider impossible to forget.
    for (const provider of providers) {
      for (const key of getProvider(provider).envKeys) {
        if (key === 'GOOGLE_APPLICATION_CREDENTIALS') continue
        expect(CHANNEL_TOKEN_ENV_VARS, `${provider}.${key} kimaradt`).toContain(key)
      }
    }
    // The two that were missing, named explicitly: a derivation that silently
    // returned [] would satisfy nothing here.
    expect(CHANNEL_TOKEN_ENV_VARS).toContain('GOOGLECHAT_PROJECT_ID')
    expect(CHANNEL_TOKEN_ENV_VARS).toContain('TEAMS_BOT_APP_ID')
    expect(CHANNEL_TOKEN_ENV_VARS).toContain('TEAMS_BOT_APP_PASSWORD')
    expect(CHANNEL_TOKEN_ENV_VARS.length).toBeGreaterThanOrEqual(9)
  })

  it('a NEM csatorna-specifikus Google valtozot kihagyja', () => {
    // Blanking it would break unrelated Google tooling in the same process --
    // a workspace MCP server would fail its health check and the Connections
    // page would call a working connector broken.
    expect(getProvider('googlechat').envKeys).toContain('GOOGLE_APPLICATION_CREDENTIALS')
    expect(CHANNEL_TOKEN_ENV_VARS).not.toContain('GOOGLE_APPLICATION_CREDENTIALS')
  })

  it('nincs duplikatum (a slack ket kulcsa, a tobbi egy)', () => {
    expect(new Set(CHANNEL_TOKEN_ENV_VARS).size).toBe(CHANNEL_TOKEN_ENV_VARS.length)
  })
})

// --- the agent launch: every provider gets a state dir, not just its own ------

describe('buildChannelStateExports (az agens inditasa)', () => {
  const CHAN = '/home/x/marveen/agents/demo/.claude/channels/telegram'

  // Both readers must be resolved from the SAME module registry. An earlier
  // vi.resetModules() hands a dynamic import a FRESH mcp-probe-env, and its
  // per-process probe base is randomised on first use -- so a top-level import
  // of channelStateNowhereDirs would describe a DIFFERENT instance, and the
  // comparison would be between two unrelated random paths. (Measured: the two
  // bases differed only in the random half, same pid.)
  async function load() {
    const agent = await import('../web/agent-process.js')
    const { channelStateNowhereDirs: nowhereOf } = await import('../web/mcp-probe-env.js')
    return { ...agent, nowhere: nowhereOf() }
  }

  it('a sajat szolgaltato a VALODI konyvtarat kapja, a tobbi a sehovat', async () => {
    const { buildChannelStateExports, nowhere } = await load()
    const out = buildChannelStateExports('telegram', CHAN)
    expect(out).toContain(`export TELEGRAM_STATE_DIR="${CHAN}"`)
    for (const provider of Object.keys(CHANNEL_STATE_ENV_VAR) as ChannelProviderType[]) {
      const envVar = CHANNEL_STATE_ENV_VAR[provider]
      expect(out, `${envVar} nincs exportalva`).toContain(`export ${envVar}="`)
      if (provider !== 'telegram') {
        expect(out).toContain(`export ${envVar}="${nowhere[envVar]}"`)
      }
    }
  })

  it('csatorna NELKULI agens is kap mind az ot valtozot, mind sehova', async () => {
    // This is the hole: with no export at all, TELEGRAM_STATE_DIR resolves to
    // (CLAUDE_CONFIG_DIR ?? ~/.claude)/channels/telegram -- the LIVE bridge's
    // own dir, whose bot.pid the plugin SIGTERMs at startup.
    const { buildChannelStateExports, nowhere } = await load()
    const out = buildChannelStateExports(null, CHAN)
    expect(out).not.toContain(CHAN)
    for (const envVar of Object.values(CHANNEL_STATE_ENV_VAR)) {
      expect(out, `${envVar} nincs exportalva`).toContain(`export ${envVar}="`)
      expect(out).toContain(`export ${envVar}="${nowhere[envVar]}"`)
    }
    // No value may resolve under a real config root.
    expect(out).not.toContain(join(homedir(), '.claude', 'channels'))
  })

  it('a nowhere-konyvtarak nem letezenek (semmi nem jon letre)', async () => {
    const { nowhere } = await load()
    for (const dir of Object.values(nowhere)) {
      expect(existsSync(dir), `letrejott: ${dir}`).toBe(false)
    }
  })

  it('shell-be fuzheto: minden tag `&& `-vel zarul', async () => {
    const { buildChannelStateExports } = await load()
    const out = buildChannelStateExports('slack', CHAN)
    expect(out.endsWith(' && ')).toBe(true)
    expect(out.split(' && ').filter(Boolean).length).toBe(Object.keys(CHANNEL_STATE_ENV_VAR).length)
  })

  it('az unset-zaradek minden csatorna-hitelesitot megnevez', async () => {
    const { buildChannelUnsetCommand } = await load()
    const cmd = buildChannelUnsetCommand()
    for (const envVar of CHANNEL_TOKEN_ENV_VARS) {
      expect(cmd, `${envVar} nincs unset-elve`).toContain(envVar)
    }
    expect(cmd.startsWith('unset ')).toBe(true)
    expect(cmd).not.toContain('GOOGLE_APPLICATION_CREDENTIALS')
  })
})

// --- background tasks: the agent's OWN login, and no live channel state -------

describe('buildBackgroundTaskSpawn (hatterfeladat)', () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock('../web/agent-process.js') })

  async function load(spawnCfg: { configDir: string | null; useFleetToken: boolean }) {
    vi.resetModules()
    vi.doMock('../web/agent-process.js', () => ({
      agentSpawnConfigDir: () => spawnCfg,
      FLEET_OAUTH_TOKEN_PATH: '/store/.claude-oauth-token',
    }))
    return import('../web/routes/background-tasks.js')
  }

  it('az agens sajat CLAUDE_CONFIG_DIR-jevel indul', async () => {
    const mod = await load({ configDir: '/home/x/marveen/agents/demo/.claude-config', useFleetToken: true })
    const { tmuxArgs, configDir } = mod.buildBackgroundTaskSpawn('demo', 'bg-AB12', '/usr/bin/claude')
    const cmd = tmuxArgs[tmuxArgs.length - 1]
    expect(configDir).toBe('/home/x/marveen/agents/demo/.claude-config')
    expect(cmd).toContain('export CLAUDE_CONFIG_DIR="/home/x/marveen/agents/demo/.claude-config"')
    // The isolated dir carries no .credentials.json, so without this the task
    // would launch logged OUT -- a worse outcome than the bug being fixed.
    expect(cmd).toContain(`export CLAUDE_CODE_OAUTH_TOKEN="$(cat '/store/.claude-oauth-token')"`)
    // Read at run time, never interpolated: the secret must not be in `ps`.
    expect(cmd).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN="[A-Za-z0-9_-]{8}/)
  })

  it('explicit config dir eseten NEM ad flotta-tokent', async () => {
    const mod = await load({ configDir: '/opt/claude-alt', useFleetToken: false })
    const cmd = mod.buildBackgroundTaskSpawn('demo', 'bg-AB12', '/usr/bin/claude').tmuxArgs.at(-1)!
    expect(cmd).toContain('export CLAUDE_CONFIG_DIR="/opt/claude-alt"')
    expect(cmd).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('feloldhatatlan agens eseten a telepites alapertelmezese marad (mai viselkedes)', async () => {
    const mod = await load({ configDir: null, useFleetToken: false })
    const { tmuxArgs, configDir } = mod.buildBackgroundTaskSpawn('nincs-ilyen', 'bg-AB12', '/usr/bin/claude')
    expect(configDir).toBeNull()
    expect(tmuxArgs.at(-1)!).not.toContain('CLAUDE_CONFIG_DIR')
  })

  it('minden csatorna-allapot valtozot es hitelesitot atad a tmux -e-n', async () => {
    const mod = await load({ configDir: null, useFleetToken: false })
    const { tmuxArgs } = mod.buildBackgroundTaskSpawn('demo', 'bg-AB12', '/usr/bin/claude')
    const passed: Record<string, string> = {}
    for (let i = 0; i < tmuxArgs.length - 1; i++) {
      if (tmuxArgs[i] !== '-e') continue
      const eq = tmuxArgs[i + 1].indexOf('=')
      passed[tmuxArgs[i + 1].slice(0, eq)] = tmuxArgs[i + 1].slice(eq + 1)
    }
    for (const envVar of Object.values(CHANNEL_STATE_ENV_VAR)) {
      expect(passed[envVar], `${envVar} nem ment at`).toBeTruthy()
      expect(passed[envVar]).toContain('marveen-mcp-probe')
      expect(passed[envVar].startsWith(join(homedir(), '.claude'))).toBe(false)
    }
    for (const envVar of CHANNEL_TOKEN_ENV_VARS) {
      expect(passed[envVar], `${envVar} nem lett kiuritve`).toBe('')
    }
  })

  it('a promptot tovabbra is $BG_PROMPT-on adja at (meglevo funkcio)', async () => {
    // Regression guard for the change itself: the prompt reaches the pane
    // through tmux's client environment, and `-e` was added right next to it.
    // MEASURED on a throwaway tmux server: BG_PROMPT still arrives with -e set.
    const mod = await load({ configDir: null, useFleetToken: false })
    const { tmuxArgs } = mod.buildBackgroundTaskSpawn('demo', 'bg-AB12', '/usr/bin/claude')
    const cmd = tmuxArgs.at(-1)!
    expect(cmd).toContain('-p "$BG_PROMPT"')
    expect(cmd).toContain('___BG_DONE___')
    expect(tmuxArgs.slice(0, 6)).toEqual(['new-session', '-d', '-s', 'bg-AB12', '-x', '200'])
  })
})

describe('egy terkep, ket olvaso', () => {
  it('a reap ugyanazt a valtozo-terkepet hasznalja, mint a szonda', () => {
    // channel-poller-reap.ts looks for LIVE pollers by these env vars; the probe
    // points the very same vars somewhere harmless. If the two lists drift, one
    // side gains a provider the other cannot see.
    const reapSrc = readFileSync(join(webDir, 'channel-poller-reap.ts'), 'utf-8')
    expect(reapSrc).toMatch(/CHANNEL_STATE_ENV_VAR[^\n]*from\s*'\.\/mcp-probe-env\.js'/)
    expect(reapSrc).not.toMatch(/const\s+STATE_ENV_VAR\s*:\s*Record</)
  })
})
