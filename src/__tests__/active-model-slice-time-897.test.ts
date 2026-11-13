// #897: a byte budget alone is a promise about a FAST disk. Measured on a loaded machine
// (2026-11-13): one 2 MiB background slice of a transcript walk held the main thread for 720 ms.
// A slice therefore also ends when its time is up. The test drives the slice clock by hand, so it
// counts bytes and does not depend on how fast the runner's disk is.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  foldTranscript, setSliceClockForTests, _resetScanMemoForTest, _scanBytesReadForTest, _scanSettledForTest,
  type TranscriptFold,
} from '../web/active-model.js'

const CHUNK = 256 * 1024
let root: string

const countFold: TranscriptFold<{ lines: number }> = {
  init: () => ({ lines: 0 }),
  visit: (s) => { s.lines++; return false },
  merge: (a, b) => ({ lines: a.lines + b.lines }),
}
const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(40_000) } }) + '\n'

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'slice897-')); _resetScanMemoForTest() })
afterEach(async () => {
  await _scanSettledForTest()
  setSliceClockForTests(null)
  rmSync(root, { recursive: true, force: true })
})

describe('a transcript-walk slice ends when its time is up (#897)', () => {
  it('on a slow disk the first call reads one chunk, not the whole byte budget', async () => {
    const file = join(root, 's.jsonl')
    const lines = 200 // ~8 MB, nothing to stop at
    writeFileSync(file, line.repeat(lines))
    // every look at the clock costs 1 s: the disk is "slow", every slice is out of time at once
    let t = 0
    setSliceClockForTests(() => (t += 1000))

    const first = foldTranscript('k', file, countFold)
    expect(first.provisional).toBe(true)
    // the bug: the 4 MiB sync budget was read in one go whatever the clock said
    expect(_scanBytesReadForTest()).toBeLessThanOrEqual(CHUNK)
    expect(_scanBytesReadForTest()).toBeGreaterThan(0) // it still moves forward

    // and the walk still ends with the right answer
    await _scanSettledForTest()
    expect(foldTranscript('k', file, countFold)).toEqual({ state: { lines }, provisional: false })
  })

  it('on a fast disk the byte budget alone decides, as before', () => {
    const file = join(root, 'f.jsonl')
    writeFileSync(file, line.repeat(200))
    setSliceClockForTests(() => 0) // time never passes
    foldTranscript('k', file, countFold)
    // 4 MiB sync budget, read in whole chunks
    expect(_scanBytesReadForTest()).toBeGreaterThan(CHUNK)
    expect(_scanBytesReadForTest()).toBeLessThanOrEqual(4 * 1024 * 1024 + CHUNK)
  })
})
