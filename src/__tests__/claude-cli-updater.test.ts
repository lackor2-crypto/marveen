import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  installKindFromPath, isAvxLessHost, parseCliVersion, updateEnv, updateSlot, isCheckStale, CLAUDE_UPDATE_HOURS,
  takeUpdateLock, releaseUpdateLock, CLAUDE_UPDATE_LOCK_PATH, CLAUDE_UPDATE_LOCK_STALE_MS,
} from '../claude-cli-updater.js'
import { CLAUDE_MODEL_IDS } from '../claude-models.js'

const ROOT = join(__dirname, '..', '..')

describe('Claude program updater: new models must reach the list (owner, 2026-09-29)', () => {
  it('tells a native install from an npm one', () => {
    expect(installKindFromPath('/home/u/.local/share/claude/versions/2.1.284')).toBe('native')
    expect(installKindFromPath('C:\\Users\\u\\.local\\share\\claude\\versions\\2.1.284')).toBe('native')
    expect(installKindFromPath('/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe')).toBe('npm')
    expect(installKindFromPath(null)).toBe('missing')
  })

  it('never updates a pinned AVX-less host, but does update a normal one', () => {
    expect(isAvxLessHost('flags\t\t: fpu sse sse2')).toBe(true)
    expect(isAvxLessHost('flags\t\t: fpu sse avx avx2')).toBe(false)
    expect(isAvxLessHost('Processor : ARMv8')).toBe(false)
  })

  it('reads the version from `claude --version`', () => {
    expect(parseCliVersion('2.1.284 (Claude Code)')).toBe('2.1.284')
    expect(parseCliVersion('')).toBe('')
  })

  it('strips the fleet-wide autoupdate kill switch from the update call only', () => {
    const env = updateEnv({ DISABLE_AUTOUPDATER: '1', PATH: '/bin' })
    expect(env.DISABLE_AUTOUPDATER).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })

  it('checks at least twice a day, early morning and late evening', () => {
    expect(CLAUDE_UPDATE_HOURS.length).toBeGreaterThanOrEqual(2)
    expect(CLAUDE_UPDATE_HOURS.some((h) => h <= 7)).toBe(true)
    expect(CLAUDE_UPDATE_HOURS.some((h) => h >= 21)).toBe(true)
  })

  it('slots are per hour in the install time zone', () => {
    // 03:10 UTC = 05:10 in Budapest (CEST)
    expect(updateSlot(new Date('2026-09-29T03:10:00Z'), [5], 'Europe/Budapest')).toBe('2026-09-29-5')
    expect(updateSlot(new Date('2026-09-29T05:10:00Z'), [5], 'Europe/Budapest')).toBeNull()
  })

  it('a never-run or old check counts as stale (a box that was off catches up)', () => {
    const now = new Date('2026-09-29T12:00:00Z')
    expect(isCheckStale(undefined, now)).toBe(true)
    expect(isCheckStale('2026-09-28T20:00:00Z', now)).toBe(true)
    expect(isCheckStale('2026-09-29T08:00:00Z', now)).toBe(false)
  })

  it('Sonnet 5.5 is in the curated list', () => {
    expect(CLAUDE_MODEL_IDS).toContain('claude-sonnet-5-5')
  })

  it('is wired: schedule at startup, button route, button in the UI, bilingual', () => {
    const web = readFileSync(join(ROOT, 'src/web.ts'), 'utf-8')
    expect(web).toContain('startClaudeCliUpdateScheduler()')
    const routes = readFileSync(join(ROOT, 'src/web/routes/agents.ts'), 'utf-8')
    expect(routes).toContain("path === '/api/models/refresh' && method === 'POST'")
    // A re-measure must make new ids savable, not only visible.
    expect(routes).toMatch(/scanInstalledClaude\(\)\s*\n[\s\S]{0,200}registerDiscoveredClaudeModels/)
    const html = readFileSync(join(ROOT, 'web/index.html'), 'utf-8')
    expect(html).toContain('id="modelRefreshBtn"')
    const app = readFileSync(join(ROOT, 'web/app.js'), 'utf-8')
    expect(app).toContain("fetch('/api/models/refresh', { method: 'POST' })")
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      expect(readFileSync(join(ROOT, f), 'utf-8')).toContain("'agents.model.refresh_btn'")
    }
  })
})

// Two `npm install -g` runs into one prefix at the same moment deleted claude on
// 2026-08-23; channels.sh was the only update point for that reason. The
// dashboard is a second one, so both must take the same lock.
describe('Claude program updater: never installs at the same time as channels.sh', () => {
  it('the lock is exclusive, released on demand, and taken over when stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-lock-'))
    try {
      const lock = join(dir, '.claude-update.lock')
      expect(takeUpdateLock(lock)).toBe('held')
      expect(takeUpdateLock(lock)).toBe('busy')
      releaseUpdateLock(lock)
      expect(existsSync(lock)).toBe(false)
      expect(takeUpdateLock(lock)).toBe('held')
      // A crashed holder: the lock is older than any real update.
      const old = (Date.now() - CLAUDE_UPDATE_LOCK_STALE_MS - 60_000) / 1000
      utimesSync(lock, old, old)
      expect(takeUpdateLock(lock)).toBe('held')
      // No writable place for a lock at all: update unlocked rather than never.
      expect(takeUpdateLock(join(dir, 'missing', 'x.lock'))).toBe('unavailable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('channels.sh claude_install takes the SAME lock, installs, and releases it', () => {
    const sh = readFileSync(join(ROOT, 'scripts/channels.sh'), 'utf-8')
    expect(sh).toContain(`CLAUDE_UPDATE_LOCK="$INSTALL_DIR/store/${basename(CLAUDE_UPDATE_LOCK_PATH)}"`)
    const fn = /\nclaude_install\(\) \{\n[\s\S]*?\n\}\n/.exec(sh)?.[0]
    expect(fn).toBeTruthy()

    const dir = mkdtempSync(join(tmpdir(), 'claude-install-'))
    try {
      mkdirSync(join(dir, 'store'))
      mkdirSync(join(dir, 'bin'))
      const log = join(dir, 'npm.log')
      const lock = join(dir, 'store', basename(CLAUDE_UPDATE_LOCK_PATH))
      // Fake npm: records whether it ran while the lock was held.
      writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\n[ -d "${lock}" ] && echo locked >> "${log}" || echo unlocked >> "${log}"\n`)
      chmodSync(join(dir, 'bin', 'npm'), 0o755)
      const run = () => execFileSync('bash', ['-c', `${fn}\nclaude_install test`], {
        env: {
          PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
          INSTALL_DIR: dir,
          CLAUDE_PKG: '@anthropic-ai/claude-code',
          CLAUDE_UPDATE_STAMP: join(dir, 'store', '.claude-update-stamp'),
          CLAUDE_UPDATE_LOCK: lock,
        },
        stdio: 'pipe',
      })

      run()
      expect(readFileSync(log, 'utf-8').trim()).toBe('locked')
      expect(existsSync(lock)).toBe(false)

      // A stale lock left by a crashed holder does not block the install forever.
      mkdirSync(lock)
      const old = (Date.now() - 20 * 60 * 1000) / 1000
      utimesSync(lock, old, old)
      run()
      expect(readFileSync(log, 'utf-8').trim().split('\n')).toEqual(['locked', 'locked'])
      expect(existsSync(lock)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the dashboard update runs under the lock and says so when it has to skip', () => {
    const src = readFileSync(join(ROOT, 'src/claude-cli-updater.ts'), 'utf-8')
    expect(src).toMatch(/await waitForUpdateLock\(\)/)
    expect(src).toMatch(/if \(lock === 'held'\) releaseUpdateLock\(\)/)
    expect(src).toMatch(/lock === 'busy'[\s\S]{0,40}ok: false/)
  })
})
