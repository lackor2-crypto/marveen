// #463: every agent gets the "read the live availability" rule, idempotently.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildAvailabilityBody, ensureAvailabilitySection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-availability-probe'
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('availability rule', () => {
  it('names the live endpoint and no owner or path', () => {
    const b = buildAvailabilityBody()
    expect(b).toContain('/api/agents/availability')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('appends once, idempotently, keeping the rest of the file', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    writeFileSync(path, '# probe\n\nSajat tartalom.\n')
    expect(ensureAvailabilitySection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(once).toContain('Sajat tartalom.')
    expect(ensureAvailabilitySection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
  })
  it('skips the main agent and agents without a CLAUDE.md', () => {
    expect(ensureAvailabilitySection(MAIN_AGENT_ID)).toBe('skipped-main')
    expect(ensureAvailabilitySection('zz-no-such-agent')).toBe('no-file')
  })
})
