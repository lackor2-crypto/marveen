// #746: a file moved to the Life tree leaves a linked file at its old place. When a NEW file with the same name is put at
// that place afterwards (a re-upload), the link must not hide it: the real file wins, the second move carries the NEW file,
// and the older copy in the Life tree stays untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-reupload-store-'))
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
const { fileMountsInside, resolveMount } = await import('../life-mounts.js')
const { resolveLifePath } = await import('../life-explorer.js')

describe('#746: a same-name re-upload at the place of a left-behind link', () => {
  let depot = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-reupload-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    rmSync(join(store, 'life-mounts.json'), { force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function setup(): { project: any; item: any; dir: string } {
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
    mkdirSync(join(depot, 'Cel'), { recursive: true })
    mkdirSync(join(depot, 'Cel2'), { recursive: true })
    return { project, item, dir }
  }

  function firstMove(project: any, item: any): string {
    const c = lifeMoveCandidates(project, item, 'include')
    if (!c.ok) throw new Error('candidates')
    const old = c.files.find((x) => x.name === 'antrag.pdf')
    if (!old) throw new Error('no candidate')
    const r = moveItemFilesToLife(project, item, [{ rel: old.rel, target: 'Cel' }], 'hu', 'include')
    if (!r.ok || !r.results[0].ok) throw new Error('first move')
    return old.rel
  }

  it('the real file at the link place is what the place resolves to, not the older Life-tree copy', () => {
    const { project, item, dir } = setup()
    const rel = firstMove(project, item)
    expect(readFileSync(resolveLifePath(rel) as string, 'utf8')).toBe('v1') // the link leads to the moved copy
    writeFileSync(join(dir, 'antrag.pdf'), 'v2') // the re-upload
    expect(readFileSync(resolveLifePath(rel) as string, 'utf8')).toBe('v2')
  })

  it('the second move carries the NEW file, leaves the older copy alone, and the link now leads to the new place', () => {
    const { project, item, dir } = setup()
    const rel = firstMove(project, item)
    writeFileSync(join(dir, 'antrag.pdf'), 'v2')
    const c = lifeMoveCandidates(project, item, 'include')
    if (!c.ok) throw new Error('candidates')
    expect(c.files.map((x) => x.rel)).toContain(rel)
    const r = moveItemFilesToLife(project, item, [{ rel, target: 'Cel2' }], 'hu', 'include')
    if (!r.ok) throw new Error('move')
    expect(r.results[0].ok).toBe(true)
    expect(readFileSync(join(depot, 'Cel2', 'antrag.pdf'), 'utf8')).toBe('v2')
    expect(readFileSync(join(depot, 'Cel', 'antrag.pdf'), 'utf8')).toBe('v1')
    expect(existsSync(join(dir, 'antrag.pdf'))).toBe(false)
    const parent = rel.slice(0, rel.lastIndexOf('/'))
    expect(fileMountsInside(parent).map((m) => m.rel)).toEqual([rel])
    expect(resolveMount(rel)?.target).toBe('Cel2/antrag.pdf')
  })

  // Boss TG 3686: a same-name clash no longer leaves the project file behind. Other bytes: it moves next to the older one
  // under a numbered name (nothing overwritten, nothing lost) and a link stays; the same bytes: the project copy goes to
  // the Trash and the link points at the file that is already there.
  it('a second move into the SAME folder with OTHER content keeps both: the new file gets a number, the old one is untouched, a link stays', () => {
    const { project, item, dir } = setup()
    const rel = firstMove(project, item)
    writeFileSync(join(dir, 'antrag.pdf'), 'v2')
    const r = moveItemFilesToLife(project, item, [{ rel, target: 'Cel' }], 'hu', 'include')
    if (!r.ok) throw new Error('move')
    expect(r.results[0].ok).toBe(true)
    expect(readFileSync(join(depot, 'Cel', 'antrag.pdf'), 'utf8')).toBe('v1')
    expect(readFileSync(join(depot, 'Cel', 'antrag (2).pdf'), 'utf8')).toBe('v2')
    expect(existsSync(join(dir, 'antrag.pdf'))).toBe(false)
    expect(resolveMount(rel)?.target).toBe('Cel/antrag (2).pdf')
  })

  it('a second move into the SAME folder with the SAME content trashes the project copy and the link points at the existing file', () => {
    const { project, item, dir } = setup()
    const rel = firstMove(project, item)
    writeFileSync(join(dir, 'antrag.pdf'), 'v1')
    const r = moveItemFilesToLife(project, item, [{ rel, target: 'Cel' }], 'hu', 'include')
    if (!r.ok) throw new Error('move')
    expect(r.results[0].ok).toBe(true)
    expect(existsSync(join(depot, 'Cel', 'antrag (2).pdf'))).toBe(false)
    expect(existsSync(join(dir, 'antrag.pdf'))).toBe(false)
    expect(readFileSync(join(depot, 'Cel', 'antrag.pdf'), 'utf8')).toBe('v1')
    expect(resolveMount(rel)?.target).toBe('Cel/antrag.pdf')
  })

  it('the work folder lists the re-uploaded file once, as a real file, not as the link', () => {
    const { project, item, dir } = setup()
    const rel = firstMove(project, item)
    writeFileSync(join(dir, 'antrag.pdf'), 'v2')
    const wf = listWorkFolders(project, { outside: false })
    const parent = rel.slice(0, rel.lastIndexOf('/'))
    const key = (wf.box as string) + parent.slice(parent.indexOf('/Munkadarabok') + '/Munkadarabok'.length)
    expect((wf.files[key] || []).filter((x) => x.name === 'antrag.pdf').map((x) => !!x.linked)).toEqual([false])
  })
})
