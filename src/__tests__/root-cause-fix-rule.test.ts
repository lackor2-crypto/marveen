// Boss TG 3948: fix the root cause at every occurrence. Every agent gets the rule.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildRootCauseFixBody, ensureRootCauseFixSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-root-cause-fix-probe'
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('root-cause-fix rule', () => {
  it('names the rule, no owner name or path', () => {
    const b = buildRootCauseFixBody()
    expect(b).toContain('GYOKERENEL')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('appends once, idempotently; skips main agent and agents without CLAUDE.md', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    expect(ensureRootCauseFixSection(THROWAWAY)).toBe('no-file')
    writeFileSync(path, '# probe\n\nSajat.\n')
    expect(ensureRootCauseFixSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(ensureRootCauseFixSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(ensureRootCauseFixSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })
  it('is in the hook, the template and the learned-rules', () => {
    expect(readFileSync(join(PROJECT_ROOT, 'scripts/hooks/fresh-install-rule.py'), 'utf-8')).toContain('GYOKEROK')
    expect(readFileSync(join(PROJECT_ROOT, 'templates/CLAUDE.md.template'), 'utf-8')).toContain('ensureRootCauseFixSection')
    expect(readFileSync(join(PROJECT_ROOT, 'seed-skills/marveen-learned-rules/SKILL.md'), 'utf-8')).toContain('### R16')
  })
})
