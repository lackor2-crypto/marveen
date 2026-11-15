import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #884 (follow-up to PR #1676): the first fix made the plain `list-sessions` listing stale-while-revalidate,
// but two other spawns on the same event loop stayed synchronous:
//  - localSessionStartTimes() (`list-sessions -F "#{session_name} #{session_created}"`) runs on EVERY
//    /api/agents and /api/settings request -- a polled endpoint, one execFileSync per poll;
//  - the pane reads in front of every prompt injection (survey modal, model-consent dialog, login menu,
//    the pre-send preamble check, the wait-until-idle loop) were execFileSync inside async functions.
const h = vi.hoisted(() => ({ sync: [] as string[][], async: [] as string[][] }))

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) h.sync.push(args)
    if (Array.isArray(args) && args.includes('list-sessions')) return 'agent-a 1700000000\nagent-b 1700000100\n'
    return ''
  }),
  execFile: vi.fn((_file: string, args: string[], _opts: unknown, cb: (e: Error | null, out?: string) => void) => {
    h.async.push(args)
    setImmediate(() => cb(null, args.includes('list-sessions') ? 'agent-a 1700000000\nagent-b 1700000200\n' : ''))
    return { on() {}, kill() {} }
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { localSessionStartTimes, invalidateLocalSessionCache } from '../web/agent-process.js'

const startListings = () => h.sync.filter(a => a.includes('list-sessions') && a.some(x => x.includes('session_created')))

describe('localSessionStartTimes does not spawn tmux synchronously on every poll (#884)', () => {
  let now = 1_800_000_000_000
  beforeEach(() => {
    h.sync.length = 0
    h.async.length = 0
    now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    invalidateLocalSessionCache()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('reads the start times, and a poll inside the window reuses them', () => {
    const first = localSessionStartTimes()
    expect(first.get('agent-a')).toBe(1_700_000_000_000)
    localSessionStartTimes()
    expect(startListings().length).toBe(1)
  })

  it('after the window an expired answer is served at once and refreshed off the thread', async () => {
    localSessionStartTimes()
    expect(startListings().length).toBe(1)
    now += 10_000
    const stale = localSessionStartTimes()
    expect(stale.get('agent-b')).toBe(1_700_000_100_000)   // the old picture, served without a new sync spawn
    expect(startListings().length).toBe(1)                  // still one synchronous spawn
    await new Promise((r) => setTimeout(r, 20))
    expect(h.async.some(a => a.includes('list-sessions'))).toBe(true)
    expect(localSessionStartTimes().get('agent-b')).toBe(1_700_000_200_000)   // the refresh landed
    expect(startListings().length).toBe(1)
  })
})

describe('the prompt-injection path reads panes off the event loop (#884)', () => {
  const ap = readFileSync(join(__dirname, '..', 'web/agent-process.ts'), 'utf-8')
  const body = (start: string, len = 700) => ap.slice(ap.indexOf(start), ap.indexOf(start) + len)
  it.each([
    'async function dismissSurveyModalIfPresent',
    'export async function answerLoginMethodMenu',
    'export async function dismissModelConsentDialogIfPresent',
  ])('%s awaits an async capture', (sig) => {
    const fn = body(sig)
    expect(fn).toContain('await capturePaneOnHostAsync(')
    expect(fn).not.toContain('captureTmux(host')
    expect(fn).not.toContain('capturePane(session')
  })
  it('the wait-until-idle loop and the pre-send preamble check do not block', () => {
    expect(body('export async function waitForPaneIdle', 600)).toContain('await capturePaneOnHostAsync(')
    expect(body('export async function waitForPaneIdle', 600)).not.toMatch(/\bcapturePane\(/)
    expect(ap).toMatch(/const preCapture = await capturePaneOnHostAsync\(/)
  })
})
