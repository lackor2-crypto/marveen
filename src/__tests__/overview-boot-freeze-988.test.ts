// #988: the dashboard froze for 3 s twice on 2026-11-27 -- once in the Overview
// self-check (log tails, the Drive failure list, login probes in one synchronous
// run), once right after boot (hook backfill, program probes, transcript walk).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'freeze988-'))
vi.mock('../config.js', async (orig) => ({
  ...(await orig<object>()), PROJECT_ROOT: root, STORE_DIR: path.join(root, 'store'),
}))

const src = (f: string) => readFileSync(new URL('../' + f, import.meta.url), 'utf-8')

/** Counts event-loop turns that happen while `work` is pending. */
async function turnsDuring(work: () => Promise<unknown>): Promise<number> {
  let turns = 0
  let running = true
  const tick = (): void => { if (running) { turns++; setImmediate(tick) } }
  setImmediate(tick)
  try { await work() } finally { running = false }
  return turns
}

const line = (runId: string, n: number): string => JSON.stringify({
  runId, at: `2026-11-27T10:00:00.${String(n % 1000).padStart(3, '0')}Z`, account: 'a', pair: 'p', pairId: 'pid',
  phase: 'letöltés', localPath: '/x/' + n, driveName: 'f' + n, driveId: '', reason: 'HTTP 403',
}) + '\n'

let drive: typeof import('../drive-sync-failures.js')
beforeAll(async () => {
  mkdirSync(path.join(root, 'store'), { recursive: true })
  drive = await import('../drive-sync-failures.js')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('Drive failure list', () => {
  it('is parsed in slices, then continued on append and re-read on rewrite', async () => {
    expect(drive.FAILURES_PATH.startsWith(root)).toBe(true)
    writeFileSync(drive.FAILURES_PATH, Array.from({ length: 5000 }, (_, i) => line('r1', i)).join(''))
    expect(await turnsDuring(() => drive.primeSyncFailures())).toBeGreaterThanOrEqual(10)
    expect(drive.loadSyncFailures().length).toBe(5000)

    const parse = vi.spyOn(JSON, 'parse')
    appendFileSync(drive.FAILURES_PATH, line('r2', 5001))
    expect(drive.loadSyncFailures({ limit: 1 })[0].driveName).toBe('f5001')
    expect(parse.mock.calls.length).toBe(1) // only the appended line
    parse.mockRestore()
    expect(drive.loadSyncFailures().length).toBe(5001)

    // Same file, longer, different content: not an append.
    writeFileSync(drive.FAILURES_PATH, Array.from({ length: 5100 }, (_, i) => line('r3', i)).join(''))
    expect(drive.syncFailureRuns().map(r => [r.runId, r.count])).toEqual([['r3', 5100]])
  })
})

describe('Overview self-check', () => {
  it('gives the event loop a turn between the row builders and reports the same rows', async () => {
    const h = await import('../web/system-health.js')
    h._resetLoginProbeCacheForTest()
    let rows: Awaited<ReturnType<typeof h.systemHealthAsync>> = []
    const turns = await turnsDuring(async () => { rows = await h.systemHealthAsync() })
    expect(turns).toBeGreaterThanOrEqual(20)
    expect(rows.map(r => r.id).sort()).toEqual(h.systemHealth().map(r => r.id).sort())
  }, 120_000)

  it('scans the logs without blocking and finds the same file', async () => {
    const h = await import('../web/system-health.js')
    const dir = mkdtempSync(path.join(root, 'logs-'))
    writeFileSync(path.join(dir, 'clean.log'), 'nothing here\n')
    writeFileSync(path.join(dir, 'leak.log'), 'x\n'.repeat(200_000) + 'Authorization: Bearer ' + 'a'.repeat(30) + '\n')
    expect(await h.secretsInLogsAsync(dir, 1)).toEqual(['leak.log'])
  })

  it('the summary route uses the non-blocking check', () => {
    expect(src('web/routes/connections.ts')).toContain('await systemHealthAsync()')
    expect(src('web/routes/connections.ts')).not.toMatch(/systemHealth\(\)/)
    expect(src('web/routes/drive-sync.ts')).toContain('await primeSyncFailures()')
  })
})

describe('boot', () => {
  it('asks at most two programs for their version at a time', async () => {
    const { measureSystemDeps, SYSTEM_DEPS } = await import('../system-deps.js')
    let busy = 0
    let most = 0
    const deps = Array.from({ length: 8 }, (_, i) => ({
      ...SYSTEM_DEPS[0],
      id: 'fake' + i,
      probe: async () => {
        most = Math.max(most, ++busy)
        await new Promise(r => setTimeout(r, 5))
        busy--
        return { available: true, path: 'x', version: '1', reason: 'ok' as const, detail: null, checked_at: Date.now() }
      },
    }))
    const snap = await measureSystemDeps(true, deps)
    expect(snap.items.map(i => i.id)).toEqual(deps.map(d => d.id))
    expect(most).toBeLessThanOrEqual(2)
  })

  it('walks the transcripts without synchronous directory or stat calls', () => {
    expect(src('web/token-usage.ts')).not.toMatch(/\b(statSync|readdirSync)\b/)
  })

  it('yields between agents in the hook backfill and does not wait on tesseract', () => {
    const web = src('web.ts')
    expect(web).toMatch(/for \(const agentName of \[MAIN_AGENT_ID, \.\.\.listAgentNames\(\)\]\) \{\s*await yieldToLoop\(\)/)
    expect(web).toMatch(/primeOcrLanguages\(\)\s*\.then\(\(\) => initVisionAdapters\(\)\)/)
  })
})
