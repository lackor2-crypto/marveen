// Boss TG 4543: the window-envelope letter head rule reaches every agent, the workbench prompt and the skills.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildLetterHeadBody, ensureLetterHeadSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-letterhead-probe'
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })
const read = (p: string) => readFileSync(join(PROJECT_ROOT, p), 'utf-8')

describe('window-envelope letter head rule', () => {
  it('names the form, no owner name or path', () => {
    const b = buildLetterHeadBody()
    expect(b).toContain('JOBBRA FENT')
    expect(b).toContain('#w=45&a=l&x=55&y=0&o=1')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('appends once, idempotently; skips main agent and agents without CLAUDE.md', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    expect(ensureLetterHeadSection(THROWAWAY)).toBe('no-file')
    writeFileSync(path, '# probe\n\nSajat.\n')
    expect(ensureLetterHeadSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(ensureLetterHeadSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(ensureLetterHeadSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })
  it('is in the workbench prompts, the template, the skills and the wiring', () => {
    expect(read('src/web/routes/workbench-agent.ts')).toContain('window-envelope letter head')
    expect(read('src/workbench-agent/context.ts')).toContain('WINDOW-ENVELOPE LETTER HEAD')
    expect(read('templates/CLAUDE.md.template')).toContain('ensureLetterHeadSection')
    expect(read('seed-skills/marveen-learned-rules/SKILL.md')).toContain('### R25')
    expect(read('seed-skills/letter-head-sender-recipient/SKILL.md')).toContain('ablakos boríték')
    expect(read('src/web.ts')).toContain('ensureGlobalLetterHeadRule()')
    expect(read('src/web.ts')).toContain('ensureLetterHeadSection(agentName)')
    expect(read('src/web/agent-process.ts')).toContain('ensureLetterHeadSection(name)')
  })
})
