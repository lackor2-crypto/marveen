// Removing a scratch directory that a REAL LibreOffice has just used.
//
// WHY (#456, measured on the main CI run of 2026-10-01): the test body was
// green, then the teardown failed with
//   ENOTEMPTY: directory not empty, rmdir '.../render-cache/lo-profile/user/pack'
// Something was still writing into the LibreOffice profile while the recursive
// delete walked it, so a file appeared between "children removed" and "rmdir".
// The conversion itself had already reported done -- the writer is outside the
// test's control, so the only honest fix is to wait for it and try again.
//
// `rmSync(..., { maxRetries, retryDelay })` is NOT used on purpose: measured on
// Node 22.23 it still threw ENOTEMPTY 5 times out of 5 against a writer that
// stopped after 700 ms (maxRetries: 10, retryDelay: 100). The explicit loop
// below cleaned up 10 times out of 10 in the same race.
import { rmSync } from 'node:fs'

const RETRYABLE = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM'])

/** Recursive, forced delete that waits out a concurrent writer. A failure that
 *  outlives the retries is still thrown -- a leftover directory is not hidden. */
export function rmTempDir(dir: string, opts: { tries?: number; delayMs?: number } = {}): void {
  const tries = opts.tries ?? 50
  const delayMs = opts.delayMs ?? 100
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!code || !RETRYABLE.has(code) || attempt >= tries) throw e
      // Teardown hooks here are synchronous; the writer is another process, so
      // blocking this thread does not hold it up.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
    }
  }
}
