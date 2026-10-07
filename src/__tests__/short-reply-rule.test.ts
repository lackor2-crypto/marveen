// #494: every agent gets the "look back at your own last messages before asking back about a short reply" rule.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildShortReplyBody, ensureGlobalShortReplyRule, ensureShortReplySection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-short-reply-probe'
const BEGIN = '<!-- BEGIN GENERATED: short-reply-rule (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: short-reply-rule -->'
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('short-reply rule', () => {
  it('tells the agent to look back first and names no owner or path', () => {
    const b = buildShortReplyBody()
    expect(b).toContain('VISSZANEZ')
    expect(b).toContain('"A"')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('appends once, idempotently, keeping the rest of the file', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    writeFileSync(path, '# probe\n\nSajat tartalom.\n')
    expect(ensureShortReplySection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(once).toContain('Sajat tartalom.')
    expect(ensureShortReplySection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
  })
  it('replaces a stale block in place instead of adding a second one', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    writeFileSync(path, `ELOTTE.\n\n${BEGIN}\nregi szoveg\n${END}\n\nUTANA.\n`)
    expect(ensureShortReplySection(THROWAWAY)).toBe('written')
    const out = readFileSync(path, 'utf-8')
    expect(out).not.toContain('regi szoveg')
    expect(out).toContain(buildShortReplyBody())
    expect(out.split('BEGIN GENERATED: short-reply-rule').length - 1).toBe(1)
    expect(out.indexOf('ELOTTE.')).toBeLessThan(out.indexOf(BEGIN))
    expect(out.indexOf(END)).toBeLessThan(out.indexOf('UTANA.'))
  })
  it('skips the main agent and agents without a CLAUDE.md', () => {
    expect(ensureShortReplySection(MAIN_AGENT_ID)).toBe('skipped-main')
    expect(ensureShortReplySection(THROWAWAY)).toBe('no-file')
  })
})

// The main agent is skipped above and an agent running in a git worktree never
// loads agents/<name>/CLAUDE.md -- both read ~/.claude/CLAUDE.md, so the
// machine-wide copy is what actually reaches the agent the owner talks to.
// os.homedir() honours $HOME on POSIX, which keeps these tests off the real file.
describe('ensureGlobalShortReplyRule', () => {
  let home: string
  let realHome: string | undefined

  beforeEach(() => {
    realHome = process.env['HOME']
    home = mkdtempSync(join(tmpdir(), 'short-reply-home-'))
    process.env['HOME'] = home
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = realHome
    rmSync(home, { recursive: true, force: true })
  })

  it('creates ~/.claude/CLAUDE.md on a fresh install where nothing exists yet', () => {
    ensureGlobalShortReplyRule()
    const out = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')
    expect(out).toContain(buildShortReplyBody())
  })

  it("keeps the operator's own rules and adds the block once", () => {
    const path = join(home, '.claude', 'CLAUDE.md')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(path, '# Sajat szabalyaim\n\nNE NYULJ HOZZA\n')
    ensureGlobalShortReplyRule()
    ensureGlobalShortReplyRule()
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('NE NYULJ HOZZA')
    expect(out.split('BEGIN GENERATED: short-reply-rule').length - 1).toBe(1)
  })

  it('does not rewrite the file when the block is already current', () => {
    ensureGlobalShortReplyRule()
    const path = join(home, '.claude', 'CLAUDE.md')
    const mtimeBefore = statSync(path).mtimeMs
    ensureGlobalShortReplyRule()
    expect(statSync(path).mtimeMs).toEqual(mtimeBefore)
  })
})

describe('the rule reaches fresh installs and the whole fleet', () => {
  const read = (p: string) => readFileSync(join(PROJECT_ROOT, p), 'utf-8')

  it('is wired for every agent at dashboard start, at agent start, and machine-wide', () => {
    const web = read('src/web.ts')
    expect(web).toContain('ensureShortReplySection(agentName)')
    expect(web).toContain('ensureGlobalShortReplyRule()')
    expect(read('src/web/agent-process.ts')).toContain('ensureShortReplySection(name)')
  })

  it('the main-agent CLAUDE.md template carries the rule without an owner name', () => {
    const text = read('templates/CLAUDE.md.template')
    expect(text).toContain('RÖVID VÁLASZ ELŐTT VISSZANÉZEL')
    expect(text).toContain('ensureShortReplySection')
    expect(text).toContain('{{OWNER_NAME}} egy rövid választ küld')
  })
})
