// #741 (Boss TG 4147): after the Life-tree move the old place must not stay empty: a linked file (#601) is left there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-leftlink-store-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { initDatabase } = await import('../db.js')
const { createProject, updateProject, getProject } = await import('../projects.js')
const { createWorkItem, getWorkItem } = await import('../workbench.js')
const { ensureWorkItemFolder } = await import('../workbench-assets.js')
const { lifeMoveCandidates, moveItemFilesToLife } = await import('../workbench-life-move.js')
const { markSentManually } = await import('../workbench-docsent.js')
const { fileMountsInside, resolveMount } = await import('../life-mounts.js')

describe('#741: the Life-tree move leaves a link behind', () => {
  let depot = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-leftlink-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    rmSync(join(store, 'life-mounts.json'), { force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('the moved file stands in the Life tree and its old place shows a linked file that leads there', () => {
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const project = getProject(p.project.id) as any
    const w = createWorkItem({ project_id: p.project.id, title: 'Antrag', type: 'note' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    const dir = join(depot, 'Projektek', 'Iroda', f.folder)
    mkdirSync(join(dir, 'Elkészített anyagok'), { recursive: true })
    writeFileSync(join(dir, 'Elkészített anyagok', 'antrag.pdf'), 'pdf')
    const item = getWorkItem(w.item.id) as any
    markSentManually(item.id, null)
    mkdirSync(join(depot, 'Cel'), { recursive: true })
    const c = lifeMoveCandidates(project, item, 'include')
    if (!c.ok) throw new Error('candidates')
    const old = c.files.find((x) => x.name === 'antrag.pdf')
    expect(old).toBeTruthy()
    const r = moveItemFilesToLife(project, item, [{ rel: old!.rel, target: 'Cel' }], 'hu', 'include')
    if (!r.ok) throw new Error('move')
    expect(r.results[0].ok).toBe(true)
    expect(existsSync(join(depot, 'Cel', 'antrag.pdf'))).toBe(true)
    const parent = old!.rel.slice(0, old!.rel.lastIndexOf('/'))
    const links = fileMountsInside(parent)
    expect(links.map((m) => m.rel)).toEqual([old!.rel])
    expect(resolveMount(old!.rel)?.target).toContain('Cel')
  })
})
