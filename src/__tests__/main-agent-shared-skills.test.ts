import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The main agent must share the SAME skill library as every sub-agent.
//
// Bug (Boss, 2026-08-25): the main agent's project-level skills dir
// (PROJECT_ROOT/.claude/skills) was a separate real directory, and
// ensureAgentSkills() skipped the main agent outright -- so a skill created by
// the main agent via the dashboard landed there and NO sub-agent could see it,
// and vice versa. "mutasson a kozosre a marveen mappaja is." The fix links the
// main agent at the shared ~/.claude/skills too, guarding only the degenerate
// case where the two paths are literally identical (repo root == home).

const SRC = readFileSync(join(__dirname, '../web/agent-scaffold.ts'), 'utf-8')

describe('ensureAgentSkills links the main agent at the shared library', () => {
  const fn = SRC.slice(
    SRC.indexOf('export function ensureAgentSkills'),
    SRC.indexOf('export function ensureAgentSkills') + 1400,
  )

  it('no longer early-returns for the main agent', () => {
    // The old guard `if (name === MAIN_AGENT_ID) return false` at the top of the
    // function is exactly the limitation Boss hit -- it must be gone.
    expect(fn).not.toMatch(/if\s*\(\s*name\s*===\s*MAIN_AGENT_ID\s*\)\s*return false/)
  })

  it('guards against linking a directory to itself (repo root == home)', () => {
    // Instead of skipping the main agent, it skips only the degenerate self-link
    // case, so the fix stays correct on an install whose repo root is the home
    // directory.
    expect(fn).toMatch(/resolve\(link\)\s*===\s*resolve\(shared\)/)
    expect(fn).toMatch(/return false/)
  })

  it('still links via a symlink to the shared library, not a copy', () => {
    expect(fn).toMatch(/symlinkSync\(shared, link, 'dir'\)/)
  })
})
