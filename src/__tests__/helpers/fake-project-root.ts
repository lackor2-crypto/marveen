// Shared helper for tests that exercise agent-scaffold.ts's hook injectors
// (injectEgressGate and the ensure*/upgrade* functions built on them). Those
// all build their hook
// `command` string from the real PROJECT_ROOT export in ../config.js, then
// isUnsafeHookCommand() rejects it if that path contains a /tmp-like prefix
// -- correctly, that guard exists specifically to keep a transient checkout
// out of shared settings.json (2026-07-14 fleet-freeze incident).
//
// Run this project's own mandated way (from a git worktree, see
// assert-not-live-install.ts), the checkout itself lives under /tmp, so the
// REAL PROJECT_ROOT trips that same guard for every one of these tests. This
// helper points PROJECT_ROOT at a real, non-tmp mirror instead (under the
// tester's home directory, never /tmp on any real machine -- the same class
// of location, ~/.claude/..., the actual runtime already writes to) so the
// guard's tmp-prefix check has something genuinely safe to approve while its
// file-existence check stays real. See marveen-test-suite-triage skill /
// kanban #b33afe71 for the full writeup.
//
// Usage, at the top of a test file, BEFORE importing anything from
// agent-scaffold.js (vi.mock calls are hoisted above other imports by
// vitest, so this ordering happens automatically as long as the vi.mock call
// itself is written before those imports):
//
//   vi.mock('../config.js', async (importOriginal) => {
//     const { buildFakeProjectRootConfig } = await import('./helpers/fake-project-root.js')
//     return buildFakeProjectRootConfig(await importOriginal())
//   })
import { mkdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FAKE_ROOT = join(homedir(), '.marveen-test-fixtures-project-root')

// The hook scripts these injectors reference, relative to PROJECT_ROOT --
// keep in sync with the join(PROJECT_ROOT, ...) calls in agent-scaffold.ts.
const MIRRORED_SCRIPTS = [
  ['scripts', 'hooks', 'egress-gate.mjs'],
]

export function buildFakeProjectRootConfig(actual: Record<string, unknown>): Record<string, unknown> {
  const realRoot = actual.PROJECT_ROOT as string
  for (const parts of MIRRORED_SCRIPTS) {
    const dest = join(FAKE_ROOT, ...parts)
    mkdirSync(join(dest, '..'), { recursive: true })
    copyFileSync(join(realRoot, ...parts), dest)
  }
  return { ...actual, PROJECT_ROOT: FAKE_ROOT }
}
