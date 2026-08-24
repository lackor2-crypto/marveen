// The mandatory ask-back rule must reach EVERY agent, not just new ones.
//
// Boss, 2026-08-24: "ha ketertelmu akkor kotelezoen vissza kell kerdeznie!
// mindenhova tedd be." The rule exists because a "delete the agents that are
// not working" instruction had its scope guessed on 2026-08-23 and took a
// seventh agent (Gypsy) with it that was never named. The deletion was
// irreversible and left no audit trail.
//
// What this test protects:
//   1. an existing agent's CLAUDE.md gets the block appended (no manual migration),
//   2. calling it again is a no-op -- no duplicate block, no mtime churn,
//   3. content OUTSIDE the markers is never touched,
//   4. the main agent is skipped (its rule lives as tracked repo text in
//      CLAUDE.md, not as a generated block written on every boot),
//   5. the repo CLAUDE.md really carries that rule.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { ensureAskBackSection, ensureGlobalAskBackRule } from '../web/agent-scaffold.js'

// A throwaway name no live fleet member can collide with.
const THROWAWAY = 'zz-ask-back-probe'

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

describe('ensureAskBackSection', () => {
  it('appends the rule to an existing agent CLAUDE.md', () => {
    const path = seed('# zz-ask-back-probe\n\nSajat tartalom.\n')
    ensureAskBackSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('KOTELEZO VISSZAKERDEZES')
    // The original content survives.
    expect(out).toContain('Sajat tartalom.')
    // And the incident is spelled out, not just the principle -- a rule stated
    // as advice gets read as advice. The generated block names no agent and no
    // owner (host-agnostic rule): it describes what happened, not who it was.
    expect(out).toContain('toroljed a nem mukodo agenseket')
    expect(out).not.toContain('Gypsy')
  })

  it('is idempotent: no duplicate block and no rewrite on the second call', () => {
    const path = seed('# zz-ask-back-probe\n\nSajat tartalom.\n')
    ensureAskBackSection(THROWAWAY)
    const first = readFileSync(path, 'utf-8')
    const mtimeBefore = statSync(path).mtimeMs

    ensureAskBackSection(THROWAWAY)
    const second = readFileSync(path, 'utf-8')

    expect(second).toEqual(first)
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
    const occurrences = second.split('BEGIN GENERATED: ask-back-rule').length - 1
    expect(occurrences).toBe(1)
  })

  it('never touches content outside the markers', () => {
    const path = seed('# fejlec\n\nELSO\n')
    ensureAskBackSection(THROWAWAY)
    const withBlock = readFileSync(path, 'utf-8')
    writeFileSync(path, withBlock + '\nUTOLSO SOR\n')

    ensureAskBackSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('ELSO')
    expect(out).toContain('UTOLSO SOR')
  })

  it('does nothing when the agent has no CLAUDE.md (fresh install)', () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    expect(() => ensureAskBackSection(THROWAWAY)).not.toThrow()
    expect(existsSync(join(agentDir(THROWAWAY), 'CLAUDE.md'))).toBe(false)
  })

  it('skips the main agent (its rule is tracked repo text, not a generated block)', () => {
    const repoClaudeMd = join(PROJECT_ROOT, 'CLAUDE.md')
    // Gitignored and per-install: a fresh clone has not rendered it yet.
    if (!existsSync(repoClaudeMd)) return
    const before = readFileSync(repoClaudeMd, 'utf-8')
    ensureAskBackSection(MAIN_AGENT_ID)
    expect(readFileSync(repoClaudeMd, 'utf-8')).toEqual(before)
    expect(before).not.toContain('BEGIN GENERATED: ask-back-rule')
  })

  // The main agent's CLAUDE.md is per-install and gitignored: it is RENDERED
  // from this template. Asserting on the template (not on the rendered file) is
  // what makes the rule true for a fresh clone, where CLAUDE.md does not exist
  // yet -- Boss, 2026-08-24: "barki alapbol ha letolti a marveen t akkor legyen
  // meg nala, uj telepitesnel is".
  it('the main-agent CLAUDE.md template carries the ask-back rule', () => {
    const text = readFileSync(join(PROJECT_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(text).toContain('KÖTELEZŐ VISSZAKÉRDEZÉS KÉTÉRTELMŰSÉGNÉL')
    expect(text).toContain('ask-back-when-ambiguous')
  })

  it('ships the skill in seed-skills so a fresh install has it too', () => {
    const skill = join(PROJECT_ROOT, 'seed-skills', 'ask-back-when-ambiguous', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    expect(readFileSync(skill, 'utf-8')).toContain('name: ask-back-when-ambiguous')
  })
})

// The machine-wide half of "mindenhova". An agent whose CWD is a git worktree
// (measured: usalackor) never loads agents/<name>/CLAUDE.md, so the per-agent
// block alone leaves a real hole in the fleet. os.homedir() honours $HOME on
// POSIX, which is how these tests keep away from the operator's own file.
describe('ensureGlobalAskBackRule', () => {
  let home: string
  let realHome: string | undefined

  beforeEach(() => {
    realHome = process.env['HOME']
    home = mkdtempSync(join(tmpdir(), 'askback-home-'))
    process.env['HOME'] = home
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = realHome
    rmSync(home, { recursive: true, force: true })
  })

  it('creates ~/.claude/CLAUDE.md on a fresh install where nothing exists yet', () => {
    ensureGlobalAskBackRule()
    const out = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('KOTELEZO VISSZAKERDEZES')
    expect(out).toContain('toroljed a nem mukodo agenseket')
  })

  it("keeps the operator's own rules and adds the block once", () => {
    const path = join(home, '.claude', 'CLAUDE.md')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(path, '# Sajat szabalyaim\n\nNE NYULJ HOZZA\n')

    ensureGlobalAskBackRule()
    ensureGlobalAskBackRule()

    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('NE NYULJ HOZZA')
    expect(out.split('BEGIN GENERATED: ask-back-rule').length - 1).toBe(1)
  })

  it('does not rewrite the file when the block is already current', () => {
    ensureGlobalAskBackRule()
    const path = join(home, '.claude', 'CLAUDE.md')
    const mtimeBefore = statSync(path).mtimeMs
    ensureGlobalAskBackRule()
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
  })
})
