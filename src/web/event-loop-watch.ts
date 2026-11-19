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
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { ol } from '../owner-lang.js'
import { busyReasons, currentPressure, describePressure, noteStallForPressure, startPressureWatch, type PressureSnapshot } from '../machine-pressure.js'

export const TICK_MS = 100
export const STALL_MS = 300
const KEEP = 30
/** #823 (C): a stall this long is told to the owner on the channel (after the fact: a frozen process cannot send). */
export const SEVERE_STALL_MS = 3000
/** At most one such message per this long, so a bad hour is one message, not a flood. */
export const SEVERE_ALERT_COOLDOWN_MS = 30 * 60 * 1000
let lastSevereAlertAt = 0

export type Stall = { at: number; lagMs: number; inflight: string[]; pressure?: PressureSnapshot | null; busy?: string[]; gcMs?: number }

/** How often the watcher thread looks at the main thread's heartbeat. */
export const SAMPLER_POLL_MS = 250
/** The main thread must be silent this long before its stack is sampled (0.5 s, #893: after the realpath fix the remaining 1.1-1.2 s stalls of 2026-11-09 left no stack at the old 1.2 s; the 2.2-2.8 s stalls of 2026-11-06 had left none at 3 s). */
export const SAMPLE_AFTER_MS = 500
/** No answer from the main thread this long after asking: write what the operating system shows meanwhile. */
export const BLIND_AFTER_MS = 10_000
/** #929: after this long without a tick the watcher writes what the operating system shows (once per stall). */
export const OS_SNAPSHOT_MS = 1500
/** A stall that goes on is sampled again this often, at most SAMPLE_MAX times. */
export const RESAMPLE_MS = 30_000
export const SAMPLE_MAX = 14
/** #935: the first SAMPLE_BURST samples of one stall are taken back to back (one per poll), not RESAMPLE_MS apart: one stack
 *  is a single frame of a film, and a stall made of many short synchronous calls names a random one of them. A burst gives a
 *  distribution, and the summary record (kind 'summary') names the code that held the thread most often. */
export const SAMPLE_BURST = 8
export const STALL_SAMPLE_FILE = 'event-loop-stalls.jsonl'

export type StackFrame = { fn: string; file: string; line: number }
/** #935: one line of a summary: where the stuck thread was, and in how many of the stall's samples. */
export type StallWhere = { where: string; n: number }
/** One look at the blocked main thread. `inflight` is what the stuck thread could not tell: filled in afterwards. */
export type StallSample = {
  at: number; stuckMs: number; pid: number; stack: StackFrame[]; inflight?: string[]
  /** Set while the thread is still inside one system call: no stack yet, only what the OS shows (Linux). */
  noStackYet?: boolean; state?: string; waitingFor?: string[]
  /** #929: 'os' = what the operating system showed while the main thread stood still (no stack in it). */
  kind?: 'os' | 'summary'; wchan?: string; cpuTicksDuring?: number | null; load?: string
  psi?: Record<string, string[] | null>; vmDelta?: Record<string, number>; vmDeltaOverMs?: number
  hot?: Array<{ pid: number; state: string; cmd: string }>
  /** #935 (kind 'summary', written when the stall is over): how many stacks were taken, and the code seen most often --
   *  `ours` = the innermost frame that is not inside node itself (our code or a dependency), `top` = the innermost frame of all. */
  samples?: number; ours?: StallWhere[]; top?: StallWhere[]
}

/**
 * The watcher thread, as source text: it runs under tsx and from dist alike, with no second file to ship.
 * beat[0] is the main thread's tick counter, beat[1] its own (how long it has been watching, in polls).
 */
export const STALL_SAMPLER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads')
const inspector = require('node:inspector')
const fs = require('node:fs')
const { sab, file, root, pollMs, afterMs, resampleMs, max, frames, pid, blindMs, osMs, burst } = workerData
const beat = new Int32Array(sab)
let last = Atomics.load(beat, 0), stuckSince = 0, taken = 0, nextAt = 0, busy = false, prevTick = performance.now()
let askedAt = 0, blindTaken = 0, blindNextAt = 0
// #935: every stack taken during the CURRENT stall; summarised (and cleared) when the main thread ticks again.
let stallStacks = []
const label = (f) => f.fn + ' (' + f.file + ':' + f.line + ')'
function tally(keys) {
  const m = new Map()
  for (const k of keys) m.set(k, (m.get(k) || 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([where, n]) => ({ where, n }))
}
function summarise(now) {
  const stacks = stallStacks
  stallStacks = []
  if (!stacks.length) return
  try {
    const innerOurs = (st) => st.find((f) => f.file && !f.file.startsWith('node:'))
    const rec = {
      kind: 'summary', at: Date.now(), stuckMs: Math.round(now - stuckSince), pid, stack: [], samples: stacks.length,
      ours: tally(stacks.map(innerOurs).filter(Boolean).map(label)),
      top: tally(stacks.filter((st) => st.length).map((st) => label(st[0]))),
    }
    fs.appendFileSync(file, JSON.stringify(rec) + '\\n')
    try { parentPort.postMessage(rec) } catch {}
  } catch {}
}
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
    const rec = { at: Date.now(), stuckMs: now - stuckSince, pid, stack: [], noStackYet: true, state, waitingFor }
    fs.appendFileSync(file, JSON.stringify(rec) + '\\n')
    try { parentPort.postMessage(rec) } catch {}
  } catch {}
  blindTaken++; blindNextAt = now + resampleMs
}
// #929: what did the OPERATING SYSTEM see while the main thread stood still? The stack is only taken when the call
// returns (it names a trivial function), so say it from here: did the thread burn CPU or wait (state D, and for what:
// wchan p9_client_rpc = a call to the Windows host over a /mnt drive), how loaded was the machine, who else was in
// disk wait or running. Linux only; elsewhere every read fails quietly and nothing is written.
let osTaken = false, cpuAtStart = -1, vmBase = null, vmBaseAt = 0
function readTicks() {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/task/' + pid + '/stat', 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(f[11]) + Number(f[12])
  } catch { return -1 }
}
function readVm() {
  try {
    const want = { pgmajfault: 1, pswpin: 1, pswpout: 1, allocstall_normal: 1, allocstall_movable: 1, pgscan_direct: 1 }
    const out = {}
    for (const l of fs.readFileSync('/proc/vmstat', 'utf8').split('\\n')) {
      const p = l.split(' ')
      if (want[p[0]]) out[p[0]] = Number(p[1])
    }
    return out
  } catch { return null }
}
function psi(name) {
  try { return fs.readFileSync('/proc/pressure/' + name, 'utf8').trim().split('\\n') } catch { return null }
}
function hotProcs() {
  const out = []
  try {
    for (const d of fs.readdirSync('/proc')) {
      const c = d.charCodeAt(0)
      if (c < 48 || c > 57 || Number(d) === pid) continue
      try {
        const s = fs.readFileSync('/proc/' + d + '/stat', 'utf8')
        const st = s.slice(s.lastIndexOf(')') + 2).split(' ')
        if (st[0] !== 'D' && st[0] !== 'R') continue
        let cmd = ''
        try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8').split('\\0').filter(Boolean).slice(0, 3).join(' ').slice(0, 100) } catch {}
        out.push({ pid: Number(d), state: st[0], cmd: cmd || s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')) })
      } catch {}
      if (out.length >= 12) break
    }
  } catch {}
  return out
}
function osSnapshot(now) {
  osTaken = true
  try {
    const rec = { kind: 'os', at: Date.now(), stuckMs: now - stuckSince, pid, stack: [] }
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/task/' + pid + '/stat', 'utf8')
      rec.state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    } catch {}
    try { rec.wchan = fs.readFileSync('/proc/' + pid + '/task/' + pid + '/wchan', 'utf8').trim() } catch {}
    const t = readTicks()
    rec.cpuTicksDuring = t >= 0 && cpuAtStart >= 0 ? t - cpuAtStart : null
    try { rec.load = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 4).join(' ') } catch {}
    rec.psi = { cpu: psi('cpu'), io: psi('io'), memory: psi('memory') }
    const vm = readVm()
    if (vm && vmBase) {
      rec.vmDelta = {}
      for (const k of Object.keys(vm)) rec.vmDelta[k] = vm[k] - (vmBase[k] || 0)
      rec.vmDeltaOverMs = Math.round(now - vmBaseAt)
    }
    rec.hot = hotProcs()
    fs.appendFileSync(file, JSON.stringify(rec) + '\\n')
    try { parentPort.postMessage(rec) } catch {}
  } catch {}
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
      const now = performance.now()
      const stack = (m.params.callFrames || []).slice(0, frames).map((f) => ({
        fn: f.functionName || '(anonymous)', file: short(f.url || urls.get(f.location && f.location.scriptId)), line: (f.location ? f.location.lineNumber : 0) + 1,
      }))
      const rec = { at: Date.now(), stuckMs: now - since, pid, stack }
      try { fs.appendFileSync(file, JSON.stringify(rec) + '\\n') } catch {}
      try { parentPort.postMessage(rec) } catch {}
      stallStacks.push(stack)
      taken++; nextAt = taken < (burst || 0) ? 0 : now + resampleMs
      end()
    })
    // Not chained on callbacks: a blocked main thread answers nothing until it returns to JavaScript.
    session.post('Debugger.enable')
    session.post('Debugger.pause')
    askedAt = performance.now()
    abandon = end
  } catch { end() }
}
setInterval(() => {
  const now = performance.now()
  const ownGap = now - prevTick
  prevTick = now
  Atomics.add(beat, 1, 1)
  const cur = Atomics.load(beat, 0)
  // This thread did not run either (the machine slept, or the whole process was stopped): no evidence of a stall.
  if (ownGap > pollMs * 5) { last = cur; stuckSince = 0; taken = 0; osTaken = false; stallStacks = []; return }
  if (cur !== last) {
    // The main thread runs again, yet the pause we asked for a minute ago never arrived: give that session up,
    // or this thread would wait for it forever and never sample again.
    if (busy && abandon && now - askedAt > 60000) abandon()
    if (stuckSince) summarise(now)
    last = cur; stuckSince = 0; taken = 0; nextAt = 0; blindTaken = 0; blindNextAt = 0; osTaken = false
    // Healthy: remember the thread's CPU time and the kernel counters, so a stall can say what changed during it.
    cpuAtStart = readTicks()
    if (now - vmBaseAt > 5000) { vmBase = readVm(); vmBaseAt = now }
    return
  }
  if (!stuckSince) stuckSince = now - pollMs
  if (!osTaken && osMs && now - stuckSince >= osMs) osSnapshot(now)
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
  // #897: what the MACHINE was doing. A freeze on a calm machine is our code; a freeze while tasks were queuing for
  // the CPU, the disk or memory is the machine being short of it. Measured, so nobody has to guess afterwards.
  const pressure = currentPressure(now)
  const gcMs = longestGcSince(now - Math.round(lagMs) - 1000)
  const s: Stall = { at: now, lagMs: Math.round(lagMs), inflight: [...new Set(inflight.values())].slice(0, 10), pressure, busy: busyReasons(pressure), gcMs }
  noteStallForPressure(lagMs, now)
  stalls.push(s)
  stalls.sort((a, b) => b.lagMs - a.lagMs)
  if (stalls.length > KEEP) stalls.length = KEEP
  logger.warn({ lagMs: s.lagMs, inflight: s.inflight, pressure: s.pressure, busy: s.busy, gcMs: s.gcMs }, 'event loop stalled (#490): these requests were running')
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
  const what = s.inflight.length ? s.inflight.join(', ') : ol('nem futott kérés (időzítő vagy indulási lépés)', 'no request was running (a timer or a start-up step)')
  try {
    const secs = (s.lagMs / 1000).toFixed(1)
    const busy = s.busy ?? []
    const machineHu = busy.length
      ? `A gép ekkor terhelt volt (${describePressure(s.pressure ?? null, 'hu')}), a háttérmunkák ilyenkor várnak.`
      : `A gép ekkor: ${describePressure(s.pressure ?? null, 'hu')}.`
    const machineEn = busy.length
      ? `The machine was busy then (${describePressure(s.pressure ?? null, 'en')}); background work waits at such times.`
      : `The machine then: ${describePressure(s.pressure ?? null, 'en')}.`
    const gcHu = s.gcMs && s.gcMs >= 200 ? ` Ebből memória-takarítás: ${(s.gcMs / 1000).toFixed(1)} mp.` : ''
    const gcEn = s.gcMs && s.gcMs >= 200 ? ` Of this, memory clean-up: ${(s.gcMs / 1000).toFixed(1)} s.` : ''
    await send(ol(
      `Figyelmeztetés: a dashboard ${secs} mp-re lefagyott. Ami futott: ${what}. ${machineHu}${gcHu} Részletek: GET /api/perf/stalls.`,
      `Warning: the dashboard froze for ${secs} s. What was running: ${what}. ${machineEn}${gcEn} Details: GET /api/perf/stalls.`,
    ))
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
  if (rec.kind === 'summary') {
    logger.warn({ stuckMs: rec.stuckMs, samples: rec.samples, ours: rec.ours, top: rec.top },
      'event loop stalled (#935): summary -- the code that held the main thread most often during this stall')
    return
  }
  if (rec.kind === 'os') {
    logger.warn({ stuckMs: Math.round(rec.stuckMs), state: rec.state, wchan: rec.wchan, cpuTicksDuring: rec.cpuTicksDuring, load: rec.load, psi: rec.psi, vmDelta: rec.vmDelta, hot: rec.hot },
      'event loop stalled (#929): what the operating system showed while the main thread stood still')
    return
  }
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
        blindMs: BLIND_AFTER_MS, osMs: OS_SNAPSHOT_MS, burst: SAMPLE_BURST,
      },
    })
    w.unref()
    w.on('message', (rec: StallSample) => {
      // The stuck thread could not say which requests it was holding; it can now.
      if (rec.kind !== 'summary') rec.inflight = [...new Set(inflight.values())].slice(0, 10)
      if (rec.inflight?.length) {
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
  startPressureWatch()
  startGcWatch()
  // The lag is the gap on the MONOTONIC clock. The wall clock (Date.now) can be stepped forward by the system: on this
  // WSL machine it jumped ~2.1 s every ~34.5 s while the monotonic clock ran on, which was counted as a 2.1 s freeze
  // (and told to the owner) with nothing blocked (#865). Date.now() stays only as the timestamp of the record.
  let expected = performance.now() + TICK_MS
  timer = setInterval(() => {
    const mono = performance.now()
    if (beat) Atomics.add(beat, 0, 1)
    noteLag(mono - expected, Date.now())
    expected = mono + TICK_MS
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
  if (gcObserver) { try { gcObserver.disconnect() } catch { /* already off */ } gcObserver = null }
  gcPauses.length = 0
}

// #897: the longest garbage-collection pause near a stall. Many measured freezes sat on trivial code; whether the
// runtime's own memory clean-up was the holder is now a number in the record instead of a guess.
const gcPauses: Array<{ at: number; ms: number }> = []
let gcObserver: PerformanceObserver | null = null

function startGcWatch(): void {
  if (gcObserver) return
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 50) continue
        gcPauses.push({ at: Date.now(), ms: Math.round(e.duration) })
        if (gcPauses.length > 50) gcPauses.shift()
      }
    })
    gcObserver.observe({ entryTypes: ['gc'] })
  } catch { gcObserver = null }
}

/** Exported for the test. */
export function noteGcPause(ms: number, at = Date.now()): void {
  gcPauses.push({ at, ms })
}

export function longestGcSince(since: number): number {
  let max = 0
  for (const p of gcPauses) if (p.at >= since && p.ms > max) max = p.ms
  return max
}
