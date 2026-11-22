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
  it('tells the agent to use the owner\'s existing PROBA project first and never open a second one (Boss TG 7456)', () => {
    const b = buildTestSandboxBody()
    expect(b).toContain('ELOSZOR')
    expect(b).toContain('"PROBA"/"proba"')
    expect(b).toContain('SOHA ne nyiss')
    const sk = readFileSync(join(PROJECT_ROOT, 'seed-skills/test-in-sandbox-project/SKILL.md'), 'utf-8')
    expect(sk).toContain('FIRST look for the owner')
    expect(sk).toContain('Never open a second test project')
  })
  it('forbids creating a new project unless the owner asks (Boss TG 7468)', () => {
    const b = buildTestSandboxBody()
    expect(b).toContain('UJ PROJEKTET LETREHOZNI TILOS')
    expect(b).not.toContain('nyiss egyet')
    const sk = readFileSync(join(PROJECT_ROOT, 'seed-skills/test-in-sandbox-project/SKILL.md'), 'utf-8')
    expect(sk).toContain('NEVER create a project yourself')
  })
  it('the short digest agents read first carries the same ban (Boss TG 7468)', () => {
    const d = readFileSync(join(PROJECT_ROOT, 'src/web/rule-digests.ts'), 'utf-8')
    expect(d).toContain('UJ PROJEKTET LETREHOZNI TILOS')
    expect(d).not.toContain('nyiss egyet sandbox')
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
