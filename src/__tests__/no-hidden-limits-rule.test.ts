// Boss TG 3856: no hidden limitations. Every agent gets the rule.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildNoHiddenLimitsBody, ensureNoHiddenLimitsSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-no-hidden-limits-probe'
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('no-hidden-limits rule', () => {
  it('forbids hidden limits, requires telling the owner first; no owner name or path', () => {
    const b = buildNoHiddenLimitsBody()
    expect(b).toContain('REJTETT KORLATOZAST SOHA')
    expect(b).toContain('ELOBB jelezd')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('appends once, idempotently; skips main agent and agents without CLAUDE.md', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    expect(ensureNoHiddenLimitsSection(THROWAWAY)).toBe('no-file')
    writeFileSync(path, '# probe\n\nSajat.\n')
    expect(ensureNoHiddenLimitsSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(once).toContain('Sajat.')
    expect(ensureNoHiddenLimitsSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(ensureNoHiddenLimitsSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })
  it('is in the per-message hook, the template, the learned-rules and the dev skill', () => {
    expect(readFileSync(join(PROJECT_ROOT, 'scripts/hooks/fresh-install-rule.py'), 'utf-8')).toContain('REJTETT KORLATOT SOHA')
    expect(readFileSync(join(PROJECT_ROOT, 'templates/CLAUDE.md.template'), 'utf-8')).toContain('ensureNoHiddenLimitsSection')
    expect(readFileSync(join(PROJECT_ROOT, 'seed-skills/marveen-learned-rules/SKILL.md'), 'utf-8')).toContain('### R15')
    expect(readFileSync(join(PROJECT_ROOT, 'seed-skills/host-agnostic-development/SKILL.md'), 'utf-8')).toContain('Rejtett korlátozás tilos')
  })
})
