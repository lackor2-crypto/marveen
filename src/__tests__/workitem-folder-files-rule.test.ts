// Boss TG 4287: a work item folder holds ONLY the Kontextus and Teendo files. Every agent gets the rule.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildWorkItemFolderFilesBody, ensureWorkItemFolderFilesSection } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-item-folder-files-probe'
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('work item folder files rule', () => {
  it('names the rule, no owner name or path', () => {
    const b = buildWorkItemFolderFilesBody()
    expect(b).toContain('KONTEXTUS')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('appends once, idempotently; skips main agent and agents without CLAUDE.md', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    expect(ensureWorkItemFolderFilesSection(THROWAWAY)).toBe('no-file')
    writeFileSync(path, '# probe\n\nSajat.\n')
    expect(ensureWorkItemFolderFilesSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(ensureWorkItemFolderFilesSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(ensureWorkItemFolderFilesSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })
  it('is in the workbench agent prompt, the template, the skills and the wiring', () => {
    expect(readFileSync(join(PROJECT_ROOT, 'src/workbench-agent/context.ts'), 'utf-8')).toContain('ONLY THE CONTEXT FILE')
    expect(readFileSync(join(PROJECT_ROOT, 'templates/CLAUDE.md.template'), 'utf-8')).toContain('ensureWorkItemFolderFilesSection')
    expect(readFileSync(join(PROJECT_ROOT, 'seed-skills/marveen-learned-rules/SKILL.md'), 'utf-8')).toContain('### R24')
    expect(readFileSync(join(PROJECT_ROOT, 'src/web.ts'), 'utf-8')).toContain('ensureGlobalWorkItemFolderFilesRule()')
    expect(readFileSync(join(PROJECT_ROOT, 'src/web/agent-process.ts'), 'utf-8')).toContain('ensureWorkItemFolderFilesSection(name)')
  })
})
