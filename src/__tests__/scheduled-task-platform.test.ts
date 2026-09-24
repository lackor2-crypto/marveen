// Audit f97acc32 G: weekly-system-maintenance cares for the WINDOWS host from
// WSL. It is seeded on every install, so it must carry a platform requirement
// and the runner must skip it anywhere that is not WSL.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRequires, platformSatisfied } from '../web/scheduled-tasks-io.js'

const REPO = join(__dirname, '..', '..')

describe('requires.platform', () => {
  it('parses wsl, ignores anything else, keeps mcp_servers', () => {
    expect(parseRequires({ platform: 'wsl' })).toEqual({ platform: 'wsl' })
    expect(parseRequires({ platform: 'windows' })).toBeUndefined()
    expect(parseRequires({ mcp_servers: ['a'], platform: 'wsl' })).toEqual({ mcp_servers: ['a'], platform: 'wsl' })
    expect(parseRequires({ mcp_servers: ['a'] })).toEqual({ mcp_servers: ['a'] })
    expect(parseRequires(undefined)).toBeUndefined()
  })
  it('a wsl task runs only on wsl; a task without it runs everywhere', () => {
    expect(platformSatisfied({ requires: { platform: 'wsl' } }, () => false)).toBe(false)
    expect(platformSatisfied({ requires: { platform: 'wsl' } }, () => true)).toBe(true)
    expect(platformSatisfied({ requires: undefined }, () => false)).toBe(true)
  })
})

describe('weekly-system-maintenance seed', () => {
  const dir = join(REPO, 'seed-scheduled-tasks', 'weekly-system-maintenance')
  it('is seeded with a wsl requirement and a prompt', () => {
    const cfg = JSON.parse(readFileSync(join(dir, 'task-config.json'), 'utf8'))
    expect(cfg.requires).toEqual({ platform: 'wsl' })
    expect(cfg.schedule).toBe('0 10 * * 0')
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('weekly-system-maintenance')
  })
  it('the skill it calls is seeded too', () => {
    expect(readFileSync(join(REPO, 'seed-skills', 'weekly-system-maintenance', 'SKILL.md'), 'utf8')).toMatch(/scope: global/)
  })
  it('the runner checks the platform on both the cron loop and the retry queue', () => {
    const src = readFileSync(join(REPO, 'src/web/schedule-runner.ts'), 'utf8')
    expect(src.match(/platformSatisfied\(/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
