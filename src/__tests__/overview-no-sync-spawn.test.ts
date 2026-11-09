import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #888: GET /api/overview forked tmux synchronously per account (usage readout, logged-out check) and showed up in the
// stall log. The forks must stay async.
const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'overview.ts'), 'utf8')

describe('overview route does not block the event loop with child processes', () => {
  it('uses no execFileSync / execSync / spawnSync', () => {
    expect(src).not.toMatch(/execFileSync|execSync|spawnSync/)
  })
  it('awaits the usage readout and the logged-out check', () => {
    expect(src).toContain('await accountSessionLoggedOut(')
    expect(src).toContain('await scrapeClaudeAccountUsage(MAIN_AGENT_ID)')
  })
})
