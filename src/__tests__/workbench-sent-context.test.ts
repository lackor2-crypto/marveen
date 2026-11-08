// Boss, 2026-11-08: the day a document went out is written into the item's context file (Log section).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { sweepItemContexts, readItemContext } from '../workbench-item-context.js'
import { markSentManually } from '../workbench-docsent.js'
import { noteSentInContext, sentLogLine } from '../workbench-sent-context.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let itemId = ''
beforeEach(async () => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-sentctx-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  if (!updateProject(p.project.id, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Nemet'), { recursive: true })
  const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: p.project.id, type: 'document', title: 'Level a hivatalnak' })
  itemId = c.body.item.id as string
  await sweepItemContexts()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('the sending day lands in the context file', () => {
  it('marking an item sent writes today into the Log, once', () => {
    markSentManually(itemId, 'teszt')
    markSentManually(itemId, 'teszt')
    const text = readItemContext(getWorkItem(itemId)!)!.text
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(text).toContain(today)
    expect(text).toContain('Level a hivatalnak')
    expect(text.split('Level a hivatalnak').length - 1).toBeGreaterThanOrEqual(1)
    expect(text.match(new RegExp(`- ${today}: `, 'g'))!.length).toBe(1)
  })
  it('a recorded sending carries its own date and recipient', () => {
    const ok = noteSentInContext({ itemId, date: '2026-11-03', recipient: 'minijob@minijob-zentrale.de', how: 'recorded', by: null })
    expect(ok).toBe(true)
    const text = readItemContext(getWorkItem(itemId)!)!.text
    expect(text).toContain(sentLogLine('Level a hivatalnak', { date: '2026-11-03', recipient: 'minijob@minijob-zentrale.de', how: 'recorded' }))
    expect(text).toContain('2026-11-03')
  })
})
