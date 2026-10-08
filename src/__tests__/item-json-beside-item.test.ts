// Boss TG 2927/2929 (rule): a work item's JSON file is written next to the item, never in the project root.
// Seen live: a folderless graphic item listed in "Munkadarabok/Wohngeld 2026/Feltöltések" got its .canvas.json
// in the project root.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { makeWorkFolder, PROJECT_ROOT_PLACE } from '../workbench-assets.js'
import { saveCanvas } from '../workbench-canvas-store.js'
import { emptyCanvas } from '../workbench-graphic.js'

let dir = ''
let pid = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-json-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Hivatal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  updateProject(pid, { folder_path: 'P/Hivatal' })
  mkdirSync(join(dir, 'P', 'Hivatal'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

function graphic(container: string | null, source?: string) {
  const r = createWorkItem({ project_id: pid, title: 'Rajz', type: 'graphic', container_folder: container, ...(source ? { source_path: source } : {}) })
  if (!r.ok) throw new Error(r.code)
  return getWorkItem(r.item.id)!
}

describe('a work item JSON goes next to the item', () => {
  it('folderless item listed in a group: the JSON goes into that group, not the project root', () => {
    const g = makeWorkFolder(getProject(pid)!, '', 'Wohngeld 2026')
    if (!g.ok) throw new Error(g.code)
    const s = saveCanvas(graphic(g.folder), emptyCanvas())
    if (!s.ok) throw new Error(s.code)
    expect(s.rel.startsWith(`P/Hivatal/${g.folder}/`)).toBe(true)
  })

  it('folderless item with no group: the work-items box, never the root', () => {
    const s = saveCanvas(graphic(null), emptyCanvas())
    if (!s.ok) throw new Error(s.code)
    const inside = s.rel.slice('P/Hivatal/'.length)
    expect(inside.includes('/')).toBe(true)
  })

  it('a group that is gone falls back to the box, not the root', () => {
    const s = saveCanvas(graphic('Munkadarabok/Nincs-ilyen'), emptyCanvas())
    if (!s.ok) throw new Error(s.code)
    expect(s.rel.slice('P/Hivatal/'.length).includes('/')).toBe(true)
  })

  it('an item the owner put directly in the project folder keeps its JSON there', () => {
    const s = saveCanvas(graphic(PROJECT_ROOT_PLACE), emptyCanvas())
    if (!s.ok) throw new Error(s.code)
    expect(s.rel.slice('P/Hivatal/'.length).includes('/')).toBe(false)
  })

  it('an item made from an existing file keeps its next versions beside that file (no split into the box)', () => {
    mkdirSync(join(dir, 'P', 'Hivatal', 'Anyagok'), { recursive: true })
    const s = saveCanvas(graphic(null, 'P/Hivatal/Anyagok/rajz.canvas.json'), emptyCanvas())
    if (!s.ok) throw new Error(s.code)
    expect(s.rel.startsWith('P/Hivatal/Anyagok/')).toBe(true)
  })

  it('a current file in the project root does not pull the next version into the root', () => {
    const s = saveCanvas(graphic(null, 'P/Hivatal/regi.canvas.json'), emptyCanvas())
    if (!s.ok) throw new Error(s.code)
    expect(s.rel.slice('P/Hivatal/'.length).includes('/')).toBe(true)
  })
})
