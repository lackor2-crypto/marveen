// #835: long synchronous passes (statSync/readFileSync per work item) held the event loop for seconds and froze the
// dashboard (measured 3.1 s and 5.2 s in /api/perf/stalls). Such a pass is written as a generator that yields between
// items; the sync wrapper drains it at once (same behaviour as before), the async one gives the loop back every few ms.

import { readdirSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { join } from 'node:path'

// #872 (Boss TG 5301, 5.2 s freeze): yielding BETWEEN folder reads does not help when ONE read blocks for seconds (a cold
// folder on the Windows drive). A generator that reads a folder asks for it with `yield { readdir }`: the sync drain answers
// with readdirSync (same behaviour as before), the yielding drain with the async readdir, so the loop stays free DURING the read.
export interface DirRead { readdir: string }
// Per-file stats of one folder in ONE step: on a slow drive (the depot on a 9p mount costs ~7 ms per fs call) a serial
// statSync per file took seconds; the yielding drain runs them concurrently and the answer lands in `into` (null = gone).
export interface StatRead { stat: string[]; into: Map<string, Stats | null> }
export type Step = void | DirRead | StatRead
export type DirEntries = Dirent[] | null | void
export type Steps<T> = Generator<Step, T, DirEntries>

const readNow = (dir: string): Dirent[] | null => { try { return readdirSync(dir, { withFileTypes: true }) } catch { return null } }
const readLater = async (dir: string): Promise<Dirent[] | null> => { try { return await readdir(dir, { withFileTypes: true }) } catch { return null } }
const statNow = (p: string): Stats | null => { try { return statSync(p) } catch { return null } }
const statLater = async (p: string): Promise<Stats | null> => { try { return await stat(p) } catch { return null } }

// At most this many fs calls in flight at once: enough to hide a slow drive's latency, few enough not to flood the pool.
const FS_CONCURRENCY = 32
let inFlight = 0
const waiting: Array<() => void> = []
async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (inFlight >= FS_CONCURRENCY) await new Promise<void>((res) => waiting.push(res))
  inFlight++
  try { return await job() } finally { inFlight--; waiting.shift()?.() }
}

/** Drain a stepping generator synchronously and return its result. */
export function drainSteps<T>(it: Generator<Step, T, DirEntries>): T {
  let answer: DirEntries = undefined
  for (;;) {
    const r = it.next(answer)
    if (r.done) return r.value
    answer = undefined
    const v = r.value
    if (!v) continue
    if ('readdir' in v) answer = readNow(v.readdir)
    else for (const p of v.stat) v.into.set(p, statNow(p))
  }
}

/** Drain a stepping generator, letting other work run whenever it has held the loop for more than `sliceMs`. */
export async function drainStepsYielding<T>(it: Generator<Step, T, DirEntries>, sliceMs = 8): Promise<T> {
  let slice = Date.now()
  let answer: DirEntries = undefined
  // Folders read ahead: when a folder's listing arrives, its sub-folders are already being read, so the walk finds
  // them done instead of paying the drive's latency one folder after the other.
  const ahead = new Map<string, Promise<Dirent[] | null>>()
  const read = (dir: string): Promise<Dirent[] | null> => {
    const early = ahead.get(dir)
    if (early) { ahead.delete(dir); return early }
    return limited(() => readLater(dir))
  }
  for (;;) {
    const r = it.next(answer)
    if (r.done) return r.value
    answer = undefined
    const v = r.value
    if (v) {
      if ('readdir' in v) {
        answer = await read(v.readdir)
        if (answer) for (const d of answer) {
          if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') {
            const child = join(v.readdir, d.name)
            if (!ahead.has(child)) ahead.set(child, limited(() => readLater(child)))
          }
        }
      } else {
        const got = await Promise.all(v.stat.map((p) => limited(() => statLater(p))))
        v.stat.forEach((p, i) => v.into.set(p, got[i]))
      }
      slice = Date.now()
      continue
    }
    if (Date.now() - slice > sliceMs) { await new Promise<void>((res) => setImmediate(res)); slice = Date.now() }
  }
}
