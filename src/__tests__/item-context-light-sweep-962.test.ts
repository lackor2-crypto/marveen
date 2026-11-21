import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isFullSweepDue, itemNeedsLightPass, FULL_SWEEP_MS, RECENT_ITEM_MS } from '../workbench-item-context.js'

// #962: the 3-minute sweep walked every item on the slow drive and stalled the dashboard for up to 1.9 s.
describe('light item-context sweep', () => {
  const now = 10_000_000_000
  it('the full pass runs at the first pass and then once an hour', () => {
    expect(isFullSweepDue(0, now)).toBe(true)
    expect(isFullSweepDue(now - 60_000, now)).toBe(false)
    expect(isFullSweepDue(now - FULL_SWEEP_MS, now)).toBe(true)
  })
  it('the light pass takes only fresh or never-handled items', () => {
    expect(itemNeedsLightPass(now - 60_000, true, now)).toBe(true)
    expect(itemNeedsLightPass(now - RECENT_ITEM_MS - 1, true, now)).toBe(false)
    expect(itemNeedsLightPass(now - 999_999_999, false, now)).toBe(true)
  })
  it('the sweep loop actually skips old handled items on a light pass', () => {
    const src = readFileSync(fileURLToPath(new URL('../workbench-item-context.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/if \(!full\) \{[\s\S]{0,200}itemNeedsLightPass\(item\.updated_at[\s\S]{0,160}\) continue/)
    expect(itemNeedsLightPass(0, true, now, true)).toBe(true) // a renamed item is followed at once
    expect(src).toMatch(/if \(full\) lastFullSweep = Date\.now\(\)/)
  })
})
