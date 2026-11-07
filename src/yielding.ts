// #835: long synchronous passes (statSync/readFileSync per work item) held the event loop for seconds and froze the
// dashboard (measured 3.1 s and 5.2 s in /api/perf/stalls). Such a pass is written as a generator that yields between
// items; the sync wrapper drains it at once (same behaviour as before), the async one gives the loop back every few ms.

import { readdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'

// #872 (Boss TG 5301, 5.2 s freeze): yielding BETWEEN folder reads does not help when ONE read blocks for seconds (a cold
// folder on the Windows drive). A generator that reads a folder asks for it with `yield { readdir }`: the sync drain answers
// with readdirSync (same behaviour as before), the yielding drain with the async readdir, so the loop stays free DURING the read.
export interface DirRead { readdir: string }
export type DirEntries = Dirent[] | null | void
export type Steps<T> = Generator<void | DirRead, T, DirEntries>

const readNow = (dir: string): Dirent[] | null => { try { return readdirSync(dir, { withFileTypes: true }) } catch { return null } }
const readLater = async (dir: string): Promise<Dirent[] | null> => { try { return await readdir(dir, { withFileTypes: true }) } catch { return null } }

/** Drain a stepping generator synchronously and return its result. */
export function drainSteps<T>(it: Generator<void | DirRead, T, DirEntries>): T {
  let answer: DirEntries = undefined
  for (;;) {
    const r = it.next(answer)
    if (r.done) return r.value
    answer = r.value ? readNow(r.value.readdir) : undefined
  }
}

/** Drain a stepping generator, letting other work run whenever it has held the loop for more than `sliceMs`. */
export async function drainStepsYielding<T>(it: Generator<void | DirRead, T, DirEntries>, sliceMs = 8): Promise<T> {
  let slice = Date.now()
  let answer: DirEntries = undefined
  for (;;) {
    const r = it.next(answer)
    if (r.done) return r.value
    answer = undefined
    if (r.value) { answer = await readLater(r.value.readdir); slice = Date.now(); continue }
    if (Date.now() - slice > sliceMs) { await new Promise<void>((res) => setImmediate(res)); slice = Date.now() }
  }
}
