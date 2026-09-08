// The "verify before you attribute authorship" doctrine must reach EVERY
// agent, not just new ones.
//
// Boss, 2026-09-08 (after a real misattribution incident): a model switch
// (Opus 4.8 -> Sonnet 5) forced a session restart, and the freshly loaded
// context contained the agent's OWN prior message about a VS Code
// code-bridge fix and a kanban landing. The topic looked like the main
// agent's territory, so it was attributed to the main agent without
// checking -- when in fact it was this agent's own earlier turn. "irj egy
// szabalyt erre hogy ha be kel azonositani valamit akkor hogyan jarj el, es
// miket kell leelenorizni kotelezoen! ... mindenhova!"
//
// Same marker-block family as the ask-back / recheck / landing / one-card
// rules, so it reaches existing agents (per-agent CLAUDE.md), worktree
// agents and the main agent (machine-wide ~/.claude/CLAUDE.md), and future
// agents, retroactively.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { ensureAgentIdentitySection, ensureGlobalAgentIdentityRule } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-agent-identity-probe'
const MARKER = 'BEGIN GENERATED: agent-identity-rule'

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

describe('ensureAgentIdentitySection', () => {
  it('appends the rule to an existing agent CLAUDE.md, keeping the original content', () => {
    const path = seed('# zz-agent-identity-probe\n\nSajat tartalom.\n')
    ensureAgentIdentitySection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('AZONOSITAS ELOTT KOTELEZO ELLENORIZNI')
    expect(out).toContain('Sajat tartalom.')
    // Host-agnostic: the generated block names no owner and no agent literal.
    expect(out).not.toContain('Boss')
    expect(out).not.toContain('Szabolcs')
  })

  it('is idempotent: no duplicate block and no rewrite on the second call', () => {
    const path = seed('# zz-agent-identity-probe\n\nSajat tartalom.\n')
    ensureAgentIdentitySection(THROWAWAY)
    const first = readFileSync(path, 'utf-8')
    const mtimeBefore = statSync(path).mtimeMs

    ensureAgentIdentitySection(THROWAWAY)

    expect(readFileSync(path, 'utf-8')).toEqual(first)
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
    expect(first.split(MARKER).length - 1).toBe(1)
  })

  it('never touches content outside the markers', () => {
    const path = seed('# fejlec\n\nELSO\n')
    ensureAgentIdentitySection(THROWAWAY)
    const withBlock = readFileSync(path, 'utf-8')
    writeFileSync(path, withBlock + '\nUTOLSO SOR\n')

    ensureAgentIdentitySection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('ELSO')
    expect(out).toContain('UTOLSO SOR')
  })

  it('does nothing when the agent has no CLAUDE.md (fresh install)', () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    expect(() => ensureAgentIdentitySection(THROWAWAY)).not.toThrow()
    expect(existsSync(join(agentDir(THROWAWAY), 'CLAUDE.md'))).toBe(false)
  })

  it('reports WHY nothing was written, so zero is never ambiguous', () => {
    expect(ensureAgentIdentitySection('zz-no-such-agent-at-all')).toBe('no-file')
    expect(ensureAgentIdentitySection(MAIN_AGENT_ID)).toBe('skipped-main')

    seed('# zz-agent-identity-probe\n\nSajat tartalom.\n')
    expect(ensureAgentIdentitySection(THROWAWAY)).toBe('written')
    expect(ensureAgentIdentitySection(THROWAWAY)).toBe('current')
  })

  it('ships the skill in seed-skills so a fresh install has it too', () => {
    const skill = join(PROJECT_ROOT, 'seed-skills', 'agent-identity-verification', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    expect(readFileSync(skill, 'utf-8')).toContain('name: agent-identity-verification')
  })

  it('the main-agent CLAUDE.md template carries the rule (fresh clone)', () => {
    const text = readFileSync(join(PROJECT_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(text).toContain('AZONOSÍTÁS ELŐTT KÖTELEZŐ ELLENŐRIZNI')
  })
})

// The machine-wide half of "mindenhova": a worktree-based agent and the main
// agent never load agents/<name>/CLAUDE.md; ~/.claude/CLAUDE.md is the only file
// every Claude Code session reads no matter where it runs.
describe('ensureGlobalAgentIdentityRule', () => {
  let home: string
  let realHome: string | undefined

  beforeEach(() => {
    realHome = process.env['HOME']
    home = mkdtempSync(join(tmpdir(), 'agentid-home-'))
    process.env['HOME'] = home
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = realHome
    rmSync(home, { recursive: true, force: true })
  })

  it('creates ~/.claude/CLAUDE.md on a fresh install where nothing exists yet', () => {
    ensureGlobalAgentIdentityRule()
    const out = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('AZONOSITAS ELOTT KOTELEZO ELLENORIZNI')
  })

  it("keeps the operator's own rules and adds the block once", () => {
    const path = join(home, '.claude', 'CLAUDE.md')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(path, '# Sajat szabalyaim\n\nNE NYULJ HOZZA\n')

    ensureGlobalAgentIdentityRule()
    ensureGlobalAgentIdentityRule()

    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('NE NYULJ HOZZA')
    expect(out.split(MARKER).length - 1).toBe(1)
  })

  it('does not rewrite the file when the block is already current', () => {
    ensureGlobalAgentIdentityRule()
    const path = join(home, '.claude', 'CLAUDE.md')
    const mtimeBefore = statSync(path).mtimeMs
    ensureGlobalAgentIdentityRule()
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
  })
})
