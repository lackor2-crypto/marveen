/**
 * #490: which request blocks the dashboard? The Node.js guidance ("Don't block the event loop") is to measure
 * before rewriting: a timer that should fire every TICK_MS notices when it fires late, and the requests that were
 * in flight at that moment are the suspects (a synchronous walk over the slow 9p depot mount, a big JSON, ...).
 * Each stall over STALL_MS is logged once with the suspects; the worst ones are kept for GET /api/perf/stalls.
 * Measuring costs one timer and a Set insert per request; it never changes what a request does.
 *
 * #554: most stalls have NO request in flight (a timer or a startup step blocks), so the list above stays empty.
 * A watcher thread therefore samples WHERE the main thread is: it notices that the main thread stopped ticking,
 * asks the inspector to pause it and writes the call stack to store/event-loop-stalls.jsonl -- from its own thread,
 * so the evidence is on disk even if the process is killed while still stuck. The same thread is the proof that the
 * machine was awake during a long gap (see wake-detect.ts): a sleeping machine stops the watcher thread too.
 */
import type http from 'node:http'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export const TICK_MS = 100
export const STALL_MS = 300
const KEEP = 30
/** #823 (C): a stall this long is told to the owner on the channel (after the fact: a frozen process cannot send). */
export const SEVERE_STALL_MS = 3000
/** At most one such message per this long, so a bad hour is one message, not a flood. */
export const SEVERE_ALERT_COOLDOWN_MS = 30 * 60 * 1000
let lastSevereAlertAt = 0

export type Stall = { at: number; lagMs: number; inflight: string[] }

/** How often the watcher thread looks at the main thread's heartbeat. */
export const SAMPLER_POLL_MS = 1000
/** The main thread must be silent this long before its stack is sampled. */
export const SAMPLE_AFTER_MS = 3000
/** No answer from the main thread this long after asking: write what the operating system shows meanwhile. */
export const BLIND_AFTER_MS = 10_000
/** A stall that goes on is sampled again this often, at most SAMPLE_MAX times. */
export const RESAMPLE_MS = 30_000
export const SAMPLE_MAX = 6
export const STALL_SAMPLE_FILE = 'event-loop-stalls.jsonl'

export type StackFrame = { fn: string; file: string; line: number }
/** One look at the blocked main thread. `inflight` is what the stuck thread could not tell: filled in afterwards. */
export type StallSample = {
  at: number; stuckMs: number; pid: number; stack: StackFrame[]; inflight?: string[]
  /** Set while the thread is still inside one system call: no stack yet, only what the OS shows (Linux). */
  noStackYet?: boolean; state?: string; waitingFor?: string[]
}

/**
 * The watcher thread, as source text: it runs under tsx and from dist alike, with no second file to ship.
 * beat[0] is the main thread's tick counter, beat[1] its own (how long it has been watching, in polls).
 */
export const STALL_SAMPLER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads')
const inspector = require('node:inspector')
const fs = require('node:fs')
const { sab, file, root, pollMs, afterMs, resampleMs, max, frames, pid, blindMs } = workerData
const beat = new Int32Array(sab)
let last = Atomics.load(beat, 0), stuckSince = 0, taken = 0, nextAt = 0, busy = false, prevTick = Date.now()
let askedAt = 0, blindTaken = 0, blindNextAt = 0
// The inspector can only stop the main thread once it is back in JavaScript. While it sits inside ONE long system
// call (an external program, a read on a hung drive) there is no stack yet -- so say what the operating system
// shows instead: the process state and the programs it is waiting for. Linux only; elsewhere this writes nothing.
function blind(now) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    let waitingFor = []
    try {
      waitingFor = fs.readFileSync('/proc/' + pid + '/task/' + pid + '/children', 'utf8').trim().split(/\\s+/).filter(Boolean).slice(0, 5).map((c) => {
        try { return fs.readFileSync('/proc/' + c + '/cmdline', 'utf8').split('\\0').filter(Boolean).slice(0, 3).join(' ').slice(0, 120) } catch { return 'pid ' + c }
      })
    } catch {}
    const rec = { at: now, stuckMs: now - stuckSince, pid, stack: [], noStackYet: true, state, waitingFor }
    fs.appendFileSync(file, JSON.stringify(rec) + '\\n')
    try { parentPort.postMessage(rec) } catch {}
  } catch {}
  blindTaken++; blindNextAt = now + resampleMs
}
const short = (url) => {
  let u = String(url || '').replace(/^file:\\/\\//, '')
  if (root && u.startsWith(root)) u = u.slice(root.length).replace(/^[\\/\\\\]+/, '')
  return u
}
let abandon = null
function sample() {
  busy = true
  const since = stuckSince
  let session
  const end = () => { busy = false; abandon = null; try { session.post('Debugger.disable') } catch {} try { session.disconnect() } catch {} }
  try {
    session = new inspector.Session()
    session.connectToMainThread()
    // A frame names its script by id; the ids are announced when the debugger is switched on.
    const urls = new Map()
    session.on('Debugger.scriptParsed', (m) => { if (m.params.url) urls.set(m.params.scriptId, m.params.url) })
    session.on('Debugger.paused', (m) => {
      // Resume FIRST: nothing below may keep the main thread paused.
      try { session.post('Debugger.resume') } catch {}
      const now = Date.now()
      const stack = (m.params.callFrames || []).slice(0, frames).map((f) => ({
        fn: f.functionName || '(anonymous)', file: short(f.url || urls.get(f.location && f.location.scriptId)), line: (f.location ? f.location.lineNumber : 0) + 1,
      }))
      const rec = { at: now, stuckMs: now - since, pid, stack }
      try { fs.appendFileSync(file, JSON.stringify(rec) + '\\n') } catch {}
      try { parentPort.postMessage(rec) } catch {}
      taken++; nextAt = now + resampleMs
      end()
    })
    // Not chained on callbacks: a blocked main thread answers nothing until it returns to JavaScript.
    session.post('Debugger.enable')
    session.post('Debugger.pause')
    askedAt = Date.now()
    abandon = end
  } catch { end() }
}
setInterval(() => {
  const now = Date.now()
  const ownGap = now - prevTick
  prevTick = now
  Atomics.add(beat, 1, 1)
  const cur = Atomics.load(beat, 0)
  // This thread did not run either (the machine slept, or the whole process was stopped): no evidence of a stall.
  if (ownGap > pollMs * 5) { last = cur; stuckSince = 0; taken = 0; return }
  if (cur !== last) {
    // The main thread runs again, yet the pause we asked for a minute ago never arrived: give that session up,
    // or this thread would wait for it forever and never sample again.
    if (busy && abandon && now - askedAt > 60000) abandon()
    last = cur; stuckSince = 0; taken = 0; nextAt = 0; blindTaken = 0; blindNextAt = 0
    return
  }
  if (!stuckSince) stuckSince = now - pollMs
  if (busy && stuckSince && now - askedAt >= blindMs && blindTaken < max && now >= blindNextAt) blind(now)
  if (busy || taken >= max || now < nextAt || now - stuckSince < afterMs) return
  sample()
}, pollMs)
`

const inflight = new Map<number, string>()
let seq = 0
const stalls: Stall[] = []
const samples: StallSample[] = []
let timer: NodeJS.Timeout | null = null
let sampler: Worker | null = null
let beat: Int32Array | null = null

/** Remember the request while it runs (method + path, never the query: it can carry a token). */
export function trackRequest(req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
  const id = ++seq
  inflight.set(id, (req.method || 'GET') + ' ' + path)
  const done = (): void => { inflight.delete(id) }
  res.once('finish', done)
  res.once('close', done)
}

/** Record one late tick; exported for the test (the timer calls it with the measured lag). */
export function noteLag(lagMs: number, now = Date.now()): Stall | null {
  if (lagMs < STALL_MS) return null
  const s: Stall = { at: now, lagMs: Math.round(lagMs), inflight: [...new Set(inflight.values())].slice(0, 10) }
  stalls.push(s)
  stalls.sort((a, b) => b.lagMs - a.lagMs)
  if (stalls.length > KEEP) stalls.length = KEEP
  logger.warn({ lagMs: s.lagMs, inflight: s.inflight }, 'event loop stalled (#490): these requests were running')
  void alertSevereStall(s)
  return s
}

/**
 * #823 (C): tell the owner about a long freeze, throttled. Returns true when a message was sent. The sender is
 * injectable for the test; the default is the owner channel (no machine-level scheduler is involved).
 */
export async function alertSevereStall(
  s: Stall,
  send: (text: string) => Promise<unknown> = async (t) => (await import('../notify.js')).sendOwnerChannelChecked(t),
): Promise<boolean> {
  if (s.lagMs < SEVERE_STALL_MS) return false
  if (s.at - lastSevereAlertAt < SEVERE_ALERT_COOLDOWN_MS && lastSevereAlertAt !== 0) return false
  lastSevereAlertAt = s.at
  const what = s.inflight.length ? s.inflight.join(', ') : 'nem futott kerés (időzítő vagy indulási lépés)'
  try {
    await send(`Figyelmeztetés: a dashboard ${(s.lagMs / 1000).toFixed(1)} mp-re lefagyott. Ami futott: ${what}. Részletek: GET /api/perf/stalls.`)
    return true
  } catch (e) {
    logger.warn({ err: String(e) }, 'event loop stall alert could not be sent')
    return false
  }
}

export function recentStalls(): Stall[] {
  return stalls.slice()
}

/** Where the main thread was while it did not answer (newest first). */
export function recentStallSamples(): StallSample[] {
  return samples.slice()
}

/** A sample from the watcher thread arrives once the main thread runs again; exported for the test. */
export function noteStallSample(rec: StallSample): void {
  samples.unshift(rec)
  if (samples.length > KEEP) samples.length = KEEP
  if (rec.noStackYet) {
    logger.warn({ stuckMs: rec.stuckMs, state: rec.state, waitingFor: rec.waitingFor },
      'event loop stalled (#554): the main thread was inside one system call -- this is what the system showed')
    return
  }
  logger.warn({ stuckMs: rec.stuckMs, stack: rec.stack.map((f) => `${f.fn} (${f.file}:${f.line})`) },
    'event loop stalled (#554): the main thread was here')
}

/**
 * How many polls the watcher thread has lived through, or null when there is no watcher thread.
 * It keeps counting while the main thread is blocked and stops when the machine sleeps -- that difference is the
 * whole point: wake-detect.ts uses it to tell "we were stuck" from "the machine was asleep".
 */
export function watcherPolls(): number | null {
  return beat && sampler ? Atomics.load(beat, 1) : null
}

/** The evidence file only ever grows by a few lines per stall; keep the newest part when it gets long. */
export function trimStallSampleFile(file: string, maxBytes = 1_000_000, keepLines = 500): void {
  try {
    if (statSync(file).size <= maxBytes) return
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    writeFileSync(file, lines.slice(-keepLines).join('\n') + '\n')
  } catch { /* no file yet, or not readable: nothing to trim */ }
}

function startStallSampler(): void {
  if (sampler || process.env.MARVEEN_STALL_SAMPLER === '0') return
  trimStallSampleFile(join(STORE_DIR, STALL_SAMPLE_FILE))
  try {
    const sab = new SharedArrayBuffer(8)
    beat = new Int32Array(sab)
    const w = new Worker(STALL_SAMPLER_SOURCE, {
      eval: true,
      workerData: {
        sab, file: join(STORE_DIR, STALL_SAMPLE_FILE), root: PROJECT_ROOT, pollMs: SAMPLER_POLL_MS,
        afterMs: SAMPLE_AFTER_MS, resampleMs: RESAMPLE_MS, max: SAMPLE_MAX, frames: 14, pid: process.pid,
        blindMs: BLIND_AFTER_MS,
      },
    })
    w.unref()
    w.on('message', (rec: StallSample) => {
      // The stuck thread could not say which requests it was holding; it can now.
      rec.inflight = [...new Set(inflight.values())].slice(0, 10)
      if (rec.inflight.length) {
        try { appendFileSync(join(STORE_DIR, STALL_SAMPLE_FILE), JSON.stringify({ at: rec.at, pid: rec.pid, inflight: rec.inflight }) + '\n') } catch { /* evidence only */ }
      }
      noteStallSample(rec)
    })
    const gone = (why: string): void => {
      if (sampler !== w) return
      sampler = null
      logger.warn({ why }, 'event loop watch: the stall sampler thread stopped -- stalls are still counted, without a stack')
    }
    w.on('error', (e) => gone(String(e)))
    w.on('exit', (code) => gone('exit ' + code))
    sampler = w
  } catch (e) {
    sampler = null
    logger.warn({ err: String(e) }, 'event loop watch: the stall sampler thread did not start -- stalls are still counted, without a stack')
  }
}

export function startEventLoopWatch(): void {
  if (timer) return
  startStallSampler()
  let expected = Date.now() + TICK_MS
  timer = setInterval(() => {
    const now = Date.now()
    if (beat) Atomics.add(beat, 0, 1)
    noteLag(now - expected, now)
    expected = now + TICK_MS
  }, TICK_MS)
  timer.unref()
}

export function _resetEventLoopWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (sampler) { const w = sampler; sampler = null; void w.terminate() }
  beat = null
  inflight.clear()
  stalls.length = 0
  samples.length = 0
  lastSevereAlertAt = 0
}
