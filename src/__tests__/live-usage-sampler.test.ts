// #710: the Telegram quota alert must not go quiet when the main agent is idle.
//
// The real case (Boss, 2026-10-18): the dashboard showed 86% while the real 5h quota was 99%; the alert script
// only reads a statusline snapshot that moves while the agent works, so next to an idle agent (a VS Code session
// burning the same account) it logged "snapshot old -- skipped" and stayed silent. Guarded here: (1) the sampler
// writes the live reading in the snapshot's own shape, a failed reading writes nothing; (2) the alert script uses
// a fresh live file, falls back to the snapshot when the live file is old, and still skips when both are old.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { MAIN_AGENT_ID } from '../config.js'
import { sampleMainLiveUsage, liveUsageFileBody, liveUsageFilePath } from '../web/live-usage-sampler.js'
import type { LiveUsageResult } from '../web/claude-usage-api.js'

const ROOT = join(__dirname, '..', '..')
let tmp = ''
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'live-sampler-')) })
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* mar nincs */ } })

const okResult = (now: number): LiveUsageResult => ({
  ok: true,
  usage: {
    fiveHour: { usedPct: 99, resetsAt: now + 3_600_000 },
    sevenDay: { usedPct: 40, resetsAt: now + 86_400_000 },
    measuredAt: now,
  },
})

describe('the sampler', () => {
  it('writes the live reading in the snapshot shape, file name live-<id>', async () => {
    const now = Date.now()
    const path = join(tmp, 'rate-limit-status', 'live-x.json')
    const written: Record<string, string> = {}
    const r = await sampleMainLiveUsage({
      token: () => 'sk-x',
      fetchUsage: async () => okResult(now),
      write: (p, d) => { written[p] = d },
      path,
    })
    expect(r).toBe('written')
    const body = JSON.parse(written[path]!)
    expect(body.fiveHour).toEqual({ usedPct: 99, resetsAt: now + 3_600_000 })
    expect(body.sevenDay.usedPct).toBe(40)
    expect(body.updatedAt).toBe(now)
    expect(body.windowsUpdatedAt).toBe(now)
    expect(liveUsageFilePath('abc', '/s')).toBe('/s/rate-limit-status/live-abc.json')
  })

  it('writes nothing when the live reading failed -- silence is not a number', async () => {
    let writes = 0
    const r = await sampleMainLiveUsage({
      token: () => null,
      fetchUsage: async () => ({ ok: false, reason: 'no-credential', detail: 'nincs token' }),
      write: () => { writes++ },
      path: join(tmp, 'x.json'),
    })
    expect(r).toBe('skipped')
    expect(writes).toBe(0)
  })

  it('never throws: a broken write is swallowed', async () => {
    const r = await sampleMainLiveUsage({
      token: () => 'sk-x',
      fetchUsage: async () => okResult(Date.now()),
      write: () => { throw new Error('disk tele') },
      path: join(tmp, 'x.json'),
    })
    expect(r).toBe('skipped')
  })

  it('leaves out a window the service did not report', () => {
    const body = JSON.parse(liveUsageFileBody('a', {
      ok: true, usage: { fiveHour: null, sevenDay: { usedPct: 1, resetsAt: null }, measuredAt: 5 },
    }))
    expect(body.fiveHour).toBeNull()
    expect(body.sevenDay).toEqual({ usedPct: 1, resetsAt: null })
  })

  it('is wired to the main agent by default', () => {
    expect(typeof MAIN_AGENT_ID).toBe('string')
    expect(liveUsageFilePath()).toContain(`live-${MAIN_AGENT_ID}.json`)
  })
})

describe('scripts/ratelimit-telegram-alert.sh', () => {
  function setup(): { notified: string; log: string; run: () => void; put: (name: string, body: unknown) => void } {
    mkdirSync(join(tmp, 'scripts', 'lib'), { recursive: true })
    mkdirSync(join(tmp, 'store', 'rate-limit-status'), { recursive: true })
    copyFileSync(join(ROOT, 'scripts', 'ratelimit-telegram-alert.sh'), join(tmp, 'scripts', 'ratelimit-telegram-alert.sh'))
    copyFileSync(join(ROOT, 'scripts', 'lib', 'owner-lang.sh'), join(tmp, 'scripts', 'lib', 'owner-lang.sh'))
    const notified = join(tmp, 'notified.txt')
    writeFileSync(join(tmp, 'scripts', 'notify.sh'), `#!/bin/bash\necho "$1" >> "${notified}"\n`)
    chmodSync(join(tmp, 'scripts', 'notify.sh'), 0o755)
    writeFileSync(join(tmp, '.env'), 'MAIN_AGENT_ID=mainx\n')
    return {
      notified,
      log: join(tmp, 'store', 'ratelimit-alert.log'),
      run: () => { execFileSync('bash', [join(tmp, 'scripts', 'ratelimit-telegram-alert.sh')], { timeout: 15_000, env: { ...process.env, LANG: 'C' } }) },
      put: (name, body) => writeFileSync(join(tmp, 'store', 'rate-limit-status', `${name}.json`), JSON.stringify(body)),
    }
  }
  const snap = (pct: number, updatedAt: number, resetsAt: number) =>
    ({ agent: 'mainx', fiveHour: { usedPct: pct, resetsAt }, sevenDay: null, updatedAt })

  it('alerts from a fresh live file although the statusline snapshot is hours old (the idle-agent case)', () => {
    const s = setup()
    const now = Date.now()
    s.put('mainx', snap(86, now - 3 * 3_600_000, now + 3_600_000))
    s.put('live-mainx', snap(99, now - 30_000, now + 3_600_000))
    s.run()
    expect(readFileSync(s.notified, 'utf8')).toMatch(/99%/)
  })

  it('without a live file an old snapshot is still skipped, as before', () => {
    const s = setup()
    const now = Date.now()
    s.put('mainx', snap(99, now - 3 * 3_600_000, now + 3_600_000))
    s.run()
    expect(existsSync(s.notified)).toBe(false)
    expect(readFileSync(s.log, 'utf8')).toContain('snapshot regi')
  })

  it('an old live file does not override a fresh statusline snapshot', () => {
    const s = setup()
    const now = Date.now()
    s.put('mainx', snap(99, now - 60_000, now + 3_600_000))
    s.put('live-mainx', snap(10, now - 20 * 60_000, now + 3_600_000))
    s.run()
    expect(readFileSync(s.notified, 'utf8')).toMatch(/99%/)
  })

  it('a live file alone (no snapshot at all) is enough', () => {
    const s = setup()
    const now = Date.now()
    s.put('live-mainx', snap(95, now - 10_000, now + 3_600_000))
    s.run()
    expect(readFileSync(s.notified, 'utf8')).toMatch(/95%/)
  })
})
