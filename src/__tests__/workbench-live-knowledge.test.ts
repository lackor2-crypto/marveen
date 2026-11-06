import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveKnowledgeArgs } from '../web/routes/workbench-agent.js'

// Boss, TG 5059: the project chat agent must know what the Telegram agent knows (rules + skills).
describe('liveKnowledgeArgs', () => {
  it('hands over the CLAUDE.md files and the shared skills, never a Telegram channel', () => {
    const base = mkdtempSync(join(tmpdir(), 'live-know-'))
    const home = join(base, 'home'); const root = join(base, 'root'); const dir = join(base, 'dir')
    mkdirSync(join(home, '.claude', 'skills', 'demo'), { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'GLOBAL-RULE')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'CLAUDE.md'), 'PROJECT-RULE')
    const args = liveKnowledgeArgs(dir, home, root)
    const rules = args[args.indexOf('--append-system-prompt-file') + 1]
    const text = readFileSync(rules, 'utf8')
    expect(text).toContain('GLOBAL-RULE')
    expect(text).toContain('PROJECT-RULE')
    expect(text.indexOf('GLOBAL-RULE')).toBeLessThan(text.indexOf('PROJECT-RULE'))
    const plug = args[args.indexOf('--plugin-dir') + 1]
    expect(lstatSync(join(plug, 'skills')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(plug, 'skills', 'demo'))).toBe(true)
    expect(existsSync(join(plug, '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(args.join(' ')).not.toMatch(/telegram|--mcp-config|--setting-sources/i)
    // idempotent: a second call keeps working with the link already there
    expect(liveKnowledgeArgs(dir, home, root)).toEqual(args)
  })
  it('starts without them (no throw) when nothing exists', () => {
    const base = mkdtempSync(join(tmpdir(), 'live-know-'))
    expect(liveKnowledgeArgs(join(base, 'd'), join(base, 'h'), join(base, 'r'))).toEqual([])
  })
})
