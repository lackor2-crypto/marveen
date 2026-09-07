// The "one bug = one card, finish it immediately" doctrine must reach EVERY
// agent, not just new ones.
//
// Boss, 2026-09-07: "egy hiba egy kartya es kesz! ... ha van egy kartya akkor
// szigoruan tilos kivenni a kartyabol egy adott hibat es betenni egy masik
// kartya ala! ... azonnal keszre kell csinalni a kartyat." -- and: "ezeket ird
// be mindenhova." Cards that reference and depend on each other tangle and stop
// each other; a bug carved out into another card, or a card left half-done, is
// the failure mode this rule closes.
//
// Same marker-block family as the ask-back / recheck / landing rules, so it
// reaches existing agents (per-agent CLAUDE.md), worktree agents and the main
// agent (machine-wide ~/.claude/CLAUDE.md), and future agents, retroactively.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { ensureOneCardOneFixSection, ensureGlobalOneCardOneFixRule } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-one-card-probe'
const MARKER = 'BEGIN GENERATED: one-card-one-fix-rule'

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

describe('ensureOneCardOneFixSection', () => {
  it('appends the rule to an existing agent CLAUDE.md, keeping the original content', () => {
    const path = seed('# zz-one-card-probe\n\nSajat tartalom.\n')
    ensureOneCardOneFixSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('EGY HIBA = EGY KARTYA')
    expect(out).toContain('Sajat tartalom.')
    // Host-agnostic: the generated block names no owner and no agent literal.
    expect(out).not.toContain('Boss')
    expect(out).not.toContain('Szabolcs')
  })

  it('is idempotent: no duplicate block and no rewrite on the second call', () => {
    const path = seed('# zz-one-card-probe\n\nSajat tartalom.\n')
    ensureOneCardOneFixSection(THROWAWAY)
    const first = readFileSync(path, 'utf-8')
    const mtimeBefore = statSync(path).mtimeMs

    ensureOneCardOneFixSection(THROWAWAY)

    expect(readFileSync(path, 'utf-8')).toEqual(first)
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
    expect(first.split(MARKER).length - 1).toBe(1)
  })

  it('never touches content outside the markers', () => {
    const path = seed('# fejlec\n\nELSO\n')
    ensureOneCardOneFixSection(THROWAWAY)
    const withBlock = readFileSync(path, 'utf-8')
    writeFileSync(path, withBlock + '\nUTOLSO SOR\n')

    ensureOneCardOneFixSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('ELSO')
    expect(out).toContain('UTOLSO SOR')
  })

  it('does nothing when the agent has no CLAUDE.md (fresh install)', () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    expect(() => ensureOneCardOneFixSection(THROWAWAY)).not.toThrow()
    expect(existsSync(join(agentDir(THROWAWAY), 'CLAUDE.md'))).toBe(false)
  })

  it('reports WHY nothing was written, so zero is never ambiguous', () => {
    expect(ensureOneCardOneFixSection('zz-no-such-agent-at-all')).toBe('no-file')
    expect(ensureOneCardOneFixSection(MAIN_AGENT_ID)).toBe('skipped-main')

    seed('# zz-one-card-probe\n\nSajat tartalom.\n')
    expect(ensureOneCardOneFixSection(THROWAWAY)).toBe('written')
    expect(ensureOneCardOneFixSection(THROWAWAY)).toBe('current')
  })

  it('ships the skill in seed-skills so a fresh install has it too', () => {
    const skill = join(PROJECT_ROOT, 'seed-skills', 'one-card-one-fix', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    expect(readFileSync(skill, 'utf-8')).toContain('name: one-card-one-fix')
  })

  it('the main-agent CLAUDE.md template carries the rule (fresh clone)', () => {
    const text = readFileSync(join(PROJECT_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(text).toContain('EGY HIBA = EGY KÁRTYA')
  })
})

// The machine-wide half of "mindenhova": a worktree-based agent and the main
// agent never load agents/<name>/CLAUDE.md; ~/.claude/CLAUDE.md is the only file
// every Claude Code session reads no matter where it runs.
describe('ensureGlobalOneCardOneFixRule', () => {
  let home: string
  let realHome: string | undefined

  beforeEach(() => {
    realHome = process.env['HOME']
    home = mkdtempSync(join(tmpdir(), 'onecard-home-'))
    process.env['HOME'] = home
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = realHome
    rmSync(home, { recursive: true, force: true })
  })

  it('creates ~/.claude/CLAUDE.md on a fresh install where nothing exists yet', () => {
    ensureGlobalOneCardOneFixRule()
    const out = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('EGY HIBA = EGY KARTYA')
  })

  it("keeps the operator's own rules and adds the block once", () => {
    const path = join(home, '.claude', 'CLAUDE.md')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(path, '# Sajat szabalyaim\n\nNE NYULJ HOZZA\n')

    ensureGlobalOneCardOneFixRule()
    ensureGlobalOneCardOneFixRule()

    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('NE NYULJ HOZZA')
    expect(out.split(MARKER).length - 1).toBe(1)
  })

  it('does not rewrite the file when the block is already current', () => {
    ensureGlobalOneCardOneFixRule()
    const path = join(home, '.claude', 'CLAUDE.md')
    const mtimeBefore = statSync(path).mtimeMs
    ensureGlobalOneCardOneFixRule()
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
  })
})
