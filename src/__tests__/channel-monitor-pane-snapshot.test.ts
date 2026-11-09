import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The monitor tick used to fork tmux synchronously twice per target. The two
// detection passes must read one shared async snapshot instead.
describe('channel monitor tick takes one async pane snapshot', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
  it('builds the snapshot with capturePaneAsync', () => {
    expect(src).toContain('const paneSnapshot = new Map<string, string | null>()')
    expect(src).toContain('await capturePaneAsync(t.session)')
  })
  it('both per-target detection passes read the snapshot, not capturePane', () => {
    expect(src.match(/const pane = paneSnapshot\.get\(t\.session\) \?\? null/g)?.length).toBe(2)
    expect(src).not.toMatch(/for \(const t of targets\) \{\n\s+const pane = capturePane\(t\.session\)/)
  })
})
