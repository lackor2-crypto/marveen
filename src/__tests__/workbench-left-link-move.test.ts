// #745: the linked file the Life-tree move leaves at the old place is a pointer. Moving or renaming it in the
// Workbench list (or in the Explorer) moves only the link; the real file stays in the Life tree.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-leftlink-mv-store-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { initDatabase } = await import('../db.js')
const { createProject, updateProject, getProject } = await import('../projects.js')
const { createWorkItem, getWorkItem } = await import('../workbench.js')
const { ensureWorkItemFolder, moveLooseFiles, renameLooseFile } = await import('../workbench-assets.js')
const { lifeMoveCandidates, moveItemFilesToLife } = await import('../workbench-life-move.js')
const { markSentManually } = await import('../workbench-docsent.js')
const { resolveMount, isFileMount } = await import('../life-mounts.js')
const { moveMountPoint, renameMountPoint } = await import('../life-follow.js')

describe('#745: moving or renaming the left-behind link never carries off the Life-tree file', () => {
  let depot = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-leftlink-mv-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    rmSync(join(store, 'life-mounts.json'), { force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  /** A sent item whose final PDF went to the Life tree ('Cel'); returns the link's tree path. */
  function leaveLink() {
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
    const old = c.files.find((x) => x.name === 'antrag.pdf')!
    const r = moveItemFilesToLife(project, item, [{ rel: old.rel, target: 'Cel' }], 'hu', 'include')
    if (!r.ok || !r.results[0].ok) throw new Error('move')
    expect(isFileMount(old.rel)).toBe(true)
    return { project, link: old.rel }
  }
  const lifeFile = () => join(depot, 'Cel', 'antrag.pdf')

  it('the Workbench move takes the link to the new folder, the Life-tree file stays', () => {
    const { project, link } = leaveLink()
    const r = moveLooseFiles(project, [link], '', { allowItem: true })
    if (!r.ok) throw new Error(r.code)
    expect(r.moved).toEqual(['antrag.pdf'])
    expect(existsSync(lifeFile())).toBe(true)
    expect(isFileMount(link)).toBe(false)
    const box = link.slice(0, link.indexOf('/Munkadarabok') + '/Munkadarabok'.length)
    expect(resolveMount(`${box}/antrag.pdf`)?.target).toBe('Cel/antrag.pdf')
    // no real file appeared beside the link
    expect(existsSync(join(depot, ...box.split('/'), 'antrag.pdf'))).toBe(false)
  })

  it('the Workbench rename renames the link, the Life-tree file keeps its name', () => {
    const { project, link } = leaveLink()
    const r = renameLooseFile(project, link, 'kuldott.pdf')
    expect(r).toEqual({ ok: true, name: 'kuldott.pdf', renamed: true })
    expect(existsSync(lifeFile())).toBe(true)
    const to = link.slice(0, link.lastIndexOf('/') + 1) + 'kuldott.pdf'
    expect(resolveMount(to)?.target).toBe('Cel/antrag.pdf')
    expect(isFileMount(link)).toBe(false)
  })

  it('the Explorer move and rename of a linked file make no empty folder in its place', () => {
    const { link } = leaveLink()
    const r = renameMountPoint(link, 'masik.pdf')
    if (!r.ok) throw new Error(r.code)
    expect(existsSync(join(depot, ...r.rel.split('/')))).toBe(false)
    expect(existsSync(lifeFile())).toBe(true)
    const m = moveMountPoint(r.rel, 'Projektek/Iroda')
    if (!m.ok) throw new Error(m.code)
    expect(m.rel).toBe('Projektek/Iroda/masik.pdf')
    expect(existsSync(join(depot, 'Projektek', 'Iroda', 'masik.pdf'))).toBe(false)
    expect(statSync(lifeFile()).isFile()).toBe(true)
    expect(resolveMount('Projektek/Iroda/masik.pdf')?.target).toBe('Cel/antrag.pdf')
  })
})
