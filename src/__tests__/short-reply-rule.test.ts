// #494: every agent gets the "look back at your own last messages before asking back about a short reply" rule.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildShortReplyBody, ensureShortReplySection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-short-reply-probe'
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
  it('skips the main agent and agents without a CLAUDE.md', () => {
    expect(ensureShortReplySection(MAIN_AGENT_ID)).toBe('skipped-main')
    expect(ensureShortReplySection(THROWAWAY)).toBe('no-file')
  })
})
