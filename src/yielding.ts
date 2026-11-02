// #835: long synchronous passes (statSync/readFileSync per work item) held the event loop for seconds and froze the
// dashboard (measured 3.1 s and 5.2 s in /api/perf/stalls). Such a pass is written as a generator that yields between
// items; the sync wrapper drains it at once (same behaviour as before), the async one gives the loop back every few ms.

/** Drain a stepping generator synchronously and return its result. */
export function drainSteps<T>(it: Generator<void, T, void>): T {
  for (;;) { const r = it.next(); if (r.done) return r.value }
}

/** Drain a stepping generator, letting other work run whenever it has held the loop for more than `sliceMs`. */
export async function drainStepsYielding<T>(it: Generator<void, T, void>, sliceMs = 8): Promise<T> {
  let slice = Date.now()
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
    if (Date.now() - slice > sliceMs) { await new Promise<void>((res) => setImmediate(res)); slice = Date.now() }
  }
}
