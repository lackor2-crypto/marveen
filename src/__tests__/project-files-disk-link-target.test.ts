// #700: a folder LINKED on the disk (a symlink inside the project) is a valid write target; a link out of the depot or a
// plain `..` is still refused.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-dl-'))
const outside = mkdtempSync(join(tmpdir(), 'marveen-dl-out-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-dl-store-'))
process.env.MARVEEN_DEPOT = depot
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, APP_LANG: 'hu' }
})

const { initDatabase } = await import('../db.js')
const { createProject } = await import('../projects.js')
const { projectFileTarget } = await import('../project-files.js')

describe('projectFileTarget follows a disk link', () => {
  beforeEach(() => { initDatabase(':memory:') })
  afterEach(() => { for (const d of [depot, outside, store]) rmSync(d, { recursive: true, force: true }) })

  it('accepts a link to another depot folder, refuses one that leaves the depot and a plain ..', () => {
    mkdirSync(join(depot, 'Projektek', 'P'), { recursive: true })
    mkdirSync(join(depot, 'Csaladi', 'Dok'), { recursive: true })
    symlinkSync(join(depot, 'Csaladi', 'Dok'), join(depot, 'Projektek', 'P', 'Linkelt'))
    symlinkSync(outside, join(depot, 'Projektek', 'P', 'Kifele'))
    const r = createProject({ name: 'P', folder_path: 'Projektek/P' })
    if (!r.ok) throw new Error(r.code)
    const ok = projectFileTarget(r.project, 'Linkelt')
    expect(ok.ok && ok.dirAbs.endsWith(join('Csaladi', 'Dok'))).toBe(true)
    expect(projectFileTarget(r.project, 'Kifele')).toEqual({ ok: false, code: 'bad_folder' })
    expect(projectFileTarget(r.project, '../..')).toEqual({ ok: false, code: 'bad_folder' })
  })
})
