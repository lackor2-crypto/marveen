// #672: every agent gets the "browser click-through is the last step of UI work" rule.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildBrowserClickthroughBody, ensureBrowserClickthroughSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-clickthrough-probe'
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('browser click-through rule', () => {
  it('names the click-through, the waiting gate and the card comment; no owner or path', () => {
    const b = buildBrowserClickthroughBody()
    expect(b).toContain('VEGIGKATTINTAS')
    expect(b).toContain('waiting')
    expect(b).toContain('kommentben')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('appends once, idempotently, keeping the rest of the file', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    writeFileSync(path, '# probe\n\nSajat tartalom.\n')
    expect(ensureBrowserClickthroughSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(once).toContain('Sajat tartalom.')
    expect(ensureBrowserClickthroughSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
  })
  it('skips the main agent and agents without a CLAUDE.md', () => {
    expect(ensureBrowserClickthroughSection(MAIN_AGENT_ID)).toBe('skipped-main')
    expect(ensureBrowserClickthroughSection(THROWAWAY)).toBe('no-file')
  })
  it('the global seed skill exists with scope: global and is named in the two card skills', () => {
    const skill = readFileSync(join(PROJECT_ROOT, 'seed-skills/browser-clickthrough-before-done/SKILL.md'), 'utf-8')
    expect(skill).toMatch(/^scope: global$/m)
    for (const f of ['card-done-to-waiting', 'kanban-approval-workflow']) {
      expect(readFileSync(join(PROJECT_ROOT, 'seed-skills', f, 'SKILL.md'), 'utf-8')).toContain('browser-clickthrough-before-done')
    }
    expect(existsSync(join(PROJECT_ROOT, 'templates/CLAUDE.md.template'))).toBe(true)
    expect(readFileSync(join(PROJECT_ROOT, 'templates/CLAUDE.md.template'), 'utf-8')).toContain('ensureBrowserClickthroughSection')
  })
})
