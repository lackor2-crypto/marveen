import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import {
  _resetEventLoopWatch, noteLag, noteStallSample, recentStalls, recentStallSamples, trackRequest, watcherPolls,
  STALL_MS, STALL_SAMPLER_SOURCE, alertSevereStall, SEVERE_STALL_MS, SEVERE_ALERT_COOLDOWN_MS, trimStallSampleFile,
} from '../web/event-loop-watch.js'

const fakeRes = () => new EventEmitter() as unknown as http.ServerResponse
const fakeReq = (method: string) => ({ method }) as http.IncomingMessage

describe('#490 event-loop stall watch', () => {
  afterEach(() => _resetEventLoopWatch())

  it('a short delay is not a stall', () => {
    expect(noteLag(STALL_MS - 1)).toBeNull()
    expect(recentStalls()).toEqual([])
  })

  it('a stall names the requests that were running, never the query string', () => {
    const res = fakeRes()
    trackRequest(fakeReq('POST'), res, '/api/workbench/items/x/move')
    const s = noteLag(1200, 1)
    expect(s).toMatchObject({ lagMs: 1200, inflight: ['POST /api/workbench/items/x/move'] })
    ;(res as unknown as EventEmitter).emit('finish')
    expect(noteLag(500, 2)!.inflight).toEqual([])
  })

  it('keeps the worst stalls first', () => {
    noteLag(400, 1); noteLag(2000, 2); noteLag(900, 3)
    expect(recentStalls().map((s) => s.lagMs)).toEqual([2000, 900, 400])
  })
})

// #554: a stall with NO request in flight (a timer, a startup step) used to leave no trace of what ran. The watcher
// thread is tried here on a real process that really blocks: a mocked inspector would prove nothing.
describe('#554 stall sampler: names the code that blocks the main thread', () => {
  afterEach(() => _resetEventLoopWatch())

  /** A throwaway process: main thread ticks, then blocks in `culprit`, then exits. Returns the sampled stacks. */
  function runBlocked(culpritBody: string): Array<{ stuckMs: number; pid: number; noStackYet?: boolean; state?: string; waitingFor?: string[]; stack: Array<{ fn: string; file: string; line: number }> }> {
    const dir = mkdtempSync(join(tmpdir(), 'stall-sampler-'))
    try {
      const out = join(dir, 'stalls.jsonl')
      const script = join(dir, 'blocked.cjs')
      writeFileSync(script, `
        const { Worker } = require('node:worker_threads')
        const { execFileSync } = require('node:child_process')
        const sab = new SharedArrayBuffer(8)
        const beat = new Int32Array(sab)
        new Worker(${JSON.stringify(STALL_SAMPLER_SOURCE)}, { eval: true, workerData: {
          sab, file: ${JSON.stringify(out)}, root: ${JSON.stringify(dir)}, pollMs: 100, afterMs: 300, resampleMs: 60000, max: 3, frames: 14, pid: process.pid, blindMs: 400,
        } }).unref()
        const tick = setInterval(() => Atomics.add(beat, 0, 1), 20)
        function culprit() { ${culpritBody} }
        function startupStepThatCallsIt() { culprit() }
        setTimeout(() => { startupStepThatCallsIt(); setTimeout(() => { clearInterval(tick); process.exit(0) }, 400) }, 300)
      `)
      execFileSync(process.execPath, [script], { timeout: 30_000 })
      return readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('a busy JavaScript loop: the stack names the function and its caller, with a path relative to the root', () => {
    const got = runBlocked('const end = Date.now() + 1500; while (Date.now() < end) { /* spin */ }')
    expect(got.length).toBeGreaterThan(0)
    const fns = got[0].stack.map((f) => f.fn)
    expect(fns).toContain('culprit')
    expect(fns).toContain('startupStepThatCallsIt')
    expect(got[0].stack.find((f) => f.fn === 'culprit')!.file).toBe('blocked.cjs')
    expect(got[0].stuckMs).toBeGreaterThanOrEqual(300)
  }, 40_000)

  it('a synchronous external program (the usual culprit): the stack still names who called it', () => {
    const got = runBlocked(`execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'])`)
    const withStack = got.filter((g) => !g.noStackYet)
    expect(withStack.length).toBeGreaterThan(0)
    expect(withStack[0].stack.map((f) => f.fn)).toContain('culprit')
    expect(withStack[0].stuckMs).toBeGreaterThanOrEqual(1000)
    // While the call had not returned there was no stack to take. On Linux the watcher says so on disk meanwhile,
    // naming the program the process waits for -- that record exists even if the process is killed while stuck.
    if (process.platform === 'linux') {
      const blind = got.filter((g) => g.noStackYet)
      expect(blind.length).toBeGreaterThan(0)
      expect(got.indexOf(blind[0])).toBeLessThan(got.indexOf(withStack[0]))
      expect(blind[0].state).toMatch(/^[A-Za-z]$/)
      expect((blind[0].waitingFor || []).join(' ')).toContain('setTimeout')
    }
  }, 40_000)

  it('a healthy process leaves no sample behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stall-sampler-'))
    try {
      const out = join(dir, 'stalls.jsonl')
      const script = join(dir, 'healthy.cjs')
      writeFileSync(script, `
        const { Worker } = require('node:worker_threads')
        const sab = new SharedArrayBuffer(8)
        const beat = new Int32Array(sab)
        new Worker(${JSON.stringify(STALL_SAMPLER_SOURCE)}, { eval: true, workerData: {
          sab, file: ${JSON.stringify(out)}, root: '', pollMs: 100, afterMs: 300, resampleMs: 60000, max: 3, frames: 14, pid: process.pid, blindMs: 400,
        } }).unref()
        const tick = setInterval(() => Atomics.add(beat, 0, 1), 20)
        setTimeout(() => { clearInterval(tick); process.stdout.write(String(Atomics.load(beat, 1))); process.exit(0) }, 1200)
      `)
      const polls = Number(execFileSync(process.execPath, [script], { timeout: 30_000 }).toString())
      // The watcher counted its own polls (that is what tells a sleeping machine from a stuck process)...
      expect(polls).toBeGreaterThanOrEqual(5)
      // ...and wrote nothing, because nothing was stuck.
      expect(() => readFileSync(out, 'utf8')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)

  it('a sample is kept newest first, and there is no watcher to ask before the watch starts', () => {
    expect(watcherPolls()).toBeNull()
    noteStallSample({ at: 1, stuckMs: 4000, pid: 1, stack: [{ fn: 'a', file: 'x.js', line: 1 }] })
    noteStallSample({ at: 2, stuckMs: 9000, pid: 1, stack: [{ fn: 'b', file: 'y.js', line: 2 }] })
    expect(recentStallSamples().map((s) => s.stuckMs)).toEqual([9000, 4000])
  })

  it('the evidence file keeps its newest lines when it grows long, and a missing file is not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stall-sampler-'))
    try {
      const f = join(dir, 'stalls.jsonl')
      expect(() => trimStallSampleFile(f)).not.toThrow()
      writeFileSync(f, Array.from({ length: 50 }, (_, i) => JSON.stringify({ at: i })).join('\n') + '\n')
      trimStallSampleFile(f, 100, 10)
      const kept = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).at)
      expect(kept).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// #823 (C): a long freeze reaches the owner, throttled; a short one does not.
describe('#823 severe stall alert', () => {
  afterEach(() => _resetEventLoopWatch())
  it('sends for a long stall, names the requests, and is throttled', async () => {
    const sent: string[] = []
    const send = async (t: string) => { sent.push(t) }
    const s = { at: 1000, lagMs: SEVERE_STALL_MS, inflight: ['POST /api/x'] }
    expect(await alertSevereStall(s, send)).toBe(true)
    expect(sent[0]).toContain('POST /api/x')
    expect(await alertSevereStall({ ...s, at: 2000 }, send)).toBe(false)
    expect(await alertSevereStall({ ...s, at: 1000 + SEVERE_ALERT_COOLDOWN_MS }, send)).toBe(true)
    expect(sent.length).toBe(2)
  })
  it('does not send for a stall under the limit, and a failing send does not throw', async () => {
    const send = async () => { throw new Error('x') }
    expect(await alertSevereStall({ at: 1, lagMs: SEVERE_STALL_MS - 1, inflight: [] }, send)).toBe(false)
    expect(await alertSevereStall({ at: 5, lagMs: SEVERE_STALL_MS, inflight: [] }, send)).toBe(false)
  })
})
