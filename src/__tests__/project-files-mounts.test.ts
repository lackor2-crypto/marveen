// The project Files tab shows what the Explorer shows: a git repo mounted under
// the project's GIT_REPOS folder (it lives in the central storage on disk) must
// be listed there, with its content, and opening it must not be "outside".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-prjmnt-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-prjmnt-store-'))
process.env.MARVEEN_DEPOT = depot
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, APP_LANG: 'hu' }
})

const { initDatabase } = await import('../db.js')
const { createProject } = await import('../projects.js')
const { listProjectDir, findProjectFiles, _resetProjectNameIndexes } = await import('../project-files.js')
const { recentFiles } = await import('../project-overview.js')
const { addMount } = await import('../life-mounts.js')

describe('project Files tab follows mounts', () => {
  beforeEach(() => { initDatabase(':memory:') })
  afterEach(() => { rmSync(depot, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }) })

  it('lists a mounted repo under an empty GIT_REPOS folder, with its content, and opens it', () => {
    const w = join(depot, 'Projektek', 'Tozsde')
    mkdirSync(join(w, 'Fejlesztés', 'GIT_REPOS'), { recursive: true })
    const repo = join(depot, 'Rendszer', 'Tárolók', 'Git', 'acc', 'trend')
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'README.md'), 'x')
    const m = addMount({ rel: 'Projektek/Tozsde/Fejlesztés/GIT_REPOS/trend', target: 'Rendszer/Tárolók/Git/acc/trend', kind: 'git', label: 'acc / trend' })
    expect(m.ok).toBe(true)
    const r = createProject({ name: 'Tozsde', folder_path: 'Projektek/Tozsde' })
    if (!r.ok) throw new Error(r.code)
    const dev = listProjectDir(r.project, 'Fejlesztés')
    expect(dev.ok && dev.entries.find((e) => e.name === 'GIT_REPOS')).toMatchObject({ children: 1 })
    const repos = listProjectDir(r.project, 'Fejlesztés/GIT_REPOS')
    expect(repos.ok && repos.entries.map((e) => [e.name, e.sub, e.children])).toEqual([['trend', 'Fejlesztés/GIT_REPOS/trend', 2]])
    const inside = listProjectDir(r.project, 'Fejlesztés/GIT_REPOS/trend')
    expect(inside.ok && inside.entries.map((e) => e.name)).toEqual(['src', 'README.md'])
    expect(listProjectDir(r.project, '../..')).toEqual({ ok: false, code: 'bad_folder' })
  })

  it('the file search finds files inside a mounted repo too', async () => {
    const w = join(depot, 'Projektek', 'Tozsde')
    mkdirSync(join(w, 'Fejlesztés', 'GIT_REPOS'), { recursive: true })
    const repo = join(depot, 'Rendszer', 'Tárolók', 'Git', 'acc', 'trend')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'trendvonal_rajzolo.mq5'), 'x')
    addMount({ rel: 'Projektek/Tozsde/Fejlesztés/GIT_REPOS/trend', target: 'Rendszer/Tárolók/Git/acc/trend', kind: 'git', label: 'acc / trend' })
    const r = createProject({ name: 'Tozsde', folder_path: 'Projektek/Tozsde' })
    if (!r.ok) throw new Error(r.code)
    _resetProjectNameIndexes()
    const f = await findProjectFiles(r.project, 'rajzolo', 5000)
    expect(f.ok && f.hits.map((h) => h.sub)).toEqual(['Fejlesztés/GIT_REPOS/trend/trendvonal_rajzolo.mq5'])
  })

  it('the flat "recent files" list includes files of a mounted repo', async () => {
    mkdirSync(join(depot, 'Projektek', 'Tozsde', 'Fejlesztés', 'GIT_REPOS'), { recursive: true })
    const repo = join(depot, 'Rendszer', 'Tárolók', 'Git', 'acc', 'trend')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'a.mq5'), 'x')
    addMount({ rel: 'Projektek/Tozsde/Fejlesztés/GIT_REPOS/trend', target: 'Rendszer/Tárolók/Git/acc/trend', kind: 'git', label: 'acc / trend' })
    const r = createProject({ name: 'Tozsde', folder_path: 'Projektek/Tozsde' })
    if (!r.ok) throw new Error(r.code)
    const rf = await recentFiles(r.project, 50)
    expect(rf.files.map((f) => f.rel)).toEqual(['Projektek/Tozsde/Fejlesztés/GIT_REPOS/trend/a.mq5'])
  })
})
