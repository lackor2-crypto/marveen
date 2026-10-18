// #691 (Boss TG 9607/9610): the saved versions of a work item sit in a "Verziók"/"Versions" folder inside the item's
// own folder. It shows only once a version exists (never empty), and it is protected: its files and the folder
// itself cannot be deleted, renamed or moved by hand, and nothing can be put into it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import {
  ensureWorkItemFolder, listWorkFolders, deleteLooseFiles, renameLooseFile, moveLooseFiles, copyLooseFiles,
  deleteWorkFolder, renameWorkFolder, moveWorkFolder, makeWorkFolder, moveWorkItemToFolder, isVersionsLifePath,
} from '../workbench-assets.js'
import { saveCanvas } from '../workbench-canvas-store.js'

describe('versions folder: shown only with a version, protected', () => {
  let depot = ''
  let pid = ''
  const project = () => getProject(pid)!
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-ver-'))
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

  const drawing = (title: string) => {
    const w = createWorkItem({ project_id: pid, title, type: 'graphic' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    return w.item.id
  }
  const save = (id: string, n: number) => {
    const r = saveCanvas(getWorkItem(id)!, { v: n } as never, {})
    if (!r.ok) throw new Error('save')
  }
  const versionFolder = () => listWorkFolders(project(), { outside: false }).folders.find((f) => /\/Verziók$/.test(f)) ?? null

  it('a fresh item has no versions folder; one save does not make it; the second save does', () => {
    const id = drawing('Rajz')
    expect(versionFolder()).toBeNull()
    save(id, 1)
    expect(versionFolder()).toBeNull()
    save(id, 2)
    const vf = versionFolder()
    expect(vf).not.toBeNull()
    const files = listWorkFolders(project(), { outside: false }).files[vf!] ?? []
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.version === true)).toBe(true)
  })

  it('an empty versions folder on the disk is never listed', () => {
    const id = drawing('Rajz')
    save(id, 1)
    save(id, 2)
    const vf = versionFolder()!
    const abs = join(projDir(), vf)
    for (const f of listWorkFolders(project(), { outside: false }).files[vf] ?? []) rmSync(join(depot, f.rel), { force: true })
    expect(existsSync(abs)).toBe(true)
    expect(versionFolder()).toBeNull()
  })

  it('version files cannot be deleted, renamed or moved; the folder cannot be deleted, renamed or moved; nothing goes into it', () => {
    const id = drawing('Rajz')
    save(id, 1)
    save(id, 2)
    save(id, 3)
    const vf = versionFolder()!
    const wf = listWorkFolders(project(), { outside: false })
    const v = (wf.files[vf] ?? [])[0]!
    const abs = join(depot, v.rel)

    const del = deleteLooseFiles(project(), [v.rel])
    expect(del.ok && del.deleted).toEqual([])
    expect(del.ok && del.skipped[0]?.reason).toBe('version_file')
    expect(existsSync(abs)).toBe(true)

    const ren = renameLooseFile(project(), v.rel, 'masik.json')
    expect(ren.ok).toBe(false)
    expect(!ren.ok && ren.code).toBe('file_version_protected')
    expect(existsSync(abs)).toBe(true)

    const mv = moveLooseFiles(project(), [v.rel], wf.box)
    expect(mv.ok && mv.moved).toEqual([])
    expect(mv.ok && mv.skipped[0]?.reason).toBe('version_file')
    expect(existsSync(abs)).toBe(true)

    const dFolder = deleteWorkFolder(project(), vf, { trash: true, force: true })
    expect(!dFolder.ok && dFolder.code).toBe('folder_versions_protected')
    const rFolder = renameWorkFolder(project(), vf, 'Regi')
    expect(!rFolder.ok && rFolder.code).toBe('folder_versions_protected')
    const mFolder = moveWorkFolder(project(), vf, wf.box)
    expect(!mFolder.ok && mFolder.code).toBe('folder_versions_protected')
    expect(existsSync(abs)).toBe(true)

    // nothing is put into it: not a folder, not a loose file (moved or copied), not a work item
    const mk = makeWorkFolder(project(), vf, 'Kamu')
    expect(!mk.ok && mk.code).toBe('folder_versions_protected')
    const other = drawing('Masik')
    const plain = makeWorkFolder(project(), '', 'Sima')
    if (!plain.ok) throw new Error('mk')
    writeFileSync(join(projDir(), plain.folder, 'x.txt'), 'x')
    const itemFile = (listWorkFolders(project(), { outside: false }).files[plain.folder] ?? [])[0]!
    const into = moveLooseFiles(project(), [itemFile.rel], vf, { allowItem: true })
    expect(!into.ok && into.code).toBe('folder_versions_protected')
    const copy = copyLooseFiles(project(), [itemFile.rel], vf)
    return copy.then((c) => {
      expect(!c.ok && c.code).toBe('folder_versions_protected')
      const item = getWorkItem(other)!
      const mi = moveWorkItemToFolder(item, vf)
      expect(!mi.ok && mi.code).toBe('folder_versions_protected')
    })
  })

  it('a loose file in an ordinary folder is still deletable and renamable (the protection is only for versions)', () => {
    const made = makeWorkFolder(project(), '', 'Sima')
    if (!made.ok) throw new Error('mk')
    const abs = join(projDir(), made.folder, 'x.txt')
    mkdirSync(join(projDir(), made.folder), { recursive: true })
    rmSync(abs, { force: true })
    // write via fs
    writeFileSync(abs, 'x')
    const rel = (listWorkFolders(project(), { outside: false }).files[made.folder] ?? [])[0]!.rel
    const r = renameLooseFile(project(), rel, 'y.txt')
    expect(r.ok).toBe(true)
  })

  it('the tree and the strings: protected rows have no menu/drag/drop, hu+en labels exist', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain('f.version')
    expect(js).toContain('wb-version-folder')
    expect(js).toContain("'workbench.versions.folder_hint'")
    for (const l of ['hu', 'en']) {
      const lang = readFileSync(join(__dirname, '..', '..', 'web', 'lang', l + '.js'), 'utf8')
      for (const k of ['workbench.versions.file_hint', 'workbench.versions.folder_hint', 'workbench.versions.kept']) expect(lang).toContain('"' + k + '"')
    }
    const routes = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf8')
    expect(routes).toContain('folder_versions_protected: {')
    expect(routes).toContain('file_version_protected: {')
  })

  it('the Explorer tree (Életfa) protects the same paths: the versions folder and its files, nothing above or beside them', () => {
    const id = drawing('Rajz')
    save(id, 1)
    save(id, 2)
    const vf = versionFolder()!
    const file = (listWorkFolders(project(), { outside: false }).files[vf] ?? [])[0]!
    const folderRel = 'Projektek/Iroda/' + vf
    expect(isVersionsLifePath(folderRel)).toBe(true)
    expect(isVersionsLifePath(folderRel + '/')).toBe(true)
    expect(isVersionsLifePath(file.rel)).toBe(true)
    // the item's own folder, its parent and an unrelated "Versions" folder stay free
    expect(isVersionsLifePath(folderRel.slice(0, folderRel.lastIndexOf('/')))).toBe(false)
    expect(isVersionsLifePath('Projektek/Iroda')).toBe(false)
    expect(isVersionsLifePath('Projektek/Iroda/Egyeb/Versions')).toBe(false)
    expect(isVersionsLifePath('')).toBe(false)
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'life.ts'), 'utf8')
    for (const route of ['mkdir', 'move', 'copy', 'rename', 'trash']) {
      const at = src.indexOf(`path === '/api/life/${route}' && method === 'POST'`)
      expect(at).toBeGreaterThan(0)
      expect(src.slice(at, at + 900)).toContain('versionsGuard(')
    }
  })
})
