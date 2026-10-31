// #794 (Boss TG 4045, option B): a second official letter in the same case gets a LETTER folder inside the case folder
// with only its own three folders (Trigger document, Finished materials, Attachments). The shared parts (Uploads,
// Agent) stay at the case level. A debate report or anything inside a standard folder is still a plain sub-document.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder, ensureAllAttachmentsFolders, isLetterFolderUnder } from '../workbench-assets.js'

describe('letter folders inside a case folder', () => {
  let depot = ''
  let pid = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const subs = (rel: string) => readdirSync(join(projDir(), rel), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-letter-'))
    mkdirSync(projDir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
  })
  afterEach(() => { rmSync(depot, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  function caseWith(childRel: string): { caseFolder: string; childId: string } {
    const w = createWorkItem({ project_id: pid, title: 'Wohngeld 2026', type: 'document' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    const c = createWorkItem({ project_id: pid, title: 'Widerspruch', type: 'document' })
    if (!c.ok) throw new Error('child')
    const rel = `${f.folder}/${childRel}`
    mkdirSync(join(projDir(), rel), { recursive: true })
    getDb().prepare('UPDATE work_items SET folder = ?, container_folder = ? WHERE id = ?').run(rel, rel, c.item.id)
    return { caseFolder: f.folder, childId: c.item.id }
  }

  it('the rule: a direct child folder is a letter folder, one inside a standard folder is not', () => {
    expect(isLetterFolderUnder('A', 'A/2. levél')).toBe(true)
    expect(isLetterFolderUnder('A', 'A/Mellékletek')).toBe(false)
    expect(isLetterFolderUnder('A', 'A/Elkészített anyagok')).toBe(false)
    expect(isLetterFolderUnder('A', 'A/2. levél/Mellékletek')).toBe(false)
    expect(isLetterFolderUnder('A', 'B/2. levél')).toBe(false)
  })

  it('the second letter gets exactly its own three folders; the case keeps the shared ones', () => {
    const { caseFolder } = caseWith('2. levél')
    ensureAllAttachmentsFolders()
    expect(subs(`${caseFolder}/2. levél`)).toEqual(['Elkészített anyagok', 'Kiváltó irat', 'Mellékletek'])
    expect(subs(caseFolder)).toEqual(expect.arrayContaining(['Feltöltések', 'Agent', 'Mellékletek', 'Kiváltó irat', 'Elkészített anyagok']))
  })

  it('a folder the owner deleted in the letter folder stays deleted', () => {
    const { caseFolder } = caseWith('2. levél')
    ensureAllAttachmentsFolders()
    rmSync(join(projDir(), caseFolder, '2. levél', 'Mellékletek'), { recursive: true })
    ensureAllAttachmentsFolders()
    expect(subs(`${caseFolder}/2. levél`)).toEqual(['Elkészített anyagok', 'Kiváltó irat'])
  })

  it('an item inside a standard folder of the case is still a sub-document: no folders', () => {
    const { caseFolder } = caseWith('Mellékletek/valami')
    ensureAllAttachmentsFolders()
    expect(subs(`${caseFolder}/Mellékletek/valami`)).toEqual([])
    expect(getWorkItem).toBeTruthy()
  })
})
