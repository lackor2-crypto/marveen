// The mandatory "a finished card goes to 'waiting' immediately" rule must reach
// EVERY agent, not just new ones. 2026-09-19: finished work got stuck in
// in_progress six separate times because the agent forgot to move the card
// forward, so the owner could not see it was done and could not approve it.
//
// What this test protects (same contract as completion-report-rule.test.ts):
//   1. an existing agent's CLAUDE.md gets the block appended (no manual migration),
//   2. calling it again is a no-op -- no duplicate block, no mtime churn,
//   3. content OUTSIDE the markers is never touched,
//   4. a fresh install with no CLAUDE.md is left untouched (covered machine-wide),
//   5. the main agent is skipped (its rule lives in the tracked template),
//   6. zero-writes reports WHY (no-file vs skipped-main vs written vs current),
//   7. the main-agent CLAUDE.md template carries the rule.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { ensureKanbanWaitingMoveSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-kanban-waiting-move-probe'

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

describe('ensureKanbanWaitingMoveSection', () => {
  it('appends the rule to an existing agent CLAUDE.md', () => {
    const path = seed('# zz-kanban-waiting-move-probe\n\nSajat tartalom.\n')
    ensureKanbanWaitingMoveSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('KESZ KARTYA AZONNAL A VARAKOZOBA')
    expect(out).toContain('hazugsag a tablan')
    // The original content survives.
    expect(out).toContain('Sajat tartalom.')
    // Host-agnostic: the generated block names no owner and no path.
    expect(out).not.toContain('Boss')
    expect(out).not.toContain('/home/')
  })

  it('is idempotent: no duplicate block and no rewrite on the second call', () => {
    const path = seed('# zz-kanban-waiting-move-probe\n\nSajat tartalom.\n')
    ensureKanbanWaitingMoveSection(THROWAWAY)
    const first = readFileSync(path, 'utf-8')
    const mtimeBefore = statSync(path).mtimeMs

    ensureKanbanWaitingMoveSection(THROWAWAY)
    const second = readFileSync(path, 'utf-8')

    expect(second).toEqual(first)
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
    const occurrences = second.split('BEGIN GENERATED: kanban-waiting-move-rule').length - 1
    expect(occurrences).toBe(1)
  })

  it('never touches content outside the markers', () => {
    const path = seed('# fejlec\n\nELSO\n')
    ensureKanbanWaitingMoveSection(THROWAWAY)
    const withBlock = readFileSync(path, 'utf-8')
    writeFileSync(path, withBlock + '\nUTOLSO SOR\n')

    ensureKanbanWaitingMoveSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('ELSO')
    expect(out).toContain('UTOLSO SOR')
  })

  it('does nothing when the agent has no CLAUDE.md (fresh install)', () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    expect(() => ensureKanbanWaitingMoveSection(THROWAWAY)).not.toThrow()
    expect(existsSync(join(agentDir(THROWAWAY), 'CLAUDE.md'))).toBe(false)
  })

  it('skips the main agent (its rule is tracked template text, not a generated block)', () => {
    const repoClaudeMd = join(PROJECT_ROOT, 'CLAUDE.md')
    if (!existsSync(repoClaudeMd)) return
    const before = readFileSync(repoClaudeMd, 'utf-8')
    ensureKanbanWaitingMoveSection(MAIN_AGENT_ID)
    expect(readFileSync(repoClaudeMd, 'utf-8')).toEqual(before)
    expect(before).not.toContain('BEGIN GENERATED: kanban-waiting-move-rule')
  })

  it('reports WHY nothing was written, so zero is never ambiguous', () => {
    expect(ensureKanbanWaitingMoveSection('zz-no-such-agent-at-all')).toBe('no-file')
    expect(ensureKanbanWaitingMoveSection(MAIN_AGENT_ID)).toBe('skipped-main')

    seed('# zz-kanban-waiting-move-probe\n\nSajat tartalom.\n')
    expect(ensureKanbanWaitingMoveSection(THROWAWAY)).toBe('written')
    expect(ensureKanbanWaitingMoveSection(THROWAWAY)).toBe('current')
  })
})

describe('the rule reaches fresh installs and the whole fleet', () => {
  it('the main-agent CLAUDE.md template carries the rule', () => {
    const text = readFileSync(join(PROJECT_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(text).toContain('KÉSZ KÁRTYA AZONNAL A VÁRAKOZÓBA')
    expect(text).toContain('ensureKanbanWaitingMoveSection')
  })
})
