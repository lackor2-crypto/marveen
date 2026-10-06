// TG 2656: a folder that only SHOWS another place (a mount, e.g. Development/GIT_REPOS -> the real repos) is empty on
// the disk; the Workbench tree must follow the mount like the Explorer does.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
const { addMount } = await import('../life-mounts.js')
const { listProjectOutside } = await import('../workbench-assets.js')

describe('listProjectOutside follows mounts', () => {
  it('shows the repo behind a mounted folder, including its .git-bearing root', () => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Robotok' })
    if (!p.ok) throw new Error('project')
    if (!updateProject(p.project.id, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('folder')
    mkdirSync(join(depot, 'Projektek', 'Robotok', 'Fejlesztes', 'GIT_REPOS'), { recursive: true })
    mkdirSync(join(depot, 'Rendszer', 'Tarolok', 'Git', 'repo1', '.git'), { recursive: true })
    mkdirSync(join(depot, 'Rendszer', 'Tarolok', 'Git', 'repo1', 'src'), { recursive: true })
    writeFileSync(join(depot, 'Rendszer', 'Tarolok', 'Git', 'repo1', 'README.md'), 'hi')
    const m = addMount({ rel: 'Projektek/Robotok/Fejlesztes/GIT_REPOS', target: 'Rendszer/Tarolok/Git/repo1', kind: 'git', label: 'repo1' })
    expect(m.ok).toBe(true)
    const out = listProjectOutside(getProject(p.project.id)!, null)
    expect(out.folders).toContain('Fejlesztes/GIT_REPOS')
    expect(out.folders).toContain('Fejlesztes/GIT_REPOS/src')
    expect((out.files['Fejlesztes/GIT_REPOS'] || []).map((f) => f.name)).toContain('README.md')
  })
})
