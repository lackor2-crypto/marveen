// TG 2696: the first save stays in the work item folder, every later saved version goes together into its "Verziók" subfolder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, createWorkItemVersion, getWorkItem, type WorkItemRow } from '../workbench.js'
import { ensureWorkItemFolder, workItemFolder } from '../workbench-assets.js'
import { applyDeckOps, deckStore, emptyDeck } from '../workbench-deck.js'
import { emptyCanvas, applyCanvasOps } from '../workbench-graphic.js'
import { commitCanvasChange, saveCanvasVersion } from '../workbench-canvas-store.js'
import { trimVideo, saveVideoFrame, _setVideoDeps, type Runner } from '../workbench-video.js'
import { renderTimeline, _setRenderDeps } from '../workbench-video-render.js'
import { applyTimelineOps, emptyTimeline, timelineStore } from '../workbench-video-timeline.js'
import { exportDeck } from '../workbench-deck-export.js'
import { savePostFile } from '../workbench-post-files.js'

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
  _setVideoDeps()
  _setRenderDeps()
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

function item(type: 'presentation' | 'graphic' | 'video' | 'composite', withFolder: boolean): { it: WorkItemRow; folder: string | null } {
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

// #496: the card names three kinds (drawing, deck, video). The files MADE from an item -- a trimmed cut (a new
// version), the rendered video of a timeline, a deck export, a post picture -- also stay with the item, never in the
// project root. Fake ffmpeg: it writes its output (the last argument), as the real one does.
describe('files made from a work item stay with it, not in the project root (#496)', () => {
  const fakeRun: Runner = async (_cmd, args) => { writeFileSync(args[args.length - 1], 'OUT'); return { ok: true } }
  const fakeVideo = () => {
    _setVideoDeps({ run: fakeRun, tool: async () => ({ state: 'ok', path: '/fake/ffmpeg', detail: null }) })
    _setRenderDeps({ probe: async () => ({ audio: true, duration: 10 }), filters: async () => true })
  }
  const timelineWith = (src: string) => {
    const r = applyTimelineOps(emptyTimeline(), [{ op: 'addClip', src, start: 0, end: 2 }])
    if (!r.ok) throw new Error('timeline: ' + r.detail)
    return r.doc
  }
  const png = (w: number, h: number): Buffer => {
    const b = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
    b.writeUInt32BE(13, 8)
    b.write('IHDR', 12, 'ascii')
    b.writeUInt32BE(w, 16)
    b.writeUInt32BE(h, 20)
    return b
  }

  it('video trim: the cut is a new version, so it goes into the Verziók folder of the item, not beside the first file', async () => {
    fakeVideo()
    const { it: w, folder } = item('video', true)
    writeFileSync(join(root(), folder as string, 'klip.webm'), 'not really a video')
    const v = createWorkItemVersion(w.id, { source_path: `Projektek/Robotok/${folder}/klip.webm` })
    if (!v.ok) throw new Error('version')
    const r = await trimVideo(v.item, proj(), { start: 0, end: 2, baseVersion: v.item.current_version_id })
    expect(r).toMatchObject({ ok: true, file: { rel: `Projektek/Robotok/${folder}/Verziók/klip.mp4` } })
    expect(files(folder as string)).toEqual(['klip.webm'])
    expect(files()).toEqual([])
    // A frame of the cut is not a version: it goes into the item folder, not among the old versions.
    if (!r.ok) throw new Error('trim')
    const f = await saveVideoFrame(r.item, proj(), { at: 1, baseVersion: r.version.id, lang: 'hu' })
    expect(f).toMatchObject({ ok: true, file: { rel: `Projektek/Robotok/${folder}/klip 0-01.png` } })
    expect(files(`${folder}/Verziók`)).toEqual(['klip.mp4'])
  })

  it('video render: the mp4 goes into the item folder -- not beside its first clip in the root, not into Verziók', async () => {
    fakeVideo()
    writeFileSync(join(root(), 'a.mp4'), 'clip')
    const { it: w, folder } = item('video', true)
    const store = timelineStore()
    expect(store.commit(w, timelineWith('Projektek/Robotok/a.mp4'), { actor: 'test' })).toMatchObject({ ok: true })
    expect(store.saveVersion(getWorkItem(w.id)!, { label: 'v1' })).toMatchObject({ ok: true })
    const doc = timelineWith('Projektek/Robotok/a.mp4')
    expect(await renderTimeline(proj(), w.id, w.title, doc)).toMatchObject({ ok: true, file: { rel: `Projektek/Robotok/${folder}/Nevjegy.mp4` } })
    // A later render (the timeline JSON is in Verziók by now) still lands with the item.
    expect(store.commit(getWorkItem(w.id)!, timelineWith('Projektek/Robotok/a.mp4'), { actor: 'test', label: 'x' })).toMatchObject({ ok: true })
    expect(await renderTimeline(proj(), w.id, w.title, doc)).toMatchObject({ ok: true, file: { name: 'Nevjegy (2).mp4' } })
    expect(files(folder as string).filter((n) => n.endsWith('.mp4'))).toEqual(['Nevjegy (2).mp4', 'Nevjegy.mp4'])
    expect(files()).toEqual(['a.mp4'])
  })

  it('video render of a folderless item: beside its timeline (the work-items box), not beside the clip in the root', async () => {
    fakeVideo()
    writeFileSync(join(root(), 'a.mp4'), 'clip')
    const { it: w } = item('video', false)
    expect(timelineStore().commit(w, timelineWith('Projektek/Robotok/a.mp4'), { actor: 'test' })).toMatchObject({ ok: true })
    const r = await renderTimeline(proj(), w.id, w.title, timelineWith('Projektek/Robotok/a.mp4'))
    if (!r.ok) throw new Error('render: ' + r.code)
    const box = r.file.rel.split('/').slice(2, -1).join('/')
    expect(box).not.toBe('')
    expect(files(box)).toContain('Nevjegy.mp4')
    expect(files(box).some((n) => n.endsWith('.timeline.json'))).toBe(true)
    expect(files()).toEqual(['a.mp4'])
  })

  it('deck export with no deck file yet: into the item folder; a folderless item: into the box -- never the root', async () => {
    const { it: w, folder } = item('presentation', true)
    const a = await exportDeck(proj(), w, null, deckWith('elso'), 'pptx')
    expect(a).toMatchObject({ ok: true, file: { rel: `Projektek/Robotok/${folder}/nevjegy.pptx` } })
    const { it: loose } = item('presentation', false)
    const b = await exportDeck(proj(), loose, null, deckWith('elso'), 'pptx')
    if (!b.ok) throw new Error('export: ' + b.code)
    expect(b.file.rel.split('/').slice(2, -1).join('/')).not.toBe('')
    expect(files()).toEqual([])
  })

  it('an older item whose deck file still sits in the project root (the measured case): the export goes to its folder', async () => {
    const { it: w, folder } = item('presentation', true)
    writeFileSync(join(root(), 'diak.deck.json'), '{}')
    const r = await exportDeck(proj(), w, 'Projektek/Robotok/diak.deck.json', deckWith('elso'), 'pptx')
    expect(r).toMatchObject({ ok: true, file: { rel: `Projektek/Robotok/${folder}/nevjegy.pptx` } })
    expect(files()).toEqual(['diak.deck.json'])
  })

  it('post picture: into the item folder, not the project root', () => {
    const { it: w, folder } = item('composite', true)
    const r = savePostFile(w, proj(), 'fb_square', png(1080, 1080), 'test')
    expect(r).toMatchObject({ ok: true, file: { rel: `Projektek/Robotok/${folder}/Nevjegy - fb_square 1080x1080.png` } })
    expect(files()).toEqual([])
  })
})
