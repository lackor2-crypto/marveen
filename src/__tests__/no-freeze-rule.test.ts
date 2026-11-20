// Kanban #950 (owner, TG 7046): Marveen must never freeze the computer and must work on slow machines.
// The rule reaches every agent (own CLAUDE.md block, machine-wide block, per-message hook, template, learned
// rule R42, a global seed skill) and the code sessions (task preamble, verification prompt, code-bridge prompt).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildNoFreezeBody, ensureNoFreezeSection } from '../web/agent-scaffold.js'
import { NO_FREEZE_DISPATCH_EN, NO_FREEZE_DISPATCH_HU } from '../no-freeze-rule.js'
import { buildCodeBridgePrompt } from '../workbench-agent/code-bridge-turn.js'
import { buildVerificationPrompt } from '../approval-verification-dispatch.js'
import { buildCodeTaskPreamble } from '../web/code-task-preamble.js'

const THROWAWAY = 'zz-no-freeze-probe'
const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), 'utf-8')
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('no-freeze rule (#950)', () => {
  it('names the forbidden calls and the slow-machine requirement; no owner name or path', () => {
    const b = buildNoFreezeBody()
    expect(b).toContain('NE FAGYASZD LE A GEPET')
    expect(b).toContain('LASSU GEPEN IS MUKODJON')
    expect(b).toContain('statSync')
    expect(b).toContain('scryptSync')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('is appended once, idempotently; skips the main agent and agents without CLAUDE.md', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    expect(ensureNoFreezeSection(THROWAWAY)).toBe('no-file')
    writeFileSync(path, '# probe\n\nSajat.\n')
    expect(ensureNoFreezeSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(once).toContain('Sajat.')
    expect(once).toContain('no-freeze-rule')
    expect(ensureNoFreezeSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(ensureNoFreezeSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })
  it('reaches the code sessions: task preamble (hu+en), verification prompt, code-bridge prompt', () => {
    expect(NO_FREEZE_DISPATCH_HU).toContain('NE FAGYASZD LE A GEPET')
    expect(NO_FREEZE_DISPATCH_EN).toContain('DO NOT FREEZE THE COMPUTER')
    const src = read('src/web/code-task-preamble.ts')
    expect(src).toContain('NO_FREEZE_DISPATCH_HU')
    expect(src).toContain('NO_FREEZE_DISPATCH_EN')
    expect(read('src/approval-verification-dispatch.ts')).toContain('NO_FREEZE_DISPATCH_HU')
    expect(read('src/workbench-agent/code-bridge-turn.ts')).toContain('NO_FREEZE_DISPATCH_EN')
    expect(typeof buildCodeBridgePrompt).toBe('function')
    expect(typeof buildVerificationPrompt).toBe('function')
    expect(typeof buildCodeTaskPreamble).toBe('function')
  })
  it('is in the startup hooks, the digest table, the template, the learned rules and a global seed skill', () => {
    expect(read('scripts/hooks/fresh-install-rule.py')).toContain('NE FAGYASZD LE A GEPET')
    expect(read('src/web/rule-digests.ts')).toContain("'no-freeze'")
    const web = read('src/web.ts')
    expect(web).toContain('ensureNoFreezeSection(agentName)')
    expect(web).toContain('ensureGlobalNoFreezeRule()')
    expect(read('src/web/agent-process.ts')).toContain('ensureNoFreezeSection(name)')
    expect(read('templates/CLAUDE.md.template')).toContain('ensureNoFreezeSection')
    expect(read('seed-skills/marveen-learned-rules/SKILL.md')).toContain('### R42')
    const skill = read('seed-skills/no-freeze-development/SKILL.md')
    expect(skill).toContain('scope: global')
    expect(skill).toContain('/api/perf/slow-fs')
  })
})
