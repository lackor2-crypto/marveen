// #897: the agent list read a live session's transcript from its end to its first byte on the
// main thread every time the file changed, when the file named no model and carried no usage
// (measured on the owner's machine: 82 MB, 575 ms per walk, dozens of times a day).
// A transcript is append-only, so only the new bytes are read, and a long first walk is cut
// into slices. The tests count BYTES READ, not milliseconds, so they do not depend on the runner.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  projectsDirFor, readActiveModelFromProjectDir, readContextReadingFromProjectDir, foldTranscript,
  _resetScanMemoForTest, _scanBytesReadForTest, _scanSettledForTest, type TranscriptFold,
} from '../web/active-model.js'

let root: string
let n = 0
function freshDir(): { work: string; cfg: string; file: string } {
  const work = join(root, 'work' + ++n)
  const cfg = join(root, 'cfg' + n)
  const dir = projectsDirFor(work, cfg)
  mkdirSync(dir, { recursive: true })
  return { work, cfg, file: join(dir, 'session.jsonl') }
}
const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
const userLine = (i: number, pad = 0) => JSON.stringify({ type: 'user', timestamp: ts(i), message: { role: 'user', content: 'x'.repeat(pad) } }) + '\n'
const turnLine = (i: number, model: string, tokens: number) => JSON.stringify({ type: 'assistant', timestamp: ts(i), message: { model, usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n'
const rejectedLine = (i: number) => JSON.stringify({ type: 'assistant', timestamp: ts(i), isApiErrorMessage: true, apiErrorStatus: 429, quotaLimits: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour' }, message: { model: '<synthetic>', usage: { input_tokens: 0 }, content: [{ type: 'text', text: 'limit' }] } }) + '\n'
const boundaryLine = (i: number, post: number) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: ts(i), compactMetadata: { postTokens: post } }) + '\n'

// The readers keep their answer for a few seconds per directory: the clock is moved past that.
let clock = Date.UTC(2026, 5, 1)
function reading(work: string, cfg: string) {
  clock += 10_000
  vi.setSystemTime(clock)
  return { ctx: readContextReadingFromProjectDir(work, cfg), model: readActiveModelFromProjectDir(work, undefined, cfg) }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); root = mkdtempSync(join(tmpdir(), 'am897-')); _resetScanMemoForTest() })
afterEach(async () => { await _scanSettledForTest(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

const countFold: TranscriptFold<{ lines: number }> = {
  init: () => ({ lines: 0 }),
  visit: (s) => { s.lines++; return false },
  merge: (a, b) => ({ lines: a.lines + b.lines }),
}

describe('transcript scans read only what is new (#897)', () => {
  it('a large transcript with nothing to stop at is not walked again when a line is appended', async () => {
    const { file } = freshDir()
    const line = userLine(1, 40_000)
    const lines = 600 // ~24 MB, no model line, no usage
    writeFileSync(file, line.repeat(lines))
    const total = line.length * lines

    const first = foldTranscript('k', file, countFold)
    // the first call gives the thread back long before the end of the file
    expect(first.provisional).toBe(true)
    expect(_scanBytesReadForTest()).toBeLessThan(total / 3)
    await _scanSettledForTest()
    const full = foldTranscript('k', file, countFold)
    expect(full).toEqual({ state: { lines }, provisional: false })
    expect(_scanBytesReadForTest()).toBeGreaterThanOrEqual(total)

    const before = _scanBytesReadForTest()
    appendFileSync(file, userLine(2, 100))
    const grown = foldTranscript('k', file, countFold)
    expect(grown).toEqual({ state: { lines: lines + 1 }, provisional: false })
    // the bug: this read the whole file again
    expect(_scanBytesReadForTest() - before).toBeLessThan(4096)
  })

  it('an unchanged file is not read at all', () => {
    const { file } = freshDir()
    writeFileSync(file, userLine(1) + userLine(2))
    foldTranscript('k', file, countFold)
    const before = _scanBytesReadForTest()
    expect(foldTranscript('k', file, countFold).state.lines).toBe(2)
    expect(_scanBytesReadForTest()).toBe(before)
  })

  it('a file that was rewritten, not appended to, is read again from scratch', () => {
    const { file } = freshDir()
    writeFileSync(file, userLine(1) + userLine(2) + userLine(3))
    expect(foldTranscript('k', file, countFold).state.lines).toBe(3)
    // shorter
    writeFileSync(file, userLine(9))
    expect(foldTranscript('k', file, countFold).state.lines).toBe(1)
    // longer, but the old bytes are not there any more
    writeFileSync(file, userLine(7, 5) + userLine(8, 5) + userLine(9, 500))
    expect(foldTranscript('k', file, countFold).state.lines).toBe(3)
    // same size, other time
    utimesSync(file, new Date(), new Date(Date.now() + 60_000))
    expect(foldTranscript('k', file, countFold).state.lines).toBe(3)
  })

  it('a last line still being written is not lost', () => {
    const { file } = freshDir()
    const whole = userLine(2)
    writeFileSync(file, userLine(1) + whole.slice(0, 20))
    foldTranscript('k', file, countFold)
    appendFileSync(file, whole.slice(20) + userLine(3))
    expect(foldTranscript('k', file, countFold).state.lines).toBe(3)
  })

  it('step by step, the incremental answer is the answer of a cold read', async () => {
    const steps: string[] = [
      userLine(1), userLine(2),                       // no turn yet: fresh
      turnLine(3, 'claude-a', 1000),                  // measured
      userLine(4),                                    // older number stands
      rejectedLine(5),                                // one rejected turn on top of a measured one
      rejectedLine(6),                                // the run grows
      userLine(7),
      turnLine(8, 'claude-b', 2500),                  // answering again: the wall is gone
      boundaryLine(9, 400),                           // compaction
      userLine(10),
      rejectedLine(11), rejectedLine(12),             // rejected right after a compaction
      turnLine(13, 'claude-c', 700),
    ]
    // one process watching the file grow
    const { work, cfg, file } = freshDir()
    writeFileSync(file, '')
    const warm: unknown[] = []
    for (const step of steps) { appendFileSync(file, step); warm.push(reading(work, cfg)) }
    // a brand-new process for every length of the same file
    for (let i = 0; i < steps.length; i++) {
      const d = freshDir()
      writeFileSync(d.file, steps.slice(0, i + 1).join(''))
      _resetScanMemoForTest()
      expect({ step: i, ...(warm[i] as object) }).toEqual({ step: i, ...reading(d.work, d.cfg) })
    }
    expect(warm[1]).toEqual({ ctx: { tokens: null, state: 'fresh' }, model: null })
    expect(warm[3]).toEqual({ ctx: { tokens: 1000, state: 'measured' }, model: 'claude-a' })
    expect((warm[5] as any).ctx.quota.rejectedTurns).toBe(2)
    expect((warm[7] as any).ctx).toEqual({ tokens: 2500, state: 'measured' })
    expect((warm[8] as any).ctx).toEqual({ tokens: 400, state: 'measured' })
    expect((warm[11] as any).ctx.quota.rejectedTurns).toBe(2)
    expect(warm[12]).toEqual({ ctx: { tokens: 700, state: 'measured' }, model: 'claude-c' })
  })

  it('a wall of rejected turns with no number under it is counted across calls', () => {
    const { work, cfg, file } = freshDir()
    writeFileSync(file, userLine(1) + rejectedLine(2))
    const r1 = reading(work, cfg).ctx
    expect(r1.state).toBe('quota-blocked')
    expect(r1.quota?.rejectedTurns).toBe(1)
    appendFileSync(file, rejectedLine(3) + rejectedLine(4))
    const r2 = reading(work, cfg).ctx
    expect(r2.state).toBe('quota-blocked')
    expect(r2.quota?.rejectedTurns).toBe(3)
  })
})
