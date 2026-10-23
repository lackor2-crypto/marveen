// #709 (Boss TG 9894, 10243): the first work item of a folder, its folder and its files carry one name; later items are free.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder, assignWorkItemFolder, makeWorkFolder } from '../workbench-assets.js'
import { sweepItemContexts, contextFileName } from '../workbench-item-context.js'
import { renameItemTogether, renameFolderTogether, anchorOfFolder } from '../workbench-rename-together.js'

let dir = ''
let pid = ''
let aId = ''
let folder = ''
const project = () => getProject(pid)!
const abs = (rel: string) => join(dir, ...rel.split('/'))

beforeEach(async () => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-rt-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Video' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Video' }).ok) throw new Error('projektmappa')
  mkdirSync(abs('Projektek/Video'), { recursive: true })
  const a = createWorkItem({ project_id: pid, type: 'document', title: 'Uj video' })
  if (!a.ok) throw new Error('munkadarab')
  aId = a.item.id
  const f = ensureWorkItemFolder(a.item)
  if (!f.ok) throw new Error('mappa')
  folder = f.folder
  // the item's own file: a timeline JSON named after the item, as the video editor makes it
  const dirRel = `Projektek/Video/${folder}`
  writeFileSync(abs(`${dirRel}/uj-video.timeline.json`), '{}')
  getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(`${dirRel}/uj-video.timeline.json`, aId)
  await sweepItemContexts()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

const files = (rel: string) => readdirSync(abs(rel))

describe('#709: the first item and its folder carry one name', () => {
  it('the first item is the anchor of its own folder', () => {
    expect(anchorOfFolder(pid, folder)?.id).toBe(aId)
  })

  it('renaming the anchor renames the folder, the timeline JSON and the context file together', () => {
    const r = renameItemTogether(getWorkItem(aId)!, 'Apu video PROBA')
    expect(r.ok).toBe(true)
    const it = getWorkItem(aId)!
    expect(it.title).toBe('Apu video PROBA')
    expect(it.folder).not.toBe(folder)
    expect(it.folder!.endsWith('/Apu video PROBA') || it.folder === 'Apu video PROBA').toBe(true)
    const dirRel = `Projektek/Video/${it.folder}`
    const names = files(dirRel)
    expect(names).toContain('apu-video-proba.timeline.json')
    expect(names).not.toContain('uj-video.timeline.json')
    expect(names).toContain(contextFileName('Apu video PROBA'))
    expect(it.source_path).toBe(`${dirRel}/apu-video-proba.timeline.json`)
    expect(existsSync(abs(`Projektek/Video/${folder}`))).toBe(false)
  })

  it('an item that never had a context pass still renames its timeline JSON cleanly (no old name left inside the new one)', () => {
    getDb().prepare('DELETE FROM work_item_context').run()
    const r = renameItemTogether(getWorkItem(aId)!, 'Apu video PROBA')
    expect(r.ok).toBe(true)
    const it = getWorkItem(aId)!
    const names = files(`Projektek/Video/${it.folder}`)
    expect(names).toContain('apu-video-proba.timeline.json')
    expect(names.filter((n) => n.includes('uj-video'))).toEqual([])
  })

  it('a later item of the same folder is free: renaming it changes neither the folder nor the anchor', () => {
    const b = createWorkItem({ project_id: pid, type: 'document', title: 'Masodik' })
    if (!b.ok) throw new Error('b')
    assignWorkItemFolder(b.item.id, folder)
    expect(anchorOfFolder(pid, folder)?.id).toBe(aId)
    const r = renameItemTogether(getWorkItem(b.item.id)!, 'Teljesen mas nev')
    expect(r.ok).toBe(true)
    expect(getWorkItem(b.item.id)!.title).toBe('Teljesen mas nev')
    expect(getWorkItem(aId)!.title).toBe('Uj video')
    expect(getWorkItem(aId)!.folder).toBe(folder)
    expect(existsSync(abs(`Projektek/Video/${folder}`))).toBe(true)
  })

  it('renaming the folder gives the anchor the folder name, and leaves a later item alone', () => {
    const b = createWorkItem({ project_id: pid, type: 'document', title: 'Masodik' })
    if (!b.ok) throw new Error('b')
    assignWorkItemFolder(b.item.id, folder)
    const r = renameFolderTogether(project(), folder, 'Uj kozos nev')
    expect(r.ok).toBe(true)
    expect(getWorkItem(aId)!.title).toBe('Uj kozos nev')
    expect(getWorkItem(b.item.id)!.title).toBe('Masodik')
    const dirRel = `Projektek/Video/${getWorkItem(aId)!.folder}`
    expect(files(dirRel)).toContain('uj-kozos-nev.timeline.json')
  })

  it('a taken folder name never blocks the title change and never overwrites anything', () => {
    const mk = makeWorkFolder(project(), '', 'Foglalt')
    if (!mk.ok) throw new Error('foglalt')
    writeFileSync(abs(`Projektek/Video/${mk.folder}/marker.txt`), 'x')
    const r = renameItemTogether(getWorkItem(aId)!, 'Foglalt')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.folder).toMatchObject({ ok: true, renamed: false, reason: 'name_taken' })
    expect(getWorkItem(aId)!.title).toBe('Foglalt')
    expect(getWorkItem(aId)!.folder).toBe(folder)
    expect(readdirSync(abs(`Projektek/Video/${mk.folder}`))).toContain('marker.txt')
  })
})
