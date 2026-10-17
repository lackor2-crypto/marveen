// Per-run scratch TMPDIR for the whole vitest run (card #683).
//
// Why: measured 2026-10-17 on the dev machine, /tmp held 37258 entries and ~95% of
// them were mkdtemp leftovers of the unit tests (marveen-deploy-* 17775,
// marveen-bigfolder-* 7234, voice-*-* 6854, ...): hundreds of tests create a temp
// directory and never remove it. Fixing every test one by one does not hold, the
// next test brings the leak back. So the run gets ONE directory, os.tmpdir() (which
// reads TMPDIR when it is called) points into it for every worker, and the teardown
// removes the whole directory, whatever the tests left behind.
//
// A crashed run leaves its directory behind: its name starts with
// `marveen-vitest-run-`, which scripts/tmp-sweep.py removes after the idle days.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let runDir = ''
let previous: string | undefined

export default function setup(): () => void {
  previous = process.env.TMPDIR
  try {
    runDir = mkdtempSync(join(tmpdir(), 'marveen-vitest-run-'))
    process.env.TMPDIR = runDir
  } catch {
    runDir = '' // no scratch dir: tests keep using the normal temp dir
  }
  return () => {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    if (runDir) rmSync(runDir, { recursive: true, force: true })
  }
}
