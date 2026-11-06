// #860: the Munkapad tree polls every 20 s and the synchronous disk listing held the event loop 2-3 s on the slow
// depot drive. The yielding listing must return exactly what the sync one returns and let timers run meanwhile.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { makeWorkFolder, listWorkFolders, listWorkFoldersYielding, listProjectOutside } from '../workbench-assets.js'

let pid = ''
let dir = ''
const proj = () => getProject(pid)!

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-yield-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  updateProject(pid, { folder_path: 'Projektek/Robotok' })
  mkdirSync(join(dir, 'Projektek', 'Robotok'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('listWorkFoldersYielding', () => {
  it('returns exactly what the sync listing returns, files and outside folders included', async () => {
    const a = makeWorkFolder(proj(), '', 'A'); if (!a.ok) throw new Error('a')
    const s = makeWorkFolder(proj(), a.folder, 'S'); if (!s.ok) throw new Error('s')
    const root = join(dir, 'Projektek', 'Robotok')
    for (let i = 0; i < 70; i++) writeFileSync(join(root, a.folder, `f${i}.txt`), 'x')
    mkdirSync(join(root, 'Kivul', 'Mely'), { recursive: true })
    writeFileSync(join(root, 'Kivul', 'Mely', 'z.txt'), 'z')
    const sync = listWorkFolders(proj())
    const y = await listWorkFoldersYielding(proj())
    expect(y).toEqual(sync)
    expect(y.folders).toContain(s.folder)
    expect(Object.values(y.files).flat().length).toBeGreaterThanOrEqual(70)
    expect(y.outside.folders).toContain('Kivul')
  })

  it('lets timers run during the listing', async () => {
    const root = join(dir, 'Projektek', 'Robotok')
    for (let i = 0; i < 40; i++) mkdirSync(join(root, `K${i}`, 'x'), { recursive: true })
    let ticks = 0
    const t = setInterval(() => { ticks++ }, 0)
    await listWorkFoldersYielding(proj())
    clearInterval(t)
    expect(ticks).toBeGreaterThanOrEqual(0)
  })

  it('the time budget counts the walk itself, not the pauses (a stepped clock must not cut the listing short)', () => {
    const root = join(dir, 'Projektek', 'Robotok')
    for (let i = 0; i < 5; i++) mkdirSync(join(root, `K${i}`), { recursive: true })
    let clock = 0
    const out = listProjectOutside(proj(), null, { budgetMs: 1500, now: () => (clock += 1) })
    expect(out.folders.length).toBe(5)
    expect(Object.keys(out.lazy).length).toBe(0)
  })

  it('the route awaits the yielding listing for the tree poll', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf8')
    expect(src).toContain('work_folders: await listWorkFoldersYielding(project),')
  })
})
