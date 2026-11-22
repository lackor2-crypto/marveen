import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { sweepItemContexts, isFullSweepDue, itemNeedsLightPass, FULL_SWEEP_MS, RECENT_ITEM_MS } from '../workbench-item-context.js'

// #962: the 3-minute sweep walked every item on the slow drive and stalled the dashboard for up to 1.9 s.
describe('light item-context sweep', () => {
  const now = 10_000_000_000
  // work_items.updated_at is unix SECONDS (nowSec() in workbench.ts), `now` here is milliseconds.
  const sec = (msAgo: number) => Math.floor((now - msAgo) / 1000)
  it('the full pass runs at the first pass and then once an hour', () => {
    expect(isFullSweepDue(0, now)).toBe(true)
    expect(isFullSweepDue(now - 60_000, now)).toBe(false)
    expect(isFullSweepDue(now - FULL_SWEEP_MS, now)).toBe(true)
  })
  it('the light pass takes only fresh or never-handled items', () => {
    expect(itemNeedsLightPass(sec(60_000), true, now)).toBe(true)
    expect(itemNeedsLightPass(sec(RECENT_ITEM_MS + 2000), true, now)).toBe(false)
    expect(itemNeedsLightPass(sec(999_999_999), false, now)).toBe(true)
  })
  it('the sweep loop actually skips old handled items on a light pass', () => {
    const src = readFileSync(fileURLToPath(new URL('../workbench-item-context.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/if \(!full\) \{[\s\S]{0,200}itemNeedsLightPass\(item\.updated_at[\s\S]{0,160}\) continue/)
    expect(itemNeedsLightPass(0, true, now, true)).toBe(true) // a renamed item is followed at once
    expect(src).toMatch(/if \(full\) lastFullSweep = Date\.now\(\)/)
  })
})

// Regression: the light pass compared the DB's seconds-based updated_at with Date.now() milliseconds, so an item changed
// a minute ago was never "recent" and only the hourly full pass ever saw it.
describe('light sweep against the real database (updated_at in seconds)', () => {
  let dir = ''
  let itemId = ''
  beforeEach(async () => {
    initDatabase(':memory:')
    dir = mkdtempSync(join(tmpdir(), 'wb-light-'))
    process.env['MARVEEN_DEPOT'] = dir
    const p = createProject({ name: 'Nemet' })
    if (!p.ok) throw new Error('projekt')
    if (!updateProject(p.project.id, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
    mkdirSync(join(dir, 'Projektek', 'Nemet'), { recursive: true })
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: p.project.id, type: 'document', title: 'Wohngeld hianypotlas' })
    itemId = c.body.item.id as string
    await sweepItemContexts({ full: true }) // item has its row now; a light pass follows (the full one is not due)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  it('an item changed a minute ago is re-checked by the light pass', async () => {
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60, itemId)
    expect((await sweepItemContexts()).items).toBe(1)
  })
  it('an item untouched for a day is skipped by the light pass', async () => {
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 86_400, itemId)
    expect((await sweepItemContexts()).items).toBe(0)
  })
})
