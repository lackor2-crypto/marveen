import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, existsSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendWorkerStuckEvidence, WORKER_STUCK_LOG_MAX_BYTES, WORKER_STUCK_LOG_KEEP } from '../web/agent-worker.js'

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

describe('worker-stuck.log stays bounded (#778)', () => {
  it('appends while under the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-stuck-'))
    try {
      const p = join(dir, 'worker-stuck.log')
      appendWorkerStuckEvidence(p, 'a\n')
      appendWorkerStuckEvidence(p, 'b\n')
      expect(readFileSync(p, 'utf8')).toBe('a\nb\n')
      expect(existsSync(`${p}.1.gz`)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rotates into gzipped generations once over the cap and keeps only KEEP of them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-stuck-'))
    try {
      const p = join(dir, 'worker-stuck.log')
      const big = 'x'.repeat(WORKER_STUCK_LOG_MAX_BYTES + 1)
      for (let i = 0; i < WORKER_STUCK_LOG_KEEP + 2; i++) {
        writeFileSync(p, big)
        appendWorkerStuckEvidence(p, `entry ${i}\n`)
        // the new entry starts a fresh live file, the old screens are archived
        expect(readFileSync(p, 'utf8')).toBe(`entry ${i}\n`)
      }
      expect(statSync(`${p}.1.gz`).size).toBeGreaterThan(0)
      expect(existsSync(`${p}.${WORKER_STUCK_LOG_KEEP}.gz`)).toBe(true)
      expect(existsSync(`${p}.${WORKER_STUCK_LOG_KEEP + 1}.gz`)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
