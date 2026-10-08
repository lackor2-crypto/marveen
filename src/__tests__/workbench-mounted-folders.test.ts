// TG 2656 (#502): a folder that only SHOWS another place (a mount, e.g. Development/GIT_REPOS -> the real repos, or a
// folder link on the disk) is empty on the disk; the Workbench tree must follow it like the Explorer does. Its content
// is loaded when the folder is opened: walked up front, one repo took the whole listing budget (measured on the live
// depot: the repos after it read 0, the project's later folders vanished, one listing took 14-41 s).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'wb-mnt-'))
const store = mkdtempSync(join(tmpdir(), 'wb-mnt-store-'))
process.env['MARVEEN_DEPOT'] = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { initDatabase } = await import('../db.js')
const { createProject, updateProject, getProject } = await import('../projects.js')
const { addMount, removeMount, listMounts } = await import('../life-mounts.js')
const { listProjectOutside, listProjectFolderLevel, listWorkFolders } = await import('../workbench-assets.js')
const { callWorkbench } = await import('./helpers/workbench-route-call.js')

let seq = 0
function project(): { id: string; folder: string } {
  const name = `Robotok${++seq}`
  const p = createProject({ name })
  if (!p.ok) throw new Error('project')
  const folder = `Projektek/${name}`
  if (!updateProject(p.project.id, { folder_path: folder }).ok) throw new Error('folder')
  mkdirSync(join(depot, ...folder.split('/')), { recursive: true })
  return { id: p.project.id, folder }
}

function repo(name: string, files: string[] = ['README.md'], dirs: string[] = ['src']): string {
  const rel = `Rendszer/Tarolok/Git/${name}`
  const abs = join(depot, ...rel.split('/'))
  mkdirSync(join(abs, '.git'), { recursive: true })
  for (const d of dirs) { mkdirSync(join(abs, d), { recursive: true }); writeFileSync(join(abs, d, 'index.ts'), 'x') }
  for (const f of files) writeFileSync(join(abs, f), 'hi')
  return rel
}

function mount(rel: string, target: string, label = 'repo'): void {
  const m = addMount({ rel, target, kind: 'git', label })
  if (!m.ok) throw new Error('mount: ' + m.message)
}

beforeEach(() => {
  initDatabase(':memory:')
  for (const m of listMounts()) removeMount(m.rel)
})

describe('listProjectOutside follows mounts and links (#502)', () => {
  it('a mounted folder is listed as linked, counted, and its content waits for opening', () => {
    const p = project()
    mkdirSync(join(depot, ...p.folder.split('/'), 'Fejlesztes', 'GIT_REPOS'), { recursive: true })
    mount(`${p.folder}/Fejlesztes/GIT_REPOS`, repo('repo1'), 'repo1 git')
    const out = listProjectOutside(getProject(p.id)!, null)
    expect(out.folders).toContain('Fejlesztes/GIT_REPOS')
    expect(out.linked['Fejlesztes/GIT_REPOS']).toBe('repo1 git')
    // README.md + src; the .git is hidden like in the Explorer
    expect(out.lazy['Fejlesztes/GIT_REPOS']).toBe(2)
    expect(out.folders).not.toContain('Fejlesztes/GIT_REPOS/src')
  })

  it('opening it lists the repo, the files under the path the tree shows', () => {
    const p = project()
    mkdirSync(join(depot, ...p.folder.split('/'), 'Fejlesztes', 'GIT_REPOS'), { recursive: true })
    mount(`${p.folder}/Fejlesztes/GIT_REPOS`, repo('repo2'))
    const r = listProjectFolderLevel(getProject(p.id)!, 'Fejlesztes/GIT_REPOS')
    if (!r.ok) throw new Error(r.code)
    expect(r.outside.folders).toContain('Fejlesztes/GIT_REPOS/src')
    expect(r.outside.files['Fejlesztes/GIT_REPOS']).toEqual([{ name: 'README.md', size: 2, rel: `${p.folder}/Fejlesztes/GIT_REPOS/README.md` }])
    expect(r.outside.files['Fejlesztes/GIT_REPOS/src'].map((f) => f.name)).toEqual(['index.ts'])
  })

  it('a mount inside a mount (Marvin: GIT_REPOS -> one repo, GIT_REPOS/marveen -> another) shows up when the outer one opens', () => {
    const p = project()
    mkdirSync(join(depot, ...p.folder.split('/'), 'Fejlesztes', 'GIT_REPOS'), { recursive: true })
    mount(`${p.folder}/Fejlesztes/GIT_REPOS`, repo('backup', ['a.txt'], []))
    mount(`${p.folder}/Fejlesztes/GIT_REPOS/inner`, repo('inner', ['b.txt', 'c.txt'], []), 'inner git')
    const base = listProjectOutside(getProject(p.id)!, null)
    expect(base.lazy['Fejlesztes/GIT_REPOS']).toBe(2) // a.txt + the inner mount
    const r = listProjectFolderLevel(getProject(p.id)!, 'Fejlesztes/GIT_REPOS')
    if (!r.ok) throw new Error(r.code)
    expect(r.outside.linked['Fejlesztes/GIT_REPOS/inner']).toBe('inner git')
    expect(r.outside.lazy['Fejlesztes/GIT_REPOS/inner']).toBe(2)
    const inner = listProjectFolderLevel(getProject(p.id)!, 'Fejlesztes/GIT_REPOS/inner')
    if (!inner.ok) throw new Error(inner.code)
    expect(inner.outside.files['Fejlesztes/GIT_REPOS/inner'].map((f) => f.name)).toEqual(['b.txt', 'c.txt'])
  })

  it('a mount with no folder on the disk under it still shows (the Explorer shows it too)', () => {
    const p = project()
    mkdirSync(join(depot, ...p.folder.split('/'), 'Fejlesztes'), { recursive: true })
    mount(`${p.folder}/Fejlesztes/GIT_REPOS`, repo('nodisk'))
    const out = listProjectOutside(getProject(p.id)!, null)
    expect(out.folders).toContain('Fejlesztes/GIT_REPOS')
    expect(out.lazy['Fejlesztes/GIT_REPOS']).toBe(2)
  })

  it('the repos inside a mounted GIT_REPOS (Freeber: GIT_REPOS -> a folder of repos) are listed, each opened on its own', () => {
    const p = project()
    mkdirSync(join(depot, ...p.folder.split('/'), 'Fejlesztes', 'GIT_REPOS'), { recursive: true })
    const home = 'Rendszer/Tarolok/Git/Ceg'
    for (const r of ['docs', 'forum']) {
      mkdirSync(join(depot, ...home.split('/'), r, '.git'), { recursive: true })
      writeFileSync(join(depot, ...home.split('/'), r, `${r}.md`), r)
    }
    mount(`${p.folder}/Fejlesztes/GIT_REPOS`, home, 'Ceg repok')
    const lv = listProjectFolderLevel(getProject(p.id)!, 'Fejlesztes/GIT_REPOS')
    if (!lv.ok) throw new Error(lv.code)
    expect(lv.outside.folders.sort()).toEqual(['Fejlesztes/GIT_REPOS/docs', 'Fejlesztes/GIT_REPOS/forum'])
    expect(lv.outside.lazy).toEqual({ 'Fejlesztes/GIT_REPOS/docs': 1, 'Fejlesztes/GIT_REPOS/forum': 1 })
    const docs = listProjectFolderLevel(getProject(p.id)!, 'Fejlesztes/GIT_REPOS/docs')
    if (!docs.ok) throw new Error(docs.code)
    expect(docs.outside.files['Fejlesztes/GIT_REPOS/docs'].map((f) => f.rel)).toEqual([`${p.folder}/Fejlesztes/GIT_REPOS/docs/docs.md`])
  })

  it('a git repo lying loose in the project folder is shown too, read when opened', () => {
    const p = project()
    const loose = join(depot, ...p.folder.split('/'), 'sajat-repo')
    mkdirSync(join(loose, '.git'), { recursive: true })
    writeFileSync(join(loose, 'main.py'), 'x')
    const out = listProjectOutside(getProject(p.id)!, null)
    expect(out.folders).toContain('sajat-repo')
    expect(out.lazy['sajat-repo']).toBe(1)
    expect(out.linked['sajat-repo']).toBeUndefined()
    expect(out.files['sajat-repo']).toBeUndefined()
  })

  it('a folder link on the disk (not a mount) is followed like the Explorer follows it', () => {
    const p = project()
    const target = join(depot, 'Megosztott', 'Kozos')
    mkdirSync(join(target, 'Belso'), { recursive: true })
    writeFileSync(join(target, 'k.pdf'), 'pdf')
    symlinkSync(target, join(depot, ...p.folder.split('/'), 'Kozos'), 'dir')
    const out = listProjectOutside(getProject(p.id)!, null)
    expect(out.folders).toContain('Kozos')
    expect(out.linked['Kozos']).toBe('')
    expect(out.lazy['Kozos']).toBe(2)
    const r = listProjectFolderLevel(getProject(p.id)!, 'Kozos')
    if (!r.ok) throw new Error(r.code)
    expect(r.outside.folders).toContain('Kozos/Belso')
    expect(r.outside.files['Kozos'].map((f) => f.rel)).toEqual([`${p.folder}/Kozos/k.pdf`])
  })

  it('a folder link leading out of the depot is not followed (opening it would be refused anyway)', () => {
    const p = project()
    const outsideDir = mkdtempSync(join(tmpdir(), 'wb-mnt-out-'))
    writeFileSync(join(outsideDir, 'titok.txt'), 'x')
    symlinkSync(outsideDir, join(depot, ...p.folder.split('/'), 'Kifele'), 'dir')
    const out = listProjectOutside(getProject(p.id)!, null)
    expect(out.folders).not.toContain('Kifele')
    expect(out.lazy['Kifele']).toBeUndefined()
    expect(listProjectFolderLevel(getProject(p.id)!, 'Kifele').ok).toBe(false)
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('a big repo no longer starves the rest: the folders after it keep their files', () => {
    const p = project()
    const root = join(depot, ...p.folder.split('/'))
    mkdirSync(join(root, 'A_fejlesztes', 'GIT_REPOS'), { recursive: true })
    const many = Array.from({ length: 150 }, (_, i) => `f${i}.ts`)
    mount(`${p.folder}/A_fejlesztes/GIT_REPOS`, repo('big', many, Array.from({ length: 30 }, (_, i) => `d${i}`)))
    mkdirSync(join(root, 'Zeta'), { recursive: true })
    writeFileSync(join(root, 'Zeta', 'z.txt'), 'z')
    const out = listProjectOutside(getProject(p.id)!, null)
    expect(out.files['Zeta'].map((f) => f.name)).toEqual(['z.txt'])
    expect(out.lazy['A_fejlesztes/GIT_REPOS']).toBe(180) // 150 files + 30 folders
    expect(Object.values(out.files).flat().some((f) => f.name.startsWith('f'))).toBe(false)
  })

  it('out of time: the folders not read yet are still listed (lazy), never dropped and never a false 0', () => {
    const p = project()
    const root = join(depot, ...p.folder.split('/'))
    for (const n of ['B1', 'B2', 'B3']) { mkdirSync(join(root, n, 'mely'), { recursive: true }); writeFileSync(join(root, n, `${n}.txt`), n) }
    writeFileSync(join(root, 'gyoker.txt'), 'r')
    let clock = 0
    // the project folder is always read; the clock runs out right after it
    const out = listProjectOutside(getProject(p.id)!, null, { budgetMs: 5, now: () => (clock += 10) })
    expect(out.files[''].map((f) => f.name)).toEqual(['gyoker.txt'])
    expect(out.folders.sort()).toEqual(['B1', 'B2', 'B3'])
    expect(out.lazy).toEqual({ B1: null, B2: null, B3: null })
    const r = listProjectFolderLevel(getProject(p.id)!, 'B2')
    if (!r.ok) throw new Error(r.code)
    expect(r.outside.files['B2'].map((f) => f.name)).toEqual(['B2.txt'])
    expect(r.outside.folders).toContain('B2/mely')
  })

  it('breadth first: the first level is read before any deeper one, so the budget cuts the deep end', () => {
    const p = project()
    const root = join(depot, ...p.folder.split('/'))
    mkdirSync(join(root, 'A', 'A1'), { recursive: true })
    mkdirSync(join(root, 'B'), { recursive: true })
    // now(): 1 = the deadline, 2 = before A, 3 = A's child A1 is looked at, 4 = before B, 5 = before A/A1 (too late).
    // Depth first would read A/A1 before B.
    let calls = 0
    const out = listProjectOutside(getProject(p.id)!, null, { budgetMs: 1000, now: () => (++calls > 4 ? 1e9 : 0) })
    expect(out.folders.sort()).toEqual(['A', 'A/A1', 'B'])
    expect(out.lazy).toEqual({ 'A/A1': null })
  })

  it('an unreachable mount target leaves the folder on the disk as a plain folder', () => {
    const p = project()
    mkdirSync(join(depot, ...p.folder.split('/'), 'Fejlesztes', 'GIT_REPOS'), { recursive: true })
    writeFileSync(join(depot, ...p.folder.split('/'), 'Fejlesztes', 'GIT_REPOS', 'olvass.txt'), 'x')
    const target = repo('gone')
    mount(`${p.folder}/Fejlesztes/GIT_REPOS`, target)
    rmSync(join(depot, ...target.split('/')), { recursive: true, force: true })
    const out = listProjectOutside(getProject(p.id)!, null)
    expect(out.linked['Fejlesztes/GIT_REPOS']).toBeUndefined()
    expect(out.files['Fejlesztes/GIT_REPOS'].map((f) => f.name)).toEqual(['olvass.txt'])
  })

  it('the box keeps its own listing; the file actions that only need the box skip the slow walk', () => {
    const p = project()
    const root = join(depot, ...p.folder.split('/'))
    mkdirSync(join(root, 'Munkadarabok'), { recursive: true })
    mkdirSync(join(root, 'Fejlesztes', 'GIT_REPOS'), { recursive: true })
    mount(`${p.folder}/Fejlesztes/GIT_REPOS`, repo('boxrepo'))
    const all = listWorkFolders(getProject(p.id)!)
    expect(all.box).toBe('Munkadarabok')
    expect(all.outside.folders).not.toContain('Munkadarabok')
    expect(all.outside.lazy['Fejlesztes/GIT_REPOS']).toBe(2)
    expect(listWorkFolders(getProject(p.id)!, { outside: false }).outside).toEqual({ folders: [], files: {}, truncated: false, lazy: {}, linked: {} })
  })

  it('opening refuses paths it must not read', () => {
    const p = project()
    const root = join(depot, ...p.folder.split('/'))
    mkdirSync(join(root, 'Munkadarabok', 'Belul'), { recursive: true })
    mkdirSync(join(root, '.rejtett'), { recursive: true })
    const pr = getProject(p.id)!
    for (const bad of ['', '../..', 'Munkadarabok', 'Munkadarabok/Belul', '.rejtett', 'nincs-ilyen']) {
      const r = listProjectFolderLevel(pr, bad)
      expect(r.ok, bad).toBe(false)
    }
  })
})

describe('GET /api/workbench/folder-level', () => {
  it('answers with the opened folder, and in plain words when it cannot', async () => {
    const p = project()
    mkdirSync(join(depot, ...p.folder.split('/'), 'Fejlesztes', 'GIT_REPOS'), { recursive: true })
    mount(`${p.folder}/Fejlesztes/GIT_REPOS`, repo('routerepo'))
    const ok = await callWorkbench(`/api/workbench/folder-level?project=${p.id}&folder=${encodeURIComponent('Fejlesztes/GIT_REPOS')}`, 'GET')
    expect(ok.status).toBe(200)
    expect(ok.body.folder).toBe('Fejlesztes/GIT_REPOS')
    expect(ok.body.outside.files['Fejlesztes/GIT_REPOS'].map((f: { name: string }) => f.name)).toEqual(['README.md'])
    const bad = await callWorkbench(`/api/workbench/folder-level?project=${p.id}&folder=..`, 'GET')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('bad_folder')
    expect(typeof bad.body.message).toBe('string')
    const none = await callWorkbench('/api/workbench/folder-level?project=nincs&folder=x', 'GET')
    expect(none.status).toBe(404)
  })
})

describe('the tree loads a linked folder when it is opened (#502)', async () => {
  const { workbenchHarness, untranslatedHungarian } = await import('./helpers/workbench-harness.js')
  const L = 'Fejlesztes/GIT_REPOS'
  const workFolders = {
    box: null, folders: [], files: {}, truncated: false, root_name: 'Robotok',
    outside: { folders: ['Fejlesztes', L], files: {}, truncated: false, lazy: { [L]: 2 }, linked: { [L]: 'repo1 git' } },
  }
  const level = {
    ok: true, folder: L,
    outside: { folders: [`${L}/src`], files: { [L]: [{ name: 'README.md', size: 2, rel: `Projektek/Robotok/${L}/README.md` }] }, truncated: false, lazy: { [`${L}/src`]: null }, linked: {} },
  }
  const treeOf = (html: string) => { const a = html.indexOf('<ul class="wb-items">'); return a < 0 ? '' : html.slice(a, html.indexOf('</ul>', a)) }
  const levelCalls = (h: { fetchCalls: { url: string }[] }) => h.fetchCalls.filter((c) => c.url.includes('/api/workbench/folder-level')).length

  it('shows the link and its count closed, loads on opening, then shows the files', async () => {
    const h = workbenchHarness({ closedFolders: true })
    h.respond((url) => {
      if (url.includes('/api/workbench/items?')) return { status: 200, body: { items: [], work_folders: workFolders } }
      if (url.includes('/api/workbench/folder-level?')) return { status: 200, body: level }
      return { status: 200, body: { todos: [] } }
    })
    h.win.MarvinWorkbench.open('p1', 'Robotok')
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-folder="Fejlesztes"'))
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': 'Fejlesztes' })
    const closed = treeOf(h.html())
    expect(closed).toContain(`data-wb-folder="${L}"`)
    expect(closed).toContain('🔗')
    expect(closed).toContain('⟦workbench.folder.linked⟧ (repo1 git)')
    expect(closed).toContain('(2+)')
    expect(levelCalls(h)).toBe(0) // nothing is read before it is opened
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': L })
    expect(treeOf(h.html())).toContain('⟦workbench.folder.loading⟧')
    await vi.waitFor(() => expect(treeOf(h.html())).toContain('README.md'))
    const call = h.fetchCalls.find((c) => c.url.includes('/api/workbench/folder-level'))!
    expect(call.url).toContain('project=p1')
    expect(call.url).toContain('folder=' + encodeURIComponent(L))
    const open = treeOf(h.html())
    expect(open).toContain(`data-wb-folder="${L}/src"`)
    expect(open).toContain('(1+)')
    expect(open).toContain('(…)')
    expect(untranslatedHungarian(open, ['Fejlesztes', 'GIT_REPOS', 'README.md', 'Robotok'])).toBe('')
    // more renders of the same list do not read it again
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': `${L}/src` })
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': `${L}/src` })
    expect(levelCalls(h)).toBe(2) // GIT_REPOS once, src once
  })

  it('a project with no work item still shows its folder tree under the "no work item yet" hint; a truly empty one only the hint', async () => {
    const h = workbenchHarness({ closedFolders: true })
    h.respond((url) => {
      if (url.includes('/api/workbench/items?')) return { status: 200, body: { items: [], work_folders: workFolders } }
      return { status: 200, body: { todos: [] } }
    })
    h.win.MarvinWorkbench.open('p1', 'Robotok')
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-folder="Fejlesztes"'))
    expect(h.html()).toContain('⟦workbench.empty.title⟧')
    const e = workbenchHarness({ closedFolders: true })
    e.respond((url) => {
      if (url.includes('/api/workbench/items?')) return { status: 200, body: { items: [], work_folders: { box: null, folders: [], files: {}, truncated: false, outside: { folders: [], files: {}, truncated: false, lazy: {}, linked: {} }, root_name: 'Ures' } } }
      return { status: 200, body: { todos: [] } }
    })
    e.win.MarvinWorkbench.open('p2', 'Ures')
    await vi.waitFor(() => expect(e.html()).toContain('⟦workbench.empty.title⟧'))
    expect(e.html()).not.toContain('<ul class="wb-items">')
  })

  it('a folder that cannot be read says so, and is tried again when closed and opened', async () => {
    const h = workbenchHarness({ closedFolders: true })
    let fail = true
    h.respond((url) => {
      if (url.includes('/api/workbench/items?')) return { status: 200, body: { items: [], work_folders: workFolders } }
      if (url.includes('/api/workbench/folder-level?')) return fail ? { status: 503, body: { error: 'unreachable', message: 'A meghajtó nem érhető el.' } } : { status: 200, body: level }
      return { status: 200, body: { todos: [] } }
    })
    h.win.MarvinWorkbench.open('p1', 'Robotok')
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-folder="Fejlesztes"'))
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': 'Fejlesztes' })
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': L })
    await vi.waitFor(() => expect(treeOf(h.html())).toContain('A meghajtó nem érhető el.'))
    expect(levelCalls(h)).toBe(1)
    fail = false
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': L })
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': L })
    await vi.waitFor(() => expect(treeOf(h.html())).toContain('README.md'))
    expect(levelCalls(h)).toBe(2)
  })
})
