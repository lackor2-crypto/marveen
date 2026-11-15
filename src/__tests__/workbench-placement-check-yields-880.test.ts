// #880 (Boss TG 5526): the dashboard froze 3.4 s. The machine placement check (#758) walked the whole project tree
// with the synchronous listing (resolveLifePath <- linkedAnnexRows <- listWorkFolders <- placementIssues <-
// checkPlacementAfter) on the server's only thread. The check, and every work_folders answer of the Workbench
// routes, must use the yielding walk, so timers and other requests run while the disk is read.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { ensureWorkItemFolder } from '../workbench-assets.js'
import { checkPlacementAfter } from '../workbench-placement-check.js'

const REPO = join(__dirname, '..', '..')
let depot = ''
let pid = ''

beforeEach(() => {
  initDatabase(':memory:')
  depot = mkdtempSync(join(tmpdir(), 'wb-place-880-'))
  mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
  process.env['MARVEEN_DEPOT'] = depot
  const p = createProject({ name: 'Iroda' })
  if (!p.ok) throw new Error('project')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('folder')
})
afterEach(() => {
  rmSync(depot, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('the machine placement check does not hold the event loop (#880)', () => {
  it('the event loop gets turns while the check walks a project tree', async () => {
    const w = createWorkItem({ project_id: pid, title: 'Wohngeld 2026', type: 'document' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    const base = join(depot, 'Projektek', 'Iroda')
    for (let i = 0; i < 40; i++) {
      const d = join(base, 'Munkapad', `Mappa ${i}`)
      mkdirSync(d, { recursive: true })
      for (let j = 0; j < 5; j++) writeFileSync(join(d, `f${j}.txt`), 'x')
    }
    let ticks = 0
    let running = true
    const pump = () => { if (!running) return; ticks++; setImmediate(pump) }
    setImmediate(pump)
    const r = await checkPlacementAfter({ ...w.item, folder: f.folder }, 'upload', 'hu')
    running = false
    expect(r.issues).toBeGreaterThanOrEqual(0)
    // a synchronous walk finishes inside the call: not a single turn of the event loop in between
    expect(ticks).toBeGreaterThan(0)
  })

  it('the placement check and the Workbench routes list work folders only through the yielding walk', () => {
    const check = readFileSync(join(REPO, 'src/workbench-placement-check.ts'), 'utf8')
    expect(check).not.toMatch(/\blistWorkFolders\(/)
    expect(check).toMatch(/await listWorkFoldersYielding\(/)
    const routes = readFileSync(join(REPO, 'src/web/routes/workbench.ts'), 'utf8')
    expect(routes).not.toMatch(/\blistWorkFolders\(/)
    // every placement check is awaited
    const calls = routes.match(/checkPlacementAfter\(/g) ?? []
    const awaited = routes.match(/await checkPlacementAfter\(/g) ?? []
    expect(calls.length).toBe(awaited.length)
  })
})
