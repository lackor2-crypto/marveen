// Kanban #416 (owner 2026-09-27: "angolul ne írjatok a Telegramra"): the
// progress mirror forwards the agents' terminal text to the owner's chat, so
// every agent must be told to write that text in the install language. Same
// contract as card-reference-rule.test.ts.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildOwnerLanguageBody, ensureOwnerLanguageSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-owner-language-probe'

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

describe('owner-language rule', () => {
  it('follows the install language and names no owner or path', () => {
    const hu = buildOwnerLanguageBody('hu')
    expect(hu).toContain('KIZAROLAG MAGYARUL')
    expect(hu).toContain('terminal')
    expect(buildOwnerLanguageBody('en')).toContain('ENGLISH ONLY')
    for (const body of [hu, buildOwnerLanguageBody('en')]) {
      expect(body).not.toContain('Boss')
      expect(body).not.toContain('/home/')
    }
  })

  it('appends once, idempotently, keeping the rest of the file', () => {
    const path = seed('# probe\n\nSajat tartalom.\n')
    expect(ensureOwnerLanguageSection(THROWAWAY)).toBe('written')
    const first = readFileSync(path, 'utf-8')
    const mtime = statSync(path).mtimeMs
    expect(ensureOwnerLanguageSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toEqual(first)
    expect(statSync(path).mtimeMs).toEqual(mtime)
    expect(first).toContain('Sajat tartalom.')
    expect(first.split('BEGIN GENERATED: owner-language-rule').length - 1).toBe(1)
  })

  it('does nothing without a CLAUDE.md, and skips the main agent', () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    expect(ensureOwnerLanguageSection(THROWAWAY)).toBe('no-file')
    expect(ensureOwnerLanguageSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })

  it('is wired for every agent at start and machine-wide', () => {
    const web = readFileSync(join(__dirname, '..', 'web.ts'), 'utf8')
    const proc = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf8')
    expect(web).toContain('ensureOwnerLanguageSection(agentName)')
    expect(web).toContain('ensureGlobalOwnerLanguageRule()')
    expect(proc).toContain('ensureOwnerLanguageSection(name)')
  })
})
