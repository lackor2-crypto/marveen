/**
 * #997: the Claude login flow ran `claude auth status` and tmux synchronously
 * inside its request handlers, so every 2 s status poll stopped the whole
 * dashboard (measured 2026-11-28: stalls of 0.8-2.4 s on GET /api/accounts/claude).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  sync: [] as string[],
  calls: [] as string[],
  tmuxUp: false,
  store: '',
}))

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  const refuse = (name: string) => (bin: string, args: string[] = []) => {
    h.sync.push(`${name} ${bin} ${args.join(' ')}`)
    throw new Error('synchronous fork')
  }
  return {
    ...real,
    execFileSync: refuse('execFileSync'),
    spawnSync: refuse('spawnSync'),
    execSync: refuse('execSync'),
    execFile: (_bin: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
      const verb = args.slice(0, 2).join(' ')
      h.calls.push(args[0] === 'auth' ? verb : String(args[0]))
      setTimeout(() => {
        if (args[0] === 'auth') return cb(null, JSON.stringify({ loggedIn: false }))
        if (args[0] === 'new-session') h.tmuxUp = true
        if (args[0] === 'kill-session') h.tmuxUp = false
        if (args[0] === 'has-session' && !h.tmuxUp) return cb(new Error('no session'), '')
        cb(null, '')
      }, 5)
    },
  }
})

// CI machines have no `claude` on PATH, and nothing real is started here anyway.
vi.mock('../platform.js', async (orig) => {
  const real = await orig<typeof import('../platform.js')>()
  return { ...real, makeLazyBinResolver: (name: string) => () => name }
})

vi.mock('../config.js', async (orig) => {
  const real = await orig<typeof import('../config.js')>()
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  h.store = fs.mkdtempSync(path.join(os.tmpdir(), 'm997-'))
  return { ...real, STORE_DIR: h.store }
})

const runner = await import('../web/claude-auth-runner.js')

afterAll(() => { rmSync(h.store || mkdtempSync(join(tmpdir(), 'm997-')), { recursive: true, force: true }) })

describe('the login flow never blocks the main thread (#997)', () => {
  beforeEach(() => {
    runner._resetClaudeAuthForTest()
    h.sync.length = 0
    h.calls.length = 0
    h.tmuxUp = false
  })

  it('start, poll, code, cancel and logout use no synchronous fork', async () => {
    expect(await runner.startLogin({ target: 'default', force: true })).toMatchObject({ ok: true })
    expect((await runner.loginStatus()).active).toBe(true)
    expect(await runner.submitCode('abc123')).toEqual({ ok: true })
    await runner.cancelLogin()
    expect((await runner.loginStatus()).active).toBe(false)
    expect((await runner.logoutAccount(null)).ok).toBe(false)
    expect(h.sync).toEqual([])
  })

  it('the event loop keeps turning while a status poll waits for the CLI', async () => {
    await runner.startLogin({ target: 'default', force: true })
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 1)
    await runner.loginStatus()
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(0)
  })

  it('two impatient start clicks open one login window', async () => {
    const [a, b] = await Promise.all([
      runner.startLogin({ target: 'default', force: true }),
      runner.startLogin({ target: 'default', force: true }),
    ])
    expect([a.ok, b.ok]).toEqual([true, true])
    expect(h.calls.filter(c => c === 'new-session')).toHaveLength(1)
  })

  it('polls that overlap share one answer instead of piling up probes', async () => {
    await runner.startLogin({ target: 'default', force: true })
    await runner.loginStatus()
    h.calls.length = 0
    const first = runner.loginStatus()
    expect(runner.loginStatus()).toBe(first)
    await first
    expect(h.calls.filter(c => c === 'has-session')).toHaveLength(1)
  })

  it('a cancel pressed while the start is still running wins', async () => {
    const start = runner.startLogin({ target: 'default', force: true })
    const cancel = runner.cancelLogin()
    await Promise.all([start, cancel])
    expect(h.tmuxUp).toBe(false)
    expect((await runner.loginStatus()).active).toBe(false)
  })
})
