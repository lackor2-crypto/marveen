// Owner's law (2026-11-23): when asked to MOVE a file, never delete anything; stop and tell on a name clash.
// The rule reaches every agent (own CLAUDE.md block, machine-wide block, per-message hook, template, learned rule R43)
// and the code sessions (task preamble, verification prompt, code-bridge prompt).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildNoDeleteOnMoveBody, ensureNoDeleteOnMoveSection } from '../web/agent-scaffold.js'
import { NO_DELETE_ON_MOVE_DISPATCH_EN, NO_DELETE_ON_MOVE_DISPATCH_HU } from '../no-delete-on-move-rule.js'

const THROWAWAY = 'zz-no-delete-on-move-probe'
const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), 'utf-8')
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('no-delete-on-move rule', () => {
  it('forbids deleting the source and says to stop on a clash; no owner name or path', () => {
    const b = buildNoDeleteOnMoveBody()
    expect(b).toContain('ATHELYEZESKOR SOHA NEM TOROLSZ')
    expect(b).toContain('ALLJ MEG')
    expect(b).toContain('cp --update=none')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('is appended once, idempotently; skips the main agent and agents without CLAUDE.md', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    expect(ensureNoDeleteOnMoveSection(THROWAWAY)).toBe('no-file')
    writeFileSync(path, '# probe\n\nSajat.\n')
    expect(ensureNoDeleteOnMoveSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(once).toContain('Sajat.')
    expect(once).toContain('no-delete-on-move-rule')
    expect(ensureNoDeleteOnMoveSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(ensureNoDeleteOnMoveSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })
  it('reaches the code sessions in both languages', () => {
    expect(NO_DELETE_ON_MOVE_DISPATCH_HU).toContain('SOHA NEM TOROLSZ')
    expect(NO_DELETE_ON_MOVE_DISPATCH_EN).toContain('NEVER DELETE WHEN ASKED TO MOVE')
    expect(read('src/web/code-task-preamble.ts')).toContain('NO_DELETE_ON_MOVE_DISPATCH_HU')
    expect(read('src/web/code-task-preamble.ts')).toContain('NO_DELETE_ON_MOVE_DISPATCH_EN')
    expect(read('src/approval-verification-dispatch.ts')).toContain('NO_DELETE_ON_MOVE_DISPATCH_HU')
    expect(read('src/workbench-agent/code-bridge-turn.ts')).toContain('NO_DELETE_ON_MOVE_DISPATCH_EN')
  })
  it('is in the startup hooks, the digest table, the template and the learned rules', () => {
    expect(read('scripts/hooks/fresh-install-rule.py')).toContain('ATHELYEZESKOR SOHA NEM TOROLSZ')
    expect(read('src/web/rule-digests.ts')).toContain("'no-delete-on-move'")
    const web = read('src/web.ts')
    expect(web).toContain('ensureNoDeleteOnMoveSection(agentName)')
    expect(web).toContain('ensureGlobalNoDeleteOnMoveRule()')
    expect(read('src/web/agent-process.ts')).toContain('ensureNoDeleteOnMoveSection(name)')
    expect(read('templates/CLAUDE.md.template')).toContain('ensureNoDeleteOnMoveSection')
    expect(read('seed-skills/marveen-learned-rules/SKILL.md')).toContain('### R43')
  })
})
