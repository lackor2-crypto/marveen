// #895 (Boss TG 5857): agents test in the sandbox project. Every agent gets the rule, a fresh install gets the project.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildTestSandboxBody, ensureTestSandboxSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-test-sandbox-probe'
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('test-sandbox rule', () => {
  it('names the sandbox slug and the browser exception; no owner name or path', () => {
    const b = buildTestSandboxBody()
    expect(b).toContain('`sandbox`')
    expect(b).toContain('bongeszos kattintas')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('appends once, idempotently; skips main agent and agents without CLAUDE.md', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    expect(ensureTestSandboxSection(THROWAWAY)).toBe('no-file')
    writeFileSync(path, '# probe\n\nSajat.\n')
    expect(ensureTestSandboxSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(ensureTestSandboxSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(ensureTestSandboxSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })
  it('is in the template and the global skill; the skill carries scope: global', () => {
    expect(readFileSync(join(PROJECT_ROOT, 'templates/CLAUDE.md.template'), 'utf-8')).toContain('ensureTestSandboxSection')
    const sk = readFileSync(join(PROJECT_ROOT, 'seed-skills/test-in-sandbox-project/SKILL.md'), 'utf-8')
    expect(sk).toContain('scope: global')
    expect(sk).toContain('sandbox')
  })
})
