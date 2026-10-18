// #701: every agent gets the "linked/referenced content is never empty -- follow the link" rule.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildFollowReferenceBody, ensureFollowReferenceSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-follow-reference-probe'
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('follow-the-reference rule', () => {
  it('names the link-following and the forbidden "nothing there"; no owner or path', () => {
    const b = buildFollowReferenceBody()
    expect(b).toContain('KOVESD A LINKET')
    expect(b).toContain('annex')
    expect(b).toContain('tilos azt mondani')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('appends once, idempotently, keeping the rest of the file', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    writeFileSync(path, '# probe\n\nSajat tartalom.\n')
    expect(ensureFollowReferenceSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(once).toContain('Sajat tartalom.')
    expect(ensureFollowReferenceSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
  })
  it('skips the main agent and agents without a CLAUDE.md', () => {
    expect(ensureFollowReferenceSection(MAIN_AGENT_ID)).toBe('skipped-main')
    expect(ensureFollowReferenceSection(THROWAWAY)).toBe('no-file')
  })
  it('the rule is present in the per-message hook, the template and the learned-rules skill', () => {
    const hook = readFileSync(join(PROJECT_ROOT, 'scripts/hooks/fresh-install-rule.py'), 'utf-8')
    expect(hook).toContain('HIVATKOZAST')
    const tpl = readFileSync(join(PROJECT_ROOT, 'templates/CLAUDE.md.template'), 'utf-8')
    expect(tpl).toContain('HIVATKOZÁST KÖVESS')
    expect(tpl).toContain('ensureFollowReferenceSection')
    const skill = readFileSync(join(PROJECT_ROOT, 'seed-skills/marveen-learned-rules/SKILL.md'), 'utf-8')
    expect(skill).toContain('### R13')
    expect(skill).toMatch(/^scope: global$/m)
  })
})
