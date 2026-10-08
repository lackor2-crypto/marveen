// #509 (Boss TG 2948, A): a merge carries the project's OTHER files too, so "everything moves" is true.
// "Tovabbi anyagok" content -> the target's "Tovabbi anyagok", any other folder/file -> the target root under
// its own name, a taken name gets "(2)", nothing is overwritten or deleted; another project's folder stays.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, getProject, updateProject } from '../projects.js'
import { mergeProjectInto } from '../project-move.js'
import { projectMaterialsFolder } from '../workbench-assets.js'
import { ensureProjectHasFolder } from '../project-files.js'

describe('merge carries the loose files', () => {
  let depot = ''
  let a = '', b = ''
  const abs = (rel: string) => join(depot, ...rel.split('/'))
  const mk = (name: string) => { const r = createProject({ name }); if (!r.ok) throw new Error(r.code); return r.project.id }
  const put = (rel: string, body: string) => { mkdirSync(abs(rel.replace(/\/[^/]*$/, '')), { recursive: true }); writeFileSync(abs(rel), body) }
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-merge-loose-'))
    process.env['MARVEEN_DEPOT'] = depot
    a = mk('Regi ugyek')
    b = mk('Uj ugyek')
    for (const id of [a, b]) ensureProjectHasFolder(getProject(id)!)
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('moves materials into materials, other entries into the root, (2) on a taken name, source folder gone', () => {
    const pa = getProject(a)!, pb = getProject(b)!
    const matA = projectMaterialsFolder(pa), matB = projectMaterialsFolder(pb)
    expect(matA.ok && matB.ok).toBe(true)
    if (!matA.ok || !matB.ok) return
    put(`${pa.folder_path}/${matA.folder}/szamla.pdf`, 'A-szamla')
    put(`${pb.folder_path}/${matB.folder}/szamla.pdf`, 'B-szamla')
    put(`${pa.folder_path}/Iroda/level.txt`, 'level')
    put(`${pa.folder_path}/jegyzet.md`, 'A-jegyzet')
    put(`${pb.folder_path}/jegyzet.md`, 'B-jegyzet')

    const out = mergeProjectInto(a, b)
    expect(out.ok).toBe(true)
    expect(getProject(a)).toBeUndefined()
    const bRoot = pb.folder_path as string
    expect(readFileSync(abs(`${bRoot}/${matB.folder}/szamla.pdf`), 'utf8')).toBe('B-szamla')
    expect(readFileSync(abs(`${bRoot}/${matB.folder}/szamla (2).pdf`), 'utf8')).toBe('A-szamla')
    expect(readFileSync(abs(`${bRoot}/Iroda/level.txt`), 'utf8')).toBe('level')
    expect(readFileSync(abs(`${bRoot}/jegyzet.md`), 'utf8')).toBe('B-jegyzet')
    expect(readFileSync(abs(`${bRoot}/jegyzet (2).md`), 'utf8')).toBe('A-jegyzet')
    expect(existsSync(abs(pa.folder_path as string))).toBe(false)
  })

  it('leaves a folder that belongs to another project where it is', () => {
    const pa = getProject(a)!
    put(`${pa.folder_path}/Al/x.txt`, 'x')
    put(`${pa.folder_path}/sajat.txt`, 's')
    const c = mk('Harmadik')
    updateProject(c, { folder_path: `${pa.folder_path}/Al` })
    const out = mergeProjectInto(a, b)
    expect(out.ok).toBe(true)
    expect(existsSync(abs(`${pa.folder_path}/Al/x.txt`))).toBe(true)
    expect(existsSync(abs(`${getProject(b)!.folder_path}/sajat.txt`))).toBe(true)
  })

  it('does not touch a folder shared with another project', () => {
    const pa = getProject(a)!
    put(`${pa.folder_path}/k.txt`, 'k')
    const c = mk('Kozos')
    updateProject(c, { folder_path: pa.folder_path })
    expect(mergeProjectInto(a, b).ok).toBe(true)
    expect(existsSync(abs(`${pa.folder_path}/k.txt`))).toBe(true)
  })
})
