// The mandatory "never work directly in the live tree" rule must reach EVERY
// agent, not just new ones. Boss, 2026-09-12: "sohasem dolgozunk kozvetlenul az
// elo tree ben! claude md be es mindenhova."
//
// The rule exists because on 2026-09-12 a VS Code Claude Code session worked
// directly in the live checkout (committed onto local main + staged 58 files),
// which diverged the tree from origin/main and made scripts/deploy-live.sh
// REFUSE to deploy every tick -- the running app froze silently.
//
// What this test protects (same contract as ask-back-rule.test.ts):
//   1. an existing agent's CLAUDE.md gets the block appended (no manual migration),
//   2. calling it again is a no-op -- no duplicate block, no mtime churn,
//   3. content OUTSIDE the markers is never touched,
//   4. the main agent is skipped (its rule lives in the tracked CLAUDE.md.template),
//   5. zero-writes reports WHY (no-file vs skipped-main vs written vs current),
//   6. the main-agent CLAUDE.md template carries the rule,
//   7. the fleet-wide settings template wires the guard hook.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { ensureNoLiveTreeSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-no-live-tree-probe'

afterEach(() => {
  rmSync(agentDir(THROWAWAY), { recursive: true, force: true })
})

function seed(body: string): string {
  const dir = agentDir(THROWAWAY)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'CLAUDE.md')
  writeFileSync(path, body)
  return path
}

describe('ensureNoLiveTreeSection', () => {
  it('appends the rule to an existing agent CLAUDE.md', () => {
    const path = seed('# zz-no-live-tree-probe\n\nSajat tartalom.\n')
    ensureNoLiveTreeSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('SOHA NE DOLGOZZ KOZVETLENUL AZ ELO TREE-BEN')
    expect(out).toContain('agent-worktree.sh')
    expect(out).toContain('land-pr.sh')
    // The original content survives.
    expect(out).toContain('Sajat tartalom.')
    // Host-agnostic: the generated block names no owner and no agent.
    expect(out).not.toContain('Boss')
    expect(out).not.toContain('/home/')
  })

  it('is idempotent: no duplicate block and no rewrite on the second call', () => {
    const path = seed('# zz-no-live-tree-probe\n\nSajat tartalom.\n')
    ensureNoLiveTreeSection(THROWAWAY)
    const first = readFileSync(path, 'utf-8')
    const mtimeBefore = statSync(path).mtimeMs

    ensureNoLiveTreeSection(THROWAWAY)
    const second = readFileSync(path, 'utf-8')

    expect(second).toEqual(first)
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
    const occurrences = second.split('BEGIN GENERATED: no-live-tree-rule').length - 1
    expect(occurrences).toBe(1)
  })

  it('never touches content outside the markers', () => {
    const path = seed('# fejlec\n\nELSO\n')
    ensureNoLiveTreeSection(THROWAWAY)
    const withBlock = readFileSync(path, 'utf-8')
    writeFileSync(path, withBlock + '\nUTOLSO SOR\n')

    ensureNoLiveTreeSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('ELSO')
    expect(out).toContain('UTOLSO SOR')
  })

  it('does nothing when the agent has no CLAUDE.md (fresh install)', () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    expect(() => ensureNoLiveTreeSection(THROWAWAY)).not.toThrow()
    expect(existsSync(join(agentDir(THROWAWAY), 'CLAUDE.md'))).toBe(false)
  })

  it('skips the main agent (its rule is tracked template text, not a generated block)', () => {
    const repoClaudeMd = join(PROJECT_ROOT, 'CLAUDE.md')
    if (!existsSync(repoClaudeMd)) return
    const before = readFileSync(repoClaudeMd, 'utf-8')
    ensureNoLiveTreeSection(MAIN_AGENT_ID)
    expect(readFileSync(repoClaudeMd, 'utf-8')).toEqual(before)
    expect(before).not.toContain('BEGIN GENERATED: no-live-tree-rule')
  })

  it('reports WHY nothing was written, so zero is never ambiguous', () => {
    expect(ensureNoLiveTreeSection('zz-no-such-agent-at-all')).toBe('no-file')
    expect(ensureNoLiveTreeSection(MAIN_AGENT_ID)).toBe('skipped-main')

    seed('# zz-no-live-tree-probe\n\nSajat tartalom.\n')
    expect(ensureNoLiveTreeSection(THROWAWAY)).toBe('written')
    expect(ensureNoLiveTreeSection(THROWAWAY)).toBe('current')
  })
})

describe('the rule reaches fresh installs and the whole fleet', () => {
  it('the main-agent CLAUDE.md template carries the rule', () => {
    const text = readFileSync(join(PROJECT_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(text).toContain('SOHA NE DOLGOZZ KÖZVETLENÜL AZ ÉLŐ TREE-BEN')
    expect(text).toContain('no-live-tree-commit')
  })

  it('the fleet-wide settings template wires the guard hook', () => {
    const text = readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8')
    expect(text).toContain('no-live-tree-commit.py')
  })
})
