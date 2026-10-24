import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #778: the worker "never became ready" page went out after the FIRST 90s
// window although the restart + retry brought the worker up a moment later,
// and a self-heal restart only got the ~65s left of the original window.
const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-worker.ts'), 'utf8')

function body(name: string): string {
  const start = SRC.indexOf(name)
  expect(start).toBeGreaterThan(-1)
  const next = SRC.indexOf('\nasync function ', start + 10)
  const nextExport = SRC.indexOf('\nexport async function ', start + 10)
  const ends = [next, nextExport].filter(n => n > start)
  return SRC.slice(start, ends.length ? Math.min(...ends) : undefined)
}

describe('worker not-ready alert (#778)', () => {
  it('ensureWorkerReady records the screen but does not page the owner', () => {
    const b = body('async function ensureWorkerReady')
    expect(b).not.toContain('alertWorkerStuck(')
    expect(b).toContain('recordWorkerNotReady(')
  })

  it('a self-heal restart opens a fresh boot window', () => {
    const b = body('async function ensureWorkerReady')
    expect(b).toMatch(/selfHealWorkerOnce\(ctx\) === 'restarted'\) deadline = Date\.now\(\) \+ WORKER_BOOT_TIMEOUT_MS/)
  })

  it('the owner is paged only after the restart + retry also failed', () => {
    const b = body('export async function runViaWorker')
    const retry = b.indexOf('restarting once and retrying the request')
    const alert = b.indexOf('alertWorkerStuck(')
    expect(retry).toBeGreaterThan(-1)
    expect(alert).toBeGreaterThan(retry)
  })

  it('the not-ready evidence lands in store/worker-stuck.log', () => {
    expect(SRC).toContain("join(STORE_DIR, 'worker-stuck.log')")
  })
})
