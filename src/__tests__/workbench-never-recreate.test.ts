// #681 (Boss TG 9548): a folder the app makes by itself is made ONCE. What the owner deletes stays deleted: not by
// opening, syncing, the startup sweep, a write, a debate report or a new item.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { attachAsset, ensureWorkItemFolder, ensureAllAttachmentsFolders, makeWorkFolder, projectWorkItemsFolder, projectMaterialsFolder } from '../workbench-assets.js'
import { attachmentsFolderFor, uploadsFolderFor, agentRefsFolderFor, versionsFolderFor } from '../project-files.js'
import { createReportDocument } from '../debate-export-doc.js'

describe('a deleted folder is never made again', () => {
  let depot = ''
  let pid = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const dirs = (rel: string) => readdirSync(join(projDir(), rel), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  const project = () => getProject(pid)!

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-once-'))
    mkdirSync(projDir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('folder')
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const item = (title: string) => {
    const w = createWorkItem({ project_id: pid, title, type: 'document' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    return { w: w.item, folder: f.folder }
  }

  it('a standard subfolder deleted by the owner does not return on reopen, on the startup sweep or on a write', () => {
    const { w, folder } = item('Wohngeld')
    expect(dirs(folder)).toContain('Mellékletek')
    rmSync(join(projDir(), folder, 'Mellékletek'), { recursive: true })
    rmSync(join(projDir(), folder, 'Agent'), { recursive: true })
    ensureWorkItemFolder(w)
    ensureAllAttachmentsFolders()
    expect(attachmentsFolderFor(project(), folder)).toBeNull()
    expect(agentRefsFolderFor(project(), folder)).toBeNull()
    expect(dirs(folder)).not.toContain('Mellékletek')
    expect(dirs(folder)).not.toContain('Agent')
  })

  it('a folder from before the registry (made by the old code) is remembered by the startup sweep', () => {
    const { folder } = item('Régi')
    getDb().exec('DELETE FROM auto_folders_made')
    ensureAllAttachmentsFolders() // sees the folders and writes them down
    rmSync(join(projDir(), folder, 'Feltöltések'), { recursive: true })
    expect(uploadsFolderFor(project(), folder)).toBeNull()
    expect(dirs(folder)).not.toContain('Feltöltések')
  })

  it('the versions folder is made once; deleted, the file goes into the item folder', () => {
    const { folder } = item('Verziós')
    expect(versionsFolderFor(project(), folder, true)).toBe(`${folder}/Verziók`)
    rmSync(join(projDir(), folder, 'Verziók'), { recursive: true })
    expect(versionsFolderFor(project(), folder, true)).toBe(folder)
    expect(existsSync(join(projDir(), folder, 'Verziók'))).toBe(false)
  })

  it('a deleted item folder is not made again by opening or syncing (no fresh "Name (2)" either)', () => {
    const { w, folder } = item('Eltűnő')
    rmSync(join(projDir(), folder), { recursive: true })
    const again = ensureWorkItemFolder(w)
    expect(again.ok).toBe(false)
    expect(existsSync(join(projDir(), folder))).toBe(false)
    expect(readdirSync(join(projDir(), 'Munkadarabok'))).not.toContain('Eltűnő (2)')
  })

  // #681 B (Boss TG 9567): an explicit upload carries content, so it makes the ONE folder it needs again; opening and
  // syncing still make nothing.
  it('an upload into a deleted item folder makes that one folder again (not an error); opening still does not', () => {
    const { w, folder } = item('Feltöltős')
    rmSync(join(projDir(), folder), { recursive: true })
    expect(ensureWorkItemFolder(w).ok).toBe(false)
    ensureAllAttachmentsFolders()
    expect(existsSync(join(projDir(), folder))).toBe(false)
    const up = attachAsset(w, 'jegyzet.md', Buffer.from('X'), { remake: true })
    expect(up.ok).toBe(true)
    expect(existsSync(join(projDir(), folder))).toBe(true)
    expect(readdirSync(join(projDir(), 'Munkadarabok'))).not.toContain('Feltöltős (2)')
    // only the folder the file needs: the empty standard subfolders do not come back with it
    expect(dirs(folder)).not.toContain('Mellékletek')
    expect(dirs(folder)).not.toContain('Vitáztatás')
  })

  it('an upload into a deleted Uploads folder makes just that folder; without the explicit flag the file lands in the item folder', () => {
    const { w, folder } = item('Feltöltős2')
    const first = attachAsset(w, 'a.md', Buffer.from('A'), { remake: true })
    expect(first.ok).toBe(true)
    rmSync(join(projDir(), folder, 'Feltöltések'), { recursive: true })
    const auto = attachAsset(w, 'b.md', Buffer.from('B'))
    expect(auto.ok).toBe(true)
    expect(dirs(folder)).not.toContain('Feltöltések')
    const up = attachAsset(w, 'c.md', Buffer.from('C'), { remake: true })
    expect(up.ok).toBe(true)
    expect(dirs(folder)).toContain('Feltöltések')
  })

  it('a deleted box is not made again; a new item goes into the project folder, and an upload target is refused', () => {
    item('Egy')
    rmSync(join(projDir(), 'Munkadarabok'), { recursive: true })
    rmSync(join(projDir(), 'Tovabbi anyagok'), { recursive: true, force: true })
    rmSync(join(projDir(), 'További anyagok'), { recursive: true, force: true })
    ensureAllAttachmentsFolders()
    expect(projectWorkItemsFolder(project()).ok).toBe(false)
    const mf = makeWorkFolder(project(), '', 'Új munka', { own: true })
    expect(mf.ok).toBe(true)
    expect(existsSync(join(projDir(), 'Munkadarabok'))).toBe(false)
    expect(existsSync(join(projDir(), 'Új munka'))).toBe(true)
    void projectMaterialsFolder
  })

  it('a picked parent that vanished is refused as gone, not rebuilt', () => {
    const a = makeWorkFolder(project(), '', 'Csoport')
    if (!a.ok) throw new Error('group')
    rmSync(join(projDir(), a.folder), { recursive: true })
    const r = makeWorkFolder(project(), a.folder, 'Alcsoport')
    expect(r.ok).toBe(false)
    expect(existsSync(join(projDir(), a.folder))).toBe(false)
  })

  it('a debate report whose Vitáztatás folder was deleted lands in the item folder, the folder does not return', () => {
    const { w, folder } = item('Vitás')
    const mk = () => createReportDocument(pid, { title: 'Jelentés', sections: [{ title: 'S', paragraphs: ['p'] }] } as never, 'test', { originItem: w.id })
    expect(mk().ok).toBe(true)
    rmSync(join(projDir(), folder, 'Vitáztatás'), { recursive: true })
    expect(mk().ok).toBe(true)
    expect(dirs(folder)).not.toContain('Vitáztatás')
  })
})

