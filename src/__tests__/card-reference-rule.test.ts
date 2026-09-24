// The "refer to a kanban card by its row number (#N)" rule (kanban #369) must
// reach EVERY agent: the owner sees the row number on the board, the 8-char
// id means nothing to them. Same contract as kanban-waiting-move-rule.test.ts.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { ensureCardReferenceSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-card-reference-probe'

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

describe('ensureCardReferenceSection', () => {
  it('appends the rule to an existing agent CLAUDE.md', () => {
    const path = seed('# zz-card-reference-probe\n\nSajat tartalom.\n')
    ensureCardReferenceSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('KARTYARA MINDIG A SORSZAMAVAL HIVATKOZZ')
    expect(out).toContain('`#369 (27410f1b)`')
    expect(out).toContain('Sajat tartalom.')
    expect(out).not.toContain('Boss')
    expect(out).not.toContain('/home/')
  })

  it('is idempotent: no duplicate block and no rewrite on the second call', () => {
    const path = seed('# probe\n')
    ensureCardReferenceSection(THROWAWAY)
    const first = readFileSync(path, 'utf-8')
    const mtimeBefore = statSync(path).mtimeMs
    ensureCardReferenceSection(THROWAWAY)
    expect(readFileSync(path, 'utf-8')).toEqual(first)
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
    expect(first.split('BEGIN GENERATED: card-reference-by-number-rule').length - 1).toBe(1)
  })

  it('never touches content outside the markers', () => {
    const path = seed('# fejlec\n\nELSO\n')
    ensureCardReferenceSection(THROWAWAY)
    writeFileSync(path, readFileSync(path, 'utf-8') + '\nUTOLSO SOR\n')
    ensureCardReferenceSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('ELSO')
    expect(out).toContain('UTOLSO SOR')
  })

  it('does nothing when the agent has no CLAUDE.md (fresh install)', () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    expect(ensureCardReferenceSection(THROWAWAY)).toBe('no-file')
    expect(existsSync(join(agentDir(THROWAWAY), 'CLAUDE.md'))).toBe(false)
  })

  it('reports WHY nothing was written, so zero is never ambiguous', () => {
    expect(ensureCardReferenceSection('zz-no-such-agent-at-all')).toBe('no-file')
    expect(ensureCardReferenceSection(MAIN_AGENT_ID)).toBe('skipped-main')
    seed('# probe\n')
    expect(ensureCardReferenceSection(THROWAWAY)).toBe('written')
    expect(ensureCardReferenceSection(THROWAWAY)).toBe('current')
  })
})

describe('the rule reaches fresh installs and the whole fleet', () => {
  const read = (p: string) => readFileSync(join(PROJECT_ROOT, p), 'utf-8')

  it('the main-agent CLAUDE.md template carries the rule', () => {
    const text = read('templates/CLAUDE.md.template')
    expect(text).toContain('Kártyára MINDIG a sorszámával hivatkozz')
    expect(text).toContain('ensureCardReferenceSection')
  })

  it('the global skill ships in seed-skills with scope: global', () => {
    const text = read('seed-skills/card-reference-by-number/SKILL.md')
    expect(text).toMatch(/^scope: global$/m)
  })

  it('both the per-agent and the machine-wide rule are wired', () => {
    const web = read('src/web.ts')
    expect(web).toContain('ensureCardReferenceSection(agentName)')
    expect(web).toContain('ensureGlobalCardReferenceRule()')
    expect(read('src/web/agent-process.ts')).toContain('ensureCardReferenceSection(name)')
  })
})
