// TG 2696: the first save stays in the work item folder, every later saved version goes together into its "Verziók" subfolder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem, type WorkItemRow } from '../workbench.js'
import { ensureWorkItemFolder, workItemFolder } from '../workbench-assets.js'
import { applyDeckOps, deckStore, emptyDeck } from '../workbench-deck.js'
import { emptyCanvas, applyCanvasOps } from '../workbench-graphic.js'
import { commitCanvasChange, saveCanvasVersion } from '../workbench-canvas-store.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const files = (sub = '') => readdirSync(join(root(), ...sub.split('/').filter(Boolean)), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-verfolder-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('projektmappa')
  mkdirSync(root(), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

function item(type: 'presentation' | 'graphic', withFolder: boolean): { it: WorkItemRow; folder: string | null } {
  const r = createWorkItem({ project_id: pid, title: 'Nevjegy', type })
  if (!r.ok) throw new Error('item: ' + r.code)
  if (!withFolder) return { it: r.item, folder: null }
  const f = ensureWorkItemFolder(r.item)
  if (!f.ok) throw new Error('folder: ' + f.code)
  return { it: getWorkItem(r.item.id)!, folder: f.folder }
}

function deckWith(text: string) {
  const r = applyDeckOps(emptyDeck(), [{ op: 'addSlide', layout: 'blank' }, { op: 'slide', id: 'd1', ops: [{ op: 'add', type: 'text', id: 't', text }] }])
  if (!r.ok) throw new Error('deck: ' + r.detail)
  return r.doc
}

function canvasWith(text: string) {
  const r = applyCanvasOps(emptyCanvas(), [{ op: 'add', type: 'text', id: 't', text }])
  if (!r.ok) throw new Error('canvas: ' + r.detail)
  return r.doc
}

describe('saved versions are kept in a Verziók folder inside the item folder (TG 2696)', () => {
  it('deck: first file in the item folder, the saved version in Verziók, nothing in the project root', () => {
    const { it: w, folder } = item('presentation', true)
    const store = deckStore()
    expect(store.commit(w, deckWith('elso'), { actor: 'test' })).toMatchObject({ ok: true })
    expect(files(folder as string).filter((n) => n.startsWith('nevjegy.deck'))).toHaveLength(1)
    expect(store.commit(getWorkItem(w.id)!, deckWith('masodik'), { actor: 'test' })).toMatchObject({ ok: true, changed: true })
    expect(store.saveVersion(getWorkItem(w.id)!, { label: 'v2' })).toMatchObject({ ok: true, created: true })
    expect(files(`${folder}/Verziók`).filter((n) => n.startsWith('nevjegy.deck'))).toHaveLength(1)
    expect(files().filter((n) => n.endsWith('.json'))).toEqual([])
    const paths = getDb().prepare('SELECT source_path FROM work_item_versions WHERE work_item_id = ? AND source_path IS NOT NULL').all(w.id) as { source_path: string }[]
    expect(paths.some((p) => p.source_path.includes('/Verziók/'))).toBe(true)
  })

  it('drawing: the saved version goes to Verziók too, and a second one reuses the same folder', () => {
    const { it: w, folder } = item('graphic', true)
    expect(commitCanvasChange(w, canvasWith('elso'), { actor: 'test' })).toMatchObject({ ok: true })
    expect(commitCanvasChange(getWorkItem(w.id)!, canvasWith('masodik'), { actor: 'test' })).toMatchObject({ ok: true })
    expect(saveCanvasVersion(getWorkItem(w.id)!, { label: 'v2' })).toMatchObject({ ok: true, created: true })
    expect(commitCanvasChange(getWorkItem(w.id)!, canvasWith('harmadik'), { actor: 'test' })).toMatchObject({ ok: true })
    expect(saveCanvasVersion(getWorkItem(w.id)!, { label: 'v3' })).toMatchObject({ ok: true, created: true })
    expect(files(folder as string).filter((n) => n.startsWith('nevjegy.canvas'))).toHaveLength(1)
    expect(files(`${folder}/Verziók`).filter((n) => n.startsWith('nevjegy.canvas')).length).toBeGreaterThanOrEqual(2)
  })

  it('an older item with no folder: no own folder is made, and the JSON goes next to it (the box), not the root (TG 2929)', () => {
    const { it: w } = item('presentation', false)
    const c = deckStore().commit(w, deckWith('elso'), { actor: 'test' })
    expect(c).toMatchObject({ ok: true })
    expect(files().filter((n) => n.endsWith('.deck.json'))).toHaveLength(0)
    expect(workItemFolder(w.id)).toBeNull()
  })
})

