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
import { channelProbeStateEnv, CHANNEL_STATE_ENV_VAR, CHANNEL_TOKEN_ENV_VARS } from '../web/mcp-probe-env.js'

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
