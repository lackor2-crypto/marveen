// #390: a menu item must show its page at once. These guard the measured
// causes of the slow pages so a refactor does not quietly bring them back.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { procField, procChildren } from '../web/main-agent-runtime.js'
import { spawn } from 'node:child_process'
import { readActiveModelFromProjectDir, readContextReadingFromProjectDir, projectsDirFor, _resetScanMemoForTest } from '../web/active-model.js'
import { openRouterModelsWithin, _setOpenRouterCatalogForTest } from '../web/openrouter-models.js'
import { calendarListOutput, _resetCalendarCacheForTest } from '../web/settings-calendar-cache.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

describe('procField reads /proc instead of spawning ps', () => {
  it.skipIf(!existsSync('/proc/self/stat'))('answers comm, args and etimes for a live process', () => {
    const pid = process.pid
    expect(procField(pid, 'comm=')).toBeTruthy()
    expect(procField(pid, 'args=')).toContain('node')
    const et = Number(procField(pid, 'etimes='))
    expect(Number.isFinite(et)).toBe(true)
    expect(Math.abs(et - process.uptime())).toBeLessThan(5)
  })

  it.skipIf(!existsSync('/proc/self/task'))('lists the direct children of a process', async () => {
    const child = spawn('sleep', ['5'])
    try {
      await new Promise((r) => setTimeout(r, 50))
      expect(procChildren(process.pid)).toContain(child.pid)
    } finally { child.kill() }
    expect(procChildren(2 ** 30)).toBeUndefined()
  })

  it('falls back (undefined) for an unknown field or a missing process', () => {
    expect(procField(process.pid, 'rss=')).toBeUndefined()
    expect(procField(2 ** 30, 'comm=')).toBeUndefined()
  })
})

describe('settings calendar list is served from a stale-while-revalidate cache', () => {
  beforeEach(() => _resetCalendarCacheForTest())
  const good = JSON.stringify({ account: 'a', calendars: [{ id: 'x', summary: 'X' }] })

  it('a second open within a minute does not run the lookup again', async () => {
    let calls = 0
    const fetcher = async () => { calls++; return good }
    expect(await calendarListOutput('a', fetcher)).toBe(good)
    expect(await calendarListOutput('a', fetcher)).toBe(good)
    expect(calls).toBe(1)
  })

  it('a failed lookup is never cached as the answer', async () => {
    let calls = 0
    const fetcher = async () => { calls++; return calls === 1 ? JSON.stringify({ error: 'offline' }) : good }
    expect(await calendarListOutput('a', fetcher)).toContain('offline')
    expect(await calendarListOutput('a', fetcher)).toBe(good)
    expect(calls).toBe(2)
  })

  it('accounts are cached separately', async () => {
    const seen: string[] = []
    const fetcher = async (a: string) => { seen.push(a); return good }
    await calendarListOutput('a', fetcher)
    await calendarListOutput('b', fetcher)
    expect(seen).toEqual(['a', 'b'])
  })

  it('concurrent opens share one lookup', async () => {
    let calls = 0
    const fetcher = () => new Promise<string>((r) => { calls++; setTimeout(() => r(good), 10) })
    await Promise.all([calendarListOutput('a', fetcher), calendarListOutput('a', fetcher)])
    expect(calls).toBe(1)
  })
})

describe('source contracts for the measured slow paths', () => {
  it('vault memoizes the scrypt-derived key', () => {
    const s = src('src/web/vault.ts')
    expect(s).toMatch(/derivedKeyCache\.get\(/)
    expect(s).toMatch(/derivedKeyCache\.set\(/)
  })

  it('account routes use the async (non-blocking) identity probes', () => {
    const s = src('src/web/routes/accounts.ts')
    expect(s).toMatch(/await identityAuditAsync\(\)/)
    // the machine's own login is served from the same SWR cache, not probed per open
    expect(s).toMatch(/await machineIdentityAsync\(\)/)
    expect(s).not.toMatch(/readIdentityDetailedAsync\(/)
    const r = src('src/web/claude-auth-runner.ts')
    // an older background refresh must not overwrite a newer result
    expect(r).toMatch(/accountGen/)
    expect(r).toMatch(/export function refreshAccountsInBackground/)
  })

  it('accounts are prewarmed at startup', () => {
    expect(src('src/web.ts')).toMatch(/refreshAccountsInBackground\(\)/)
  })

  it('kanban starts its list fetches before waiting for /api/marveen', () => {
    const a = src('web/app.js')
    const body = a.slice(a.indexOf('async function loadKanban()'), a.indexOf('async function loadKanban()') + 4000)
    expect(body.indexOf('const listsReady = Promise.all(')).toBeGreaterThan(-1)
    expect(body.indexOf('const listsReady = Promise.all(')).toBeLessThan(body.indexOf('await marveenReady'))
  })

  it('approvals do not wait for the agent list before drawing the table', () => {
    const a = src('web/app.js')
    const start = a.indexOf('async function loadApprovalsPage')
    const body = a.slice(start, start + 4000)
    expect(body).not.toMatch(/await ensureAgentsLoaded\(\)/)
    expect(body).toMatch(/agentsReady/)
  })
})

describe('transcript reads are memoized by file signature', () => {
  let root = ''
  const work = '/work/agent-x'
  let file = ''
  const line = (o: object) => JSON.stringify(o) + '\n'
  beforeEach(() => {
    _resetScanMemoForTest()
    vi.useFakeTimers({ toFake: ['Date'] })
    root = mkdtempSync(path.join(tmpdir(), 'm390-'))
    const dir = projectsDirFor(work, root)
    mkdirSync(dir, { recursive: true })
    file = path.join(dir, 's.jsonl')
  })
  afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })
  const later = () => vi.setSystemTime(Date.now() + 10_000) // past the 3 s TTL

  it('an appended turn is seen (the memo never hides a change)', () => {
    writeFileSync(file, line({ type: 'assistant', timestamp: '2026-09-25T10:00:00Z', message: { model: 'claude-a', usage: { input_tokens: 10 } } }))
    expect(readActiveModelFromProjectDir(work, undefined, root)).toBe('claude-a')
    expect(readContextReadingFromProjectDir(work, root).tokens).toBe(10)
    later()
    appendFileSync(file, line({ type: 'assistant', timestamp: '2026-09-25T10:01:00Z', message: { model: 'claude-b', usage: { input_tokens: 20 } } }))
    expect(readActiveModelFromProjectDir(work, undefined, root)).toBe('claude-b')
    expect(readContextReadingFromProjectDir(work, root).tokens).toBe(20)
  })

  it('with a since bound, a model named only before it is not reported', () => {
    writeFileSync(file,
      line({ type: 'assistant', timestamp: '2026-09-25T10:00:00Z', message: { model: 'claude-old' } }) +
      line({ type: 'user', timestamp: '2026-09-25T11:00:00Z', message: { content: 'hi' } }))
    const since = Math.floor(Date.parse('2026-09-25T10:30:00Z') / 1000)
    expect(readActiveModelFromProjectDir(work, since, root)).toBeNull()
    later()
    appendFileSync(file, line({ type: 'assistant', timestamp: '2026-09-25T11:01:00Z', message: { model: 'claude-new' } }))
    expect(readActiveModelFromProjectDir(work, since, root)).toBe('claude-new')
  })
})

describe('OpenRouter price lookup never waits on the network for a list page', () => {
  afterEach(() => { _setOpenRouterCatalogForTest(null); vi.restoreAllMocks() })
  const m = { id: 'x/y', name: 'y', contextLength: 1, promptPrice: 3, completionPrice: 4, free: false }

  it('a stale catalog answers at once and refreshes in the background', async () => {
    _setOpenRouterCatalogForTest([m], 0)
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    expect(await openRouterModelsWithin(Date.now(), 50)).toEqual([m])
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('with no catalog at all it gives up after the wait instead of hanging', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    const t0 = Date.now()
    expect(await openRouterModelsWithin(Date.now(), 30)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('Overview draws before the live measure returns', () => {
  const app = src('web/app.js')
  const body = /async function loadOverview\(\) \{[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''

  it('fires measure=1 in the background and awaits only the plain snapshot', () => {
    expect(body).toContain("const measured = fetch('/api/overview?measure=1')")
    expect(body).toContain("const res = await fetch('/api/overview')")
    expect(body).not.toMatch(/await fetch\('\/api\/overview\?measure=1'\)/)
    // the measured answer still repaints the quota section (refresh = re-measure)
    expect(body).toMatch(/measured\.then[\s\S]*renderOverviewRateLimit\(md\.rateLimit/)
  })

  it('does not hold the activity list behind /api/team/graph', () => {
    expect(body).not.toMatch(/await fetch\('\/api\/team\/graph'\)/)
    expect(body).toContain("fetch('/api/team/graph').then(")
  })
})

describe('user-turn count reads only the appended part of a transcript', () => {
  let home: string
  let oldHome: string | undefined
  beforeEach(() => {
    oldHome = process.env.HOME
    home = mkdtempSync(path.join(tmpdir(), 'turns390-'))
    process.env.HOME = home
  })
  afterEach(() => {
    process.env.HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  })

  it('counts an appended turn and a line finished only in the next write', async () => {
    const { countUserTurnsCached, resetTurnCountCacheForTest, resetTurnFileScansForTest } = await import('../web/routes/overview.js')
    resetTurnCountCacheForTest(); resetTurnFileScansForTest()
    const dir = path.join(home, '.claude', 'projects', 'p1')
    mkdirSync(dir, { recursive: true })
    const f = path.join(dir, 's.jsonl')
    const now = Date.now()
    const turn = (ms: number, content: unknown = 'hi') => JSON.stringify({ type: 'user', timestamp: new Date(ms).toISOString(), message: { content } })
    writeFileSync(f, turn(now - 1000) + '\n' + turn(now - 900, [{ type: 'tool_result' }]) + '\n')
    const from = now - 60_000
    expect(await countUserTurnsCached(from)).toBe(1)
    // a half-written line is not counted yet, and not lost when it completes
    const next = turn(now - 500)
    appendFileSync(f, next.slice(0, 20))
    resetTurnCountCacheForTest()
    expect(await countUserTurnsCached(from)).toBe(1)
    appendFileSync(f, next.slice(20) + '\n' + turn(now - 400) + '\n')
    resetTurnCountCacheForTest()
    expect(await countUserTurnsCached(from)).toBe(3)
    // the time window still applies to remembered stamps
    resetTurnCountCacheForTest()
    expect(await countUserTurnsCached(from, now - 450)).toBe(2)
  })

  it('rereads a file that was rewritten shorter', async () => {
    const { countUserTurnsCached, resetTurnCountCacheForTest, resetTurnFileScansForTest } = await import('../web/routes/overview.js')
    resetTurnCountCacheForTest(); resetTurnFileScansForTest()
    const dir = path.join(home, '.claude', 'projects', 'p2')
    mkdirSync(dir, { recursive: true })
    const f = path.join(dir, 's.jsonl')
    const now = Date.now()
    const turn = (ms: number) => JSON.stringify({ type: 'user', timestamp: new Date(ms).toISOString(), message: { content: 'x' } })
    writeFileSync(f, turn(now - 3000) + '\n' + turn(now - 2000) + '\n')
    expect(await countUserTurnsCached(now - 60_000)).toBe(2)
    writeFileSync(f, turn(now - 1000) + '\n')
    resetTurnCountCacheForTest()
    expect(await countUserTurnsCached(now - 60_000)).toBe(1)
  })

  it('the overview route no longer rereads whole transcripts', () => {
    const o = src('src/web/routes/overview.ts')
    expect(o).toContain('userTurnStampsOf(absFile, fstat)')
    expect(o).not.toMatch(/await readFile\(absFile/)
  })
})

describe('the self-check login probe does not stall the server', () => {
  it('system-health probes through the cached, async-refreshing wrapper', () => {
    const h = src('src/web/system-health.ts')
    expect(h).toContain('proba: (configDir: string) => NamedCred = namedLoginProbeCached,')
    expect(h).not.toContain('proba: (configDir: string) => NamedCred = namedLoginProbe,')
    expect(h).toMatch(/execFile\(CLAUDE_BIN\(\), \['auth', 'status', '--json'\]/)
    expect(src('src/web.ts')).toContain('prewarmLoginProbes()')
  })

  it('a known directory answers from cache and refreshes in the background', async () => {
    const { namedLoginProbeCached, _resetLoginProbeCacheForTest } = await import('../web/system-health.js')
    _resetLoginProbeCacheForTest()
    const dir = mkdtempSync(path.join(tmpdir(), 'probe390-'))
    try {
      const first = namedLoginProbeCached(dir)            // cold: synchronous probe
      const t0 = Date.now()
      expect(namedLoginProbeCached(dir, Date.now() + 120_000)).toBe(first) // stale: immediate
      expect(Date.now() - t0).toBeLessThan(50)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the Drive sync failure list is parsed once per file version', () => {
  it('loadSyncFailures serves from a size+mtime memo and hands out copies', () => {
    const f = src('src/drive-sync-failures.ts')
    expect(f).toContain('if (parsedMemo && parsedMemo.sig === sig) return parsedMemo.rows')
    expect(f).toMatch(/sig = `\$\{st\.ino\}:\$\{st\.size\}:\$\{st\.mtimeMs\}:\$\{st\.ctimeMs\}`/)
    expect(f).toContain('out.push({ ...f })')
  })
})
