// #749: the target folder of the Life-tree move can lie BEHIND a linked folder (a mount: Drive, Photos ...). The file moved
// there; the old place must still get its link (pointing at the REAL place of the file), and when no link could be left
// the answer says so instead of staying silent.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-reupload-store-'))
// lets one test make the link-making fail (the way a full or read-only store would)
const flags = vi.hoisted(() => ({ failAddMount: false }))
vi.mock('../life-mounts.js', async () => {
  const actual = await vi.importActual<typeof import('../life-mounts.js')>('../life-mounts.js')
  return { ...actual, addMount: (...a: Parameters<typeof actual.addMount>) => flags.failAddMount ? { ok: false, code: 'forced', message: 'forced failure' } : actual.addMount(...a) }
})
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { initDatabase } = await import('../db.js')
const { createProject, updateProject, getProject } = await import('../projects.js')
const { createWorkItem, getWorkItem } = await import('../workbench.js')
const { ensureWorkItemFolder, listWorkFolders } = await import('../workbench-assets.js')
const { lifeMoveCandidates, moveItemFilesToLife } = await import('../workbench-life-move.js')
const { markSentManually } = await import('../workbench-docsent.js')
const { addMount, fileMountsInside, resolveMount } = await import('../life-mounts.js')
const { resolveLifePath } = await import('../life-explorer.js')

describe('#749: a target folder behind a mount', () => {
  let depot = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-mounttarget-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    rmSync(join(store, 'life-mounts.json'), { force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function setup(): { project: any; item: any; dir: string; rel: string } {
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const project = getProject(p.project.id) as any
    const w = createWorkItem({ project_id: p.project.id, title: 'Antrag', type: 'note' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    const dir = join(depot, 'Projektek', 'Iroda', f.folder, 'Elkészített anyagok')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'antrag.pdf'), 'v1')
    const item = getWorkItem(w.item.id) as any
    markSentManually(item.id, null)
    // 'Család/Anna/Dokumentumok' shows what really lies in 'drive/anna/Dokumentumok'
    mkdirSync(join(depot, 'drive', 'anna', 'Dokumentumok', 'Hivatalos'), { recursive: true })
    const m = addMount({ rel: 'Család/Anna/Dokumentumok', target: 'drive/anna/Dokumentumok', kind: 'drive', label: 'Anna Drive' })
    if (!m.ok) throw new Error('mount ' + m.message)
    const c = lifeMoveCandidates(project, item, 'include')
    if (!c.ok) throw new Error('candidates')
    const old = c.files.find((x) => x.name === 'antrag.pdf')
    if (!old) throw new Error('no candidate')
    return { project, item, dir, rel: old.rel }
  }

  it('the file stands behind the mount and the old place shows a link that leads to its REAL place', () => {
    const { project, item, dir, rel } = setup()
    const r = moveItemFilesToLife(project, item, [{ rel, target: 'Család/Anna/Dokumentumok/Hivatalos' }], 'hu', 'include')
    if (!r.ok) throw new Error('move')
    expect(r.results[0].ok).toBe(true)
    expect(r.results[0].link_left).toBe(true)
    expect(readFileSync(join(depot, 'drive', 'anna', 'Dokumentumok', 'Hivatalos', 'antrag.pdf'), 'utf8')).toBe('v1')
    expect(existsSync(join(dir, 'antrag.pdf'))).toBe(false)
    const parent = rel.slice(0, rel.lastIndexOf('/'))
    expect(fileMountsInside(parent).map((m) => m.rel)).toEqual([rel])
    expect(resolveMount(rel)?.target).toBe('drive/anna/Dokumentumok/Hivatalos/antrag.pdf')
    expect(readFileSync(resolveLifePath(rel) as string, 'utf8')).toBe('v1')
  })

  it('a link that could not be left is reported, the move itself still counts', () => {
    const { project, item, rel } = setup()
    flags.failAddMount = true
    const r = moveItemFilesToLife(project, item, [{ rel, target: 'Család/Anna/Dokumentumok/Hivatalos' }], 'hu', 'include')
    if (!r.ok) throw new Error('move')
    expect(r.results[0].ok).toBe(true)
    flags.failAddMount = false
    expect(r.results[0].link_left).toBe(false)
  })
})
