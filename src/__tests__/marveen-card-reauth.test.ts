import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf-8')

// Boss 2026-10-16: the main agent's card said "online" while its pane read "Not logged in".
describe('main agent card reports a needed login', () => {
  it('/api/marveen carries the reauth fields', () => {
    const src = read('src/web/routes/marveen.ts')
    expect(src).toContain('...mainAgentReauth()')
    expect(src).toContain('reconcileReauthWithDisk(MAIN_AGENT_ID')
  })
  it('the card draws the login banner and drops the fixed online dot', () => {
    const app = read('web/app.js')
    expect(app).toContain("m.needsReauth ? 'disconnected' : 'connected'")
    expect(app).toContain('${m.needsReauth ? `')
  })
})
