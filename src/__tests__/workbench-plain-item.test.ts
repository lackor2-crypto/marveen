// #717 (Boss TG 3759): "Munkadarabba tétel" on a file that already exists makes a PLAIN item: the file stays where it is and
// nothing is generated (no folder, no context file, no to-do file). A brand new item keeps its folder and files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { sweepItemContexts, readItemContext, isPlainItem, markPlainItem } from '../workbench-item-context.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let pid = ''
let projDir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-plain-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Plain' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Plain' }).ok) throw new Error('projektmappa')
  projDir = join(dir, 'Projektek', 'Plain')
  mkdirSync(projDir, { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('an item made from an existing file is plain', () => {
  it('points at the file in place and generates no folder, context or to-do file, even after a sweep', async () => {
    writeFileSync(join(projDir, 'Antrag.docx'), 'x')
    const before = readdirSync(projDir)
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'Antrag', source_path: 'Projektek/Plain/Antrag.docx', folder: 'Projektek/Plain' })
    expect(c.status).toBe(201)
    const id = c.body.item.id as string
    expect(getWorkItem(id)!.source_path).toBe('Projektek/Plain/Antrag.docx')
    expect(isPlainItem(id)).toBe(true)
    await sweepItemContexts()
    expect(readdirSync(projDir)).toEqual(before)
    expect(readItemContext(getWorkItem(id)!)).toBeNull()
  })

  it('a brand new item still gets its own folder (unchanged behaviour)', async () => {
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'Uj dokumentum' })
    expect(c.status).toBe(201)
    expect(isPlainItem(c.body.item.id as string)).toBe(false)
    expect(readdirSync(projDir).length).toBeGreaterThan(0)
  })

  it('a context and to-do file made before the item was marked plain are removed while untouched', async () => {
    writeFileSync(join(projDir, 'Antrag.docx'), 'x')
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'Antrag', source_path: 'Projektek/Plain/Antrag.docx', folder: 'Projektek/Plain' })
    const id = c.body.item.id as string
    const { ensureItemContext } = await import('../workbench-item-context.js')
    const { ensureItemTodoFile } = await import('../workbench-item-todos.js')
    const { getProject } = await import('../projects.js')
    const project = getProject(pid)!
    // simulate the old behaviour: the files were generated first
    getDb().prepare('DELETE FROM work_item_plain WHERE item_id = ?').run(id)
    ensureItemContext(getWorkItem(id)!, project)
    ensureItemTodoFile(getWorkItem(id)!, project)
    expect(readItemContext(getWorkItem(id)!)).not.toBeNull()
    markPlainItem(id)
    await sweepItemContexts()
    expect(readItemContext(getWorkItem(id)!)).toBeNull()
    expect(readdirSync(join(projDir, ...(getWorkItem(id)!.container_folder ? [] : []))).filter((n) => /^(Kontextus|Teend)/.test(n))).toEqual([])
  })
})

// #721 (Boss TG 3914): finalizing a plain item made a NEW folder named after it (with its own "Elkeszitett anyagok")
// next to the file, and the finished PDF went there instead of the existing "Elkeszitett anyagok" beside the file.
describe('a plain item never gets a folder of its own (#721)', () => {
  async function plainIn(sub: string, file: string): Promise<string> {
    mkdirSync(join(projDir, sub), { recursive: true })
    writeFileSync(join(projDir, sub, file), 'x')
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: file.replace(/\.[^.]+$/, ''), source_path: `Projektek/Plain/${sub}/${file}`, folder: `Projektek/Plain/${sub}` })
    expect(c.status).toBe(201)
    const id = c.body.item.id as string
    expect(isPlainItem(id)).toBe(true)
    return id
  }

  it('the finished PDF goes into the existing "Elkészített anyagok" beside the file; no folder named after the item', async () => {
    const { attachAsset } = await import('../workbench-assets.js')
    mkdirSync(join(projDir, 'Munkadarabok', 'Szoc', 'Elkészített anyagok'), { recursive: true })
    const id = await plainIn('Munkadarabok/Szoc', 'Antrag.docx')
    const before = readdirSync(join(projDir, 'Munkadarabok', 'Szoc')).sort()
    const r = attachAsset(getWorkItem(id)!, 'Antrag - végleges.pdf', Buffer.from('%PDF-1.4 x'), { force: true, into: 'finished' })
    expect(r.ok).toBe(true)
    expect(readdirSync(join(projDir, 'Munkadarabok', 'Szoc')).sort()).toEqual(before)
    expect(readdirSync(join(projDir, 'Munkadarabok', 'Szoc', 'Elkészített anyagok'))).toEqual(['Antrag - végleges.pdf'])
    expect(getWorkItem(id)!.folder ?? null).toBeNull()
  })

  it('without an existing one, only the "Elkészített anyagok" beside the file is made -- no other standard folder', async () => {
    const { attachAsset, ensureWorkItemFolder } = await import('../workbench-assets.js')
    const id = await plainIn('Iratok', 'Level.docx')
    const f = ensureWorkItemFolder(getWorkItem(id)!)
    expect(f).toMatchObject({ ok: true, folder: 'Iratok', created: false })
    expect(readdirSync(join(projDir, 'Iratok'))).toEqual(['Level.docx'])
    expect(attachAsset(getWorkItem(id)!, 'Level.pdf', Buffer.from('%PDF-1.4 y'), { force: true, into: 'finished' }).ok).toBe(true)
    expect(readdirSync(join(projDir, 'Iratok')).sort()).toEqual(['Elkészített anyagok', 'Level.docx'])
    expect(getWorkItem(id)!.folder ?? null).toBeNull()
  })

  it('"tidy into a folder" is the owner asking for an own folder: only then does a plain item get one', async () => {
    const { tidyWorkItemIntoFolder } = await import('../workbench-assets.js')
    const id = await plainIn('Iratok', 'Level.docx')
    const t = tidyWorkItemIntoFolder(getWorkItem(id)!)
    expect(t.ok).toBe(true)
    expect(isPlainItem(id)).toBe(false)
    expect(String(getWorkItem(id)!.folder ?? '')).not.toBe('')
  })

  it('source guard: the plain check stands before any folder is made for an item without one', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(process.cwd(), 'src', 'workbench-assets.ts'), 'utf8')
    const core = src.slice(src.indexOf('function ensureWorkItemFolderCore'))
    expect(core.indexOf('isPlainItem(item.id)')).toBeGreaterThan(0)
    expect(core.indexOf('isPlainItem(item.id)')).toBeLessThan(core.indexOf('makeFreshFolder('))
  })
})
