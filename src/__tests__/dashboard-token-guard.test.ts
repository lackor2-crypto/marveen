// #415 -- the dashboard holds store/.dashboard-token to the token it enforces.
//
// The measured incident (2026-09-27 02:33:59): an agent ran
//   echo "test-token-placeholder" > store/.dashboard-token
// The dashboard kept the real token in memory, every agent and the code-bridge
// worker read the file, and the whole fleet got 401. These tests pin the three
// things the fix promises: the file is written back (0600, atomic) with the
// in-memory token, the owner is told (HU + EN), and a DASHBOARD_TOKEN from the
// environment means the file is left alone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const TOKEN = 'a'.repeat(16) + '0123456789abcdef'.repeat(3) // 64 chars, like a generated one
const PLACEHOLDER = 'test-token-placeholder'

let dir: string
let tokenPath: string
let savedEnv: string | undefined

type Guard = typeof import('../web/dashboard-token-guard.js')
type Auth = typeof import('../web/dashboard-auth.js')

// Fresh module instances per test: the guard and the startup check keep
// process-level state, and one test's event must not leak into the next one's
// notice count.
let current: Guard | null = null
async function load(): Promise<{ guard: Guard; auth: Auth }> {
  current?.stopDashboardTokenGuard()
  vi.resetModules()
  const auth = await import('../web/dashboard-auth.js')
  const guard = await import('../web/dashboard-token-guard.js')
  current = guard
  return { guard, auth }
}

async function until(cond: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function fileMode(p: string): number {
  return statSync(p).mode & 0o777
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'token-guard-'))
  tokenPath = join(dir, 'store', '.dashboard-token')
  mkdirSync(join(dir, 'store'))
  savedEnv = process.env.DASHBOARD_TOKEN
  delete process.env.DASHBOARD_TOKEN
})

afterEach(() => {
  current?.stopDashboardTokenGuard()
  current = null
  if (savedEnv === undefined) delete process.env.DASHBOARD_TOKEN
  else process.env.DASHBOARD_TOKEN = savedEnv
  try { chmodSync(tokenPath, 0o600) } catch { /* may not exist */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('inspect + enforce (one check)', () => {
  it('a matching file (even with a trailing newline) is left alone', async () => {
    const { guard } = await load()
    writeFileSync(tokenPath, TOKEN + '\n', { mode: 0o600 })
    const before = statSync(tokenPath).mtimeMs
    expect(guard.enforceDashboardTokenFile(tokenPath, TOKEN)).toEqual({ verdict: 'ok', restored: false })
    expect(statSync(tokenPath).mtimeMs).toBe(before)
  })

  it('the incident: an overwrite with the placeholder is written back, 0600', async () => {
    const { guard } = await load()
    writeFileSync(tokenPath, PLACEHOLDER + '\n', { mode: 0o644 })
    const r = guard.enforceDashboardTokenFile(tokenPath, TOKEN)
    expect(r).toEqual({ verdict: 'changed', restored: true })
    expect(readFileSync(tokenPath, 'utf-8')).toBe(TOKEN)
    expect(fileMode(tokenPath)).toBe(0o600)
  })

  it('a deleted file is recreated with the in-memory token, 0600', async () => {
    const { guard } = await load()
    const r = guard.enforceDashboardTokenFile(tokenPath, TOKEN)
    expect(r).toEqual({ verdict: 'missing', restored: true })
    expect(readFileSync(tokenPath, 'utf-8')).toBe(TOKEN)
    expect(fileMode(tokenPath)).toBe(0o600)
  })

  it('an empty file counts as changed, not as ok', async () => {
    const { guard } = await load()
    writeFileSync(tokenPath, '')
    expect(guard.enforceDashboardTokenFile(tokenPath, TOKEN).verdict).toBe('changed')
    expect(readFileSync(tokenPath, 'utf-8')).toBe(TOKEN)
  })

  it('"could not look" is told apart from "not there"', async () => {
    const { guard } = await load()
    mkdirSync(tokenPath) // a directory where the file should be: read fails, not ENOENT
    expect(guard.inspectTokenFile(tokenPath, TOKEN)).toBe('unreadable')
    const r = guard.enforceDashboardTokenFile(tokenPath, TOKEN)
    expect(r.restored).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('never writes a short or empty value', async () => {
    const { guard } = await load()
    writeFileSync(tokenPath, PLACEHOLDER)
    for (const bad of ['', 'short', PLACEHOLDER, ` ${TOKEN}`]) {
      const r = guard.enforceDashboardTokenFile(tokenPath, bad)
      expect(r.restored).toBe(false)
    }
    expect(readFileSync(tokenPath, 'utf-8')).toBe(PLACEHOLDER)
  })
})

describe('the running guard', () => {
  it('an overwrite is written back by itself, and the owner is told once', async () => {
    const { guard } = await load()
    writeFileSync(tokenPath, TOKEN, { mode: 0o600 })
    const sent: string[] = []
    const started = guard.startDashboardTokenGuard(TOKEN, {
      path: tokenPath,
      pollMs: 20,
      notify: async (t) => { sent.push(t) },
    })
    expect(started).toBe(true)
    expect(sent).toHaveLength(0) // a healthy file is not news

    // What the agent actually did, verbatim: a shell redirect over the live file.
    execFileSync('sh', ['-c', `echo "${PLACEHOLDER}" > "${tokenPath}"`])
    expect(readFileSync(tokenPath, 'utf-8')).toBe(PLACEHOLDER + '\n')
    await until(() => readFileSync(tokenPath, 'utf-8') === TOKEN)
    expect(fileMode(tokenPath)).toBe(0o600)
    await until(() => sent.length === 1)
    expect(sent[0]).toContain('store/.dashboard-token')
    expect(sent[0]).not.toContain(TOKEN) // the secret never goes into a chat

    const rows = guard.dashboardTokenGuardRows(Date.now())
    expect(rows).toEqual([{ id: 'dashboard_token_restored', status: 'warn', params: { n: 1, p: 0 } }])
  })

  it('a delete under the running guard is recreated', async () => {
    const { guard } = await load()
    writeFileSync(tokenPath, TOKEN, { mode: 0o600 })
    guard.startDashboardTokenGuard(TOKEN, { path: tokenPath, pollMs: 20, notify: async () => {} })
    unlinkSync(tokenPath)
    await until(() => existsSync(tokenPath) && readFileSync(tokenPath, 'utf-8') === TOKEN)
    expect(fileMode(tokenPath)).toBe(0o600)
  })

  it('a burst of overwrites is counted, but sends one message, not one per write', async () => {
    const { guard } = await load()
    writeFileSync(tokenPath, TOKEN, { mode: 0o600 })
    const sent: string[] = []
    guard.startDashboardTokenGuard(TOKEN, { path: tokenPath, pollMs: 20, notify: async (t) => { sent.push(t) } })
    for (let i = 0; i < 3; i++) {
      writeFileSync(tokenPath, `${PLACEHOLDER}-${i}`)
      await until(() => readFileSync(tokenPath, 'utf-8') === TOKEN)
    }
    const row = guard.dashboardTokenGuardRows(Date.now())[0]
    expect(row.params?.n).toBe(3)
    expect(sent).toHaveLength(1)
  })

  it('the self-check row goes away after its window', async () => {
    const { guard } = await load()
    writeFileSync(tokenPath, PLACEHOLDER)
    guard.startDashboardTokenGuard(TOKEN, { path: tokenPath, pollMs: 20, notify: async () => {} })
    // the start-up check already found and fixed it
    expect(readFileSync(tokenPath, 'utf-8')).toBe(TOKEN)
    const now = Date.now()
    expect(guard.dashboardTokenGuardRows(now)).toHaveLength(1)
    expect(guard.dashboardTokenGuardRows(now + guard.HEALTH_WINDOW_MS + 1)).toHaveLength(0)
  })

  it('a failed restore is a red row and a message, and clears once the file is right again', async () => {
    const { guard } = await load()
    mkdirSync(tokenPath)
    const sent: string[] = []
    guard.startDashboardTokenGuard(TOKEN, { path: tokenPath, pollMs: 20, notify: async (t) => { sent.push(t) } })
    expect(guard.dashboardTokenGuardRows()).toEqual([{ id: 'dashboard_token_restore_failed', status: 'bad' }])
    await until(() => sent.length === 1)
    // the same failure on every later tick is not a new message
    await new Promise((r) => setTimeout(r, 200))
    expect(sent).toHaveLength(1)
    // ...and the failed tries left no copy of the token lying around
    expect(readdirSync(join(dir, 'store'))).toEqual(['.dashboard-token'])
    rmSync(tokenPath, { recursive: true })
    await until(() => existsSync(tokenPath) && statSync(tokenPath).isFile() && readFileSync(tokenPath, 'utf-8') === TOKEN)
    expect(guard.dashboardTokenGuardRows().map((r) => r.id)).toEqual(['dashboard_token_restored'])
  })

  it('with DASHBOARD_TOKEN in the environment the file is not touched at all', async () => {
    const { guard } = await load()
    process.env.DASHBOARD_TOKEN = TOKEN
    writeFileSync(tokenPath, PLACEHOLDER)
    const sent: string[] = []
    expect(guard.startDashboardTokenGuard(TOKEN, { path: tokenPath, pollMs: 20, notify: async (t) => { sent.push(t) } })).toBe(false)
    writeFileSync(tokenPath, PLACEHOLDER + '-2')
    await new Promise((r) => setTimeout(r, 150))
    expect(readFileSync(tokenPath, 'utf-8')).toBe(PLACEHOLDER + '-2')
    expect(sent).toHaveLength(0)
    expect(guard.dashboardTokenGuardRows()).toEqual([])
  })

  it('refuses to guard a short in-memory token', async () => {
    const { guard } = await load()
    writeFileSync(tokenPath, 'x')
    expect(guard.startDashboardTokenGuard('short', { path: tokenPath, pollMs: 20, notify: async () => {} })).toBe(false)
    expect(readFileSync(tokenPath, 'utf-8')).toBe('x')
  })
})

describe('startup: a guessable value in the file is not adopted', () => {
  it('the incident placeholder is replaced by a fresh random token and reported', async () => {
    const { auth, guard } = await load()
    writeFileSync(tokenPath, PLACEHOLDER + '\n')
    const token = auth.loadOrCreateDashboardToken(tokenPath)
    expect(token).not.toBe(PLACEHOLDER)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(tokenPath, 'utf-8')).toBe(token)
    expect(fileMode(tokenPath)).toBe(0o600)
    expect(auth.weakFileTokenReplacedAt()).not.toBeNull()

    const sent: string[] = []
    guard.startDashboardTokenGuard(token, { path: tokenPath, pollMs: 20, notify: async (t) => { sent.push(t) } })
    await until(() => sent.length === 1)
    expect(sent[0]).not.toContain(token)
    expect(guard.dashboardTokenGuardRows().map((r) => r.id)).toEqual(['dashboard_token_replaced'])
  })

  it('a real token in the file is kept as it is', async () => {
    const { auth } = await load()
    writeFileSync(tokenPath, TOKEN + '\n', { mode: 0o600 })
    expect(auth.loadOrCreateDashboardToken(tokenPath)).toBe(TOKEN)
    expect(auth.weakFileTokenReplacedAt()).toBeNull()
  })

  it('a missing file is created (fresh install) without being reported as an incident', async () => {
    const { auth } = await load()
    const token = auth.loadOrCreateDashboardToken(tokenPath)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(fileMode(tokenPath)).toBe(0o600)
    expect(auth.weakFileTokenReplacedAt()).toBeNull()
  })
})

describe('owner notice text (HU + EN)', () => {
  it('every notice exists in both languages, and the English one is English', async () => {
    const { guard } = await load()
    const keys = ['restored.changed', 'restored.missing', 'restored.unreadable', 'restore_failed', 'weak_at_startup'] as const
    for (const k of keys) {
      const hu = guard.buildTokenNotice(k, { n: 2, error: 'EACCES' }, 'hu')
      const en = guard.buildTokenNotice(k, { n: 2, error: 'EACCES' }, 'en')
      expect(hu.length).toBeGreaterThan(40)
      expect(en.length).toBeGreaterThan(40)
      expect(hu).not.toBe(en)
      expect(en).not.toMatch(/[áéíóöőúüű]/i)
      expect(hu).not.toMatch(/\{\w+\}/)
      expect(en).not.toMatch(/\{\w+\}/)
    }
    expect(guard.buildTokenNotice('restored.changed', { n: 3 }, 'hu')).toContain('3.')
    expect(guard.buildTokenNotice('restore_failed', { error: 'EISDIR' }, 'en')).toContain('EISDIR')
  })
})

describe('the self-check rows have their screen text in both languages', () => {
  it('health.<id> and health.<id>_action exist in hu.js and en.js', () => {
    const root = join(__dirname, '..', '..')
    const hu = readFileSync(join(root, 'web', 'lang', 'hu.js'), 'utf-8')
    const en = readFileSync(join(root, 'web', 'lang', 'en.js'), 'utf-8')
    for (const id of ['dashboard_token_restored', 'dashboard_token_restore_failed', 'dashboard_token_replaced']) {
      for (const key of [`'health.${id}'`, `'health.${id}_action'`]) {
        expect(hu, `${key} missing from hu.js`).toContain(key)
        expect(en, `${key} missing from en.js`).toContain(key)
      }
    }
  })
})

describe('the dashboard actually runs the guard', () => {
  it('web.ts starts it on the token it enforces, and stops it on close', () => {
    const web = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    const load = web.indexOf('const DASHBOARD_TOKEN = loadOrCreateDashboardToken()')
    const start = web.indexOf('startDashboardTokenGuard(DASHBOARD_TOKEN)')
    expect(load).toBeGreaterThan(0)
    expect(start).toBeGreaterThan(load)
    expect(web).toContain('stopDashboardTokenGuard()')
  })

  it('the self-check includes the guard rows', () => {
    const health = readFileSync(join(__dirname, '..', 'web', 'system-health.ts'), 'utf-8')
    expect(health).toContain('...dashboardTokenGuardRows(now),')
  })
})
