import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  installKindFromPath, isAvxLessHost, parseCliVersion, updateEnv, updateSlot, isCheckStale, CLAUDE_UPDATE_HOURS,
} from '../claude-cli-updater.js'
import { CLAUDE_MODEL_IDS } from '../claude-models.js'

const ROOT = join(__dirname, '..', '..')

describe('Claude program updater: new models must reach the list (owner, 2026-09-29)', () => {
  it('tells a native install from an npm one', () => {
    expect(installKindFromPath('/home/u/.local/share/claude/versions/2.1.284')).toBe('native')
    expect(installKindFromPath('C:\\Users\\u\\.local\\share\\claude\\versions\\2.1.284')).toBe('native')
    expect(installKindFromPath('/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe')).toBe('npm')
    expect(installKindFromPath(null)).toBe('missing')
  })

  it('never updates a pinned AVX-less host, but does update a normal one', () => {
    expect(isAvxLessHost('flags\t\t: fpu sse sse2')).toBe(true)
    expect(isAvxLessHost('flags\t\t: fpu sse avx avx2')).toBe(false)
    expect(isAvxLessHost('Processor : ARMv8')).toBe(false)
  })

  it('reads the version from `claude --version`', () => {
    expect(parseCliVersion('2.1.284 (Claude Code)')).toBe('2.1.284')
    expect(parseCliVersion('')).toBe('')
  })

  it('strips the fleet-wide autoupdate kill switch from the update call only', () => {
    const env = updateEnv({ DISABLE_AUTOUPDATER: '1', PATH: '/bin' })
    expect(env.DISABLE_AUTOUPDATER).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })

  it('checks at least twice a day, early morning and late evening', () => {
    expect(CLAUDE_UPDATE_HOURS.length).toBeGreaterThanOrEqual(2)
    expect(CLAUDE_UPDATE_HOURS.some((h) => h <= 7)).toBe(true)
    expect(CLAUDE_UPDATE_HOURS.some((h) => h >= 21)).toBe(true)
  })

  it('slots are per hour in the install time zone', () => {
    // 03:10 UTC = 05:10 in Budapest (CEST)
    expect(updateSlot(new Date('2026-09-29T03:10:00Z'), [5], 'Europe/Budapest')).toBe('2026-09-29-5')
    expect(updateSlot(new Date('2026-09-29T05:10:00Z'), [5], 'Europe/Budapest')).toBeNull()
  })

  it('a never-run or old check counts as stale (a box that was off catches up)', () => {
    const now = new Date('2026-09-29T12:00:00Z')
    expect(isCheckStale(undefined, now)).toBe(true)
    expect(isCheckStale('2026-09-28T20:00:00Z', now)).toBe(true)
    expect(isCheckStale('2026-09-29T08:00:00Z', now)).toBe(false)
  })

  it('Sonnet 5.5 is in the curated list', () => {
    expect(CLAUDE_MODEL_IDS).toContain('claude-sonnet-5-5')
  })

  it('is wired: schedule at startup, button route, button in the UI, bilingual', () => {
    const web = readFileSync(join(ROOT, 'src/web.ts'), 'utf-8')
    expect(web).toContain('startClaudeCliUpdateScheduler()')
    const routes = readFileSync(join(ROOT, 'src/web/routes/agents.ts'), 'utf-8')
    expect(routes).toContain("path === '/api/models/refresh' && method === 'POST'")
    // A re-measure must make new ids savable, not only visible.
    expect(routes).toMatch(/scanInstalledClaude\(\)\s*\n[\s\S]{0,200}registerDiscoveredClaudeModels/)
    const html = readFileSync(join(ROOT, 'web/index.html'), 'utf-8')
    expect(html).toContain('id="modelRefreshBtn"')
    const app = readFileSync(join(ROOT, 'web/app.js'), 'utf-8')
    expect(app).toContain("fetch('/api/models/refresh', { method: 'POST' })")
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      expect(readFileSync(join(ROOT, f), 'utf-8')).toContain("'agents.model.refresh_btn'")
    }
  })
})
