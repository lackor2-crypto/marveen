// #390: the failure list is parsed once per file version, but every write
// (append, clear) must still be seen at once.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'dsf390-'))
vi.mock('../config.js', async (orig) => ({ ...(await orig<object>()), PROJECT_ROOT: root }))

let m: typeof import('../drive-sync-failures.js')
beforeAll(async () => { m = await import('../drive-sync-failures.js') })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const f = (runId: string, n: number) => ({
  runId, at: `2026-09-25T10:00:0${n}Z`, account: 'a', pair: 'p', pairId: 'pid',
  phase: 'letöltés' as const, localPath: '/x/' + n, driveName: 'f' + n, reason: 'HTTP 403',
})

describe('loadSyncFailures memo', () => {
  it('sees appends and clears, and the caller cannot alter the memo', () => {
    expect(m.FAILURES_PATH.startsWith(root)).toBe(true)
    m.recordSyncFailure(f('r1', 1) as any)
    expect(m.loadSyncFailures().map(x => x.driveName)).toEqual(['f1'])
    m.recordSyncFailure(f('r2', 2) as any)
    const all = m.loadSyncFailures()
    expect(all.map(x => x.driveName)).toEqual(['f2', 'f1'])
    all[0].driveName = 'changed'
    expect(m.loadSyncFailures({ runId: 'r2' })[0].driveName).toBe('f2')
    expect(m.loadSyncFailures({ limit: 1 }).length).toBe(1)
    expect(m.syncFailureRuns().map(r => r.runId)).toEqual(['r2', 'r1'])
    m.clearSyncFailures()
    expect(m.loadSyncFailures()).toEqual([])
  })
})
