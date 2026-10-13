// The Explorer follows the disk by itself (owner, 2026-10-13: an upload or a link made elsewhere must show without
// F5). web/app.js is one big script, so this is a source contract: the timer exists, starts with the page, asks only
// while it is safe, and draws only when the listing differs.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
const body = (name: string) => {
  const at = app.indexOf(`async function ${name}(`)
  expect(at).toBeGreaterThan(0)
  return app.slice(at, at + 1400)
}

describe('Intezo auto refresh', () => {
  it('starts with the page and runs every 20 s', () => {
    expect(app).toMatch(/const INTEZO_AUTO_MS = 20000/)
    expect(app).toMatch(/setInterval\(\(\) => \{ void _intezoAutoTick\(\) \}, INTEZO_AUTO_MS\)/)
    expect(app).toMatch(/_dupRefreshStatus\(\)\n  _intezoAutoStart\(\)/)
  })

  it('does not ask while hidden, with a menu open, a field focused, or a search shown', () => {
    const b = body('_intezoAutoTick')
    expect(b).toContain('page.hidden || document.hidden')
    expect(b).toContain('_intezoMenuEl')
    expect(b).toMatch(/INPUT\|TEXTAREA\|SELECT/)
    expect(b).toContain('L.searching')
  })

  it('draws only when the fresh listing differs, and drops the stale tree branches', () => {
    const b = body('_intezoAutoTick')
    expect(b).toContain('JSON.stringify(friss) === JSON.stringify(_intezoListing)')
    expect(b).toContain('_intezoTreeKids = new Map()')
    expect(b).toContain('_intezoRender()')
  })
})
