// #390: starting a child process blocks the event loop for the fork itself --
// even through the ASYNC execFile (live CPU profile 2026-09-25: 715 async + 231
// sync spawns in 190 s, 25.6 s of frozen server, median 18 ms, up to 200 ms).
//
// What must hold:
//   - captures asked for in the same event-loop turn go out as ONE tmux call,
//     each answer still the pane at the moment it was asked (no cache),
//   - a session that went away answers null exactly like a single capture, and
//     the panes after it are still answered (tmux aborts a sequence there),
//   - the event loop keeps turning while tmux runs (the capture never blocks),
//   - stuck-input recovery DETECTS on the sweep's picture but only ever types
//     into a pane after a FRESH capture agrees (lackor2-bot's condition, 4445),
//   - the schedule runner is untouched (its behaviour must not change).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { batchCaptureArgs, splitBatchOutput, makeBatchedCapture, type TmuxRun } from '../web/tmux-batch-capture.js'

const REPO = join(__dirname, '..', '..')

/** A fake tmux that understands the batch sequence and knows these panes. */
function fakeTmux(panes: Record<string, string>, delayMs = 0) {
  const calls: string[][] = []
  const run: TmuxRun = async (args) => {
    calls.push(args)
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    let out = ''
    const cmds: string[][] = [[]]
    for (const a of args) { if (a === ';') cmds.push([]); else cmds[cmds.length - 1].push(a) }
    for (const c of cmds) {
      if (c[0] === 'display-message') { out += c[2] + '\n'; continue }
      const s = c[c.indexOf('-t') + 1]
      if (!(s in panes)) return { ok: false, out }
      out += panes[s]
    }
    return { ok: true, out }
  }
  const singles: string[] = []
  const single = async (s: string) => { singles.push(s); return s in panes ? panes[s] : null }
  return { run, single, calls, singles }
}

describe('batch output split', () => {
  it('each pane gets exactly its own text, empty panes and look-alike text included', () => {
    const n = 'abc'
    const panes = ['one\ntwo\n', '', '@@marveen-capture-zzz-0@@\nx\n']
    const out = panes.map((p, i) => `@@marveen-capture-${n}-${i}@@\n${p}`).join('')
    expect(splitBatchOutput(out, 3, n, true)).toEqual(panes)
  })
  it('an unfinished sequence leaves the rest unanswered (never a guess)', () => {
    const out = '@@marveen-capture-q-0@@\nA\n@@marveen-capture-q-1@@\n'
    expect(splitBatchOutput(out, 3, 'q', false)).toEqual(['A\n', undefined, undefined])
    // the last pane only counts when tmux exited 0
    expect(splitBatchOutput('@@marveen-capture-q-0@@\nA\n', 1, 'q', false)).toEqual([undefined])
  })
  it('args: one display-message + capture-pane per session, flags kept', () => {
    expect(batchCaptureArgs(['a', 'b'], 'n', ['-e', '-p'])).toEqual([
      'display-message', '-p', '@@marveen-capture-n-0@@', ';', 'capture-pane', '-t', 'a', '-e', '-p', ';',
      'display-message', '-p', '@@marveen-capture-n-1@@', ';', 'capture-pane', '-t', 'b', '-e', '-p',
    ])
  })
})

describe('batched capture', () => {
  it('one tmux process for every capture asked in the same turn', async () => {
    const t = fakeTmux({ a: 'A\n', b: 'B\n', c: 'C\n' })
    const cap = makeBatchedCapture(t.run, t.single)
    expect(await Promise.all([cap('a'), cap('b'), cap('c'), cap('a')])).toEqual(['A\n', 'B\n', 'C\n', 'A\n'])
    expect(t.calls.length).toBe(1)
    expect(t.singles).toEqual([])
  })
  it('a missing session answers null; the panes after it are still answered', async () => {
    const t = fakeTmux({ a: 'A\n', c: 'C\n', d: 'D\n' })
    const cap = makeBatchedCapture(t.run, t.single)
    expect(await Promise.all([cap('a'), cap('gone'), cap('c'), cap('d')])).toEqual(['A\n', null, 'C\n', 'D\n'])
    expect(t.singles).toEqual(['gone'])
    expect(t.calls.length).toBe(2) // [a,gone,c,d] then [c,d]
  })
  it('a later turn is a new, fresh capture (nothing cached)', async () => {
    const panes: Record<string, string> = { a: 'old\n', b: 'B\n' }
    const t = fakeTmux(panes)
    const cap = makeBatchedCapture(t.run, t.single)
    await Promise.all([cap('a'), cap('b')])
    panes.a = 'new\n'
    expect(await Promise.all([cap('a'), cap('b')])).toEqual(['new\n', 'B\n'])
    expect(t.calls.length).toBe(2)
  })
  it('the event loop keeps turning while tmux is slow', async () => {
    const t = fakeTmux({ a: 'A\n', b: 'B\n' }, 150)
    const cap = makeBatchedCapture(t.run, t.single)
    let ticks = 0
    const iv = setInterval(() => { ticks++ }, 10)
    const t0 = Date.now()
    const res = await Promise.all([cap('a'), cap('b')])
    clearInterval(iv)
    expect(res).toEqual(['A\n', 'B\n'])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
    expect(ticks).toBeGreaterThanOrEqual(5)
  })
})

// --- stuck-input recovery: detect on the observed picture, act on a fresh one
const SEP = '─'.repeat(80)
const PARKED = ['', SEP, '❯ Valami amit a felhasznalo elkezdett geppelni, meg nem kuldte el', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const EMPTY = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

const ap = vi.hoisted(() => ({
  observed: '' as string | null,
  fresh: '' as string | null,
  clear: vi.fn(async () => {}),
  send: vi.fn(async () => {}),
  dismiss: vi.fn(async () => {}),
}))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  observedParkedInputView: () => ap.observed,
  captureParkedInputView: () => ap.fresh,
  clearInputBuffer: ap.clear,
  sendPromptToSession: ap.send,
  dismissModelConsentDialogIfPresent: ap.dismiss,
}))

describe('stuck-input recovery acts only on a fresh capture', () => {
  const T = { confirmMs: 12_000, dedupMs: 12_000, maxAttempts: 5 }
  beforeEach(() => { ap.clear.mockClear(); ap.send.mockClear() })

  async function spellThenTick(): Promise<{ parkedSig: string | null }> {
    const { recoverStuckInputForSession } = await import('../web/channel-monitor.js')
    const { stuckInputSignature } = await import('../pane-state.js')
    // A spell confirmed long ago, at attempt 3 (-> clear + re-inject is due).
    const prev = { parkedSig: stuckInputSignature(PARKED), firstSeenAt: Date.now() - 60_000, lastRecoverAt: Date.now() - 60_000, attempts: 3 }
    return recoverStuckInputForSession('agent-x', prev, T, true)
  }

  it('observed says parked, fresh says empty -> nothing is typed', async () => {
    ap.observed = PARKED
    ap.fresh = EMPTY
    const next = await spellThenTick()
    expect(ap.clear).not.toHaveBeenCalled()
    expect(ap.send).not.toHaveBeenCalled()
    expect(next.parkedSig).toBeNull()
  })

  it('observed and fresh both parked -> the recovery runs', async () => {
    ap.observed = PARKED
    ap.fresh = PARKED
    await spellThenTick()
    expect(ap.clear).toHaveBeenCalledTimes(1)
    expect(ap.send).toHaveBeenCalledTimes(1)
  })

  it('observed empty -> no fresh capture needed, nothing typed', async () => {
    ap.observed = EMPTY
    ap.fresh = PARKED // would be wrong to act on: never read
    await spellThenTick()
    expect(ap.send).not.toHaveBeenCalled()
  })
})

describe('wiring', () => {
  const src = (f: string) => readFileSync(join(REPO, f), 'utf8')
  it('the activity poll captures through the batched path', () => {
    expect(src('src/web/agent-process.ts')).toMatch(/export function capturePaneAsync\(session: string\): Promise<string \| null> \{\s*return batchedCapture\(session\)/)
  })
  it('the watcher sweep prefetches, and the parked-paste Enter is re-checked fresh', () => {
    const w = src('src/web/stuck-input-watcher.ts')
    expect(w).toContain('await prefetchParkedInputViews(local)')
    expect(w).toMatch(/const seen = observedParkedInputView\(session, host\)[\s\S]*if \(recover\) \{\s*const fresh = captureParkedInputView\(session, host\)/)
  })
  it('anything typed into a pane drops the observed pictures', () => {
    expect(src('src/web/agent-process.ts')).toMatch(/function runTmux\([^)]*\): void \{\s*\/\/[^\n]*\n\s*if \(!host\) invalidateObservedPanes\(\)/)
    expect(src('src/web/channel-monitor.ts')).toContain('invalidateObservedPanes(session)')
  })
  it('the schedule runner is not touched by this change', () => {
    expect(src('src/web/schedule-runner.ts')).not.toMatch(/observedParkedInputView|prefetchParkedInputViews|makeBatchedCapture/)
  })
})
