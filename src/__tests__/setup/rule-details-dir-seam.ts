// GLOBAL SUITE SEAM: no test may read or write the operator's REAL
// ~/.claude/rule-details (#868 follow-up of #799).
//
// Since #799 every generated rule block writes its full text to
// ruleDetailsDir(), and ensureAutonomySection() writes autonomy-<agent>.md
// there too. The suite called those with the real HOME, so a full run on the
// operator's box (a) littered the live directory with autonomy-agent-a.md,
// autonomy-new-agent.md ... and (b) made withDetails() (which concatenates EVERY
// file of the directory) pull the operator's hand-written rule files into the
// "text is machine independent" assertions -> 8 files red locally, green on CI
// (where the directory does not exist). Measured 2026-11-16.
//
// Same shape as default-ssh-dir-seam.ts: a bounded per-worker scratch directory,
// cleared on ENTRY (the exit hook does not fire in vitest's isolated workers),
// and an already-set MARVEEN_RULE_DETAILS_DIR is respected.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.MARVEEN_RULE_DETAILS_DIR) {
  const slot = (process.env.VITEST_POOL_ID || String(process.pid)).replace(/[^A-Za-z0-9_-]/g, '_')
  const seamDir = join(tmpdir(), 'marveen-rule-details-seam', `w${slot}`)
  rmSync(seamDir, { recursive: true, force: true })
  mkdirSync(seamDir, { recursive: true })
  process.env.MARVEEN_RULE_DETAILS_DIR = seamDir
}
