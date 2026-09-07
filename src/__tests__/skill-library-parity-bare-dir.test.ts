// skillLibraryParity() must not flag a BARE agent directory (one that holds
// only a CLAUDE.md and has never been scaffolded) as "missing the shared skill
// library".
//
// Why this exists (measured 2026-09-07): listAgentNames() returns every
// directory under agents/, and the rule tests (ask-back, one-card) each seed a
// throwaway agents/zz-* directory that holds only a CLAUDE.md -- created in the
// REAL agents/ base, because agentDir() resolves against the absolute
// PROJECT_ROOT even from a worktree. When such a throwaway existed while a
// parallel test file called skillLibraryParity(), the bare directory was
// counted as an agent missing the shared library, and the agent-parity test
// failed intermittently. A real agent always has a .claude/settings.json; a
// bare directory never does, so the check now skips the unconfigured ones.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentDir } from '../web/agent-config.js'
import { skillLibraryParity } from '../web/skill-library-parity.js'

const BARE = 'zz-parity-bare-probe'

afterEach(() => {
  rmSync(agentDir(BARE), { recursive: true, force: true })
})

describe('skillLibraryParity ignores bare (unconfigured) agent directories', () => {
  it('does not report a CLAUDE.md-only directory as missing the shared library', () => {
    const dir = agentDir(BARE)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), '# bare probe -- not a configured agent\n')

    const p = skillLibraryParity()
    // Only meaningful where the shared library AND the agents/ dir both exist on
    // this checkout (the live install). On a worktree/CI checkout without them
    // the verdict is not_measured and there is nothing to assert.
    if (p.verdict === 'not_measured') return
    expect(p.missing).not.toContain(BARE)
  })
})
