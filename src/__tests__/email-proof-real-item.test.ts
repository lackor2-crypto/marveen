// #890: behavioural proof (no source-string wiring) on a REAL work item made through the route: a new work item gets its
// own empty "Feladási bizonylatok" folder by itself, and the owner's "sent by e-mail" hand mark leaves the text proof there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_LANG: 'hu' }))
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { markSentManually } from '../workbench-docsent.js'
import { workItemFolder } from '../workbench-assets.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let itemId = ''
let projectId = ''
beforeEach(async () => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-mailproof-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('project')
  projectId = p.project.id
  if (!updateProject(projectId, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('project folder')
  mkdirSync(join(dir, 'Projektek', 'Nemet'), { recursive: true })
  const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: projectId, type: 'document', title: 'Level a hivatalnak' })
  itemId = c.body.item.id as string
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('proof-of-submission folder + e-mail proof on a real work item', () => {
  it('a new work item has its own empty proof folder, and no project-level one appears', () => {
    const folder = workItemFolder(itemId)
    expect(folder).toBeTruthy()
    const proof = join(dir, 'Projektek', 'Nemet', folder!, 'Feladási bizonylatok')
    expect(existsSync(proof)).toBe(true)
    expect(readdirSync(proof)).toEqual([])
    expect(existsSync(join(dir, 'Projektek', 'Nemet', 'Feladási bizonylatok'))).toBe(false)
  })

  it('the hand mark "sent by e-mail" writes a text proof there, a non-e-mail mark writes none', () => {
    const proof = join(dir, 'Projektek', 'Nemet', workItemFolder(itemId)!, 'Feladási bizonylatok')
    markSentManually(itemId, 'teszt', { method: 'post', date: '2026-11-09', recipient: 'Amtsgericht' })
    expect(readdirSync(proof)).toEqual([])
    markSentManually(itemId, 'teszt', { method: 'email', date: '2026-11-09', recipient: 'poststelle@sg.example.de' })
    const files = readdirSync(proof)
    expect(files.length).toBe(1)
    expect(files[0]).toContain('poststelle@sg.example.de')
    const text = readFileSync(join(proof, files[0]!), 'utf8')
    expect(text).toContain('poststelle@sg.example.de')
    expect(text).toContain('2026-11-09')
    expect(text).toContain('Level a hivatalnak')
  })
})
