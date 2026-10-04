// #491 (Boss): a work item always moves AS A WHOLE -- its folder with every file, and a presentation's slide
// pictures keep pointing at the files. Nothing is left behind and no picture path goes dead.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { makeWorkFolder, ensureWorkItemFolder, moveWorkItemToFolder } from '../workbench-assets.js'
import { applyDeckOps, deckStore, emptyDeck } from '../workbench-deck.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const abs = (rel: string) => join(root(), ...rel.split('/'))

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-deckmove-'))
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

function group(name: string): string {
  const g = makeWorkFolder(proj(), '', name)
  if (!g.ok) throw new Error('mk: ' + g.code)
  return g.folder
}

/** A presentation in group `g` with 3 pictures in its folder, every one placed on a slide. */
function deckIn(g: string) {
  const r = createWorkItem({ project_id: pid, title: 'Bemutato', type: 'presentation', container_folder: g })
  if (!r.ok) throw new Error('item: ' + r.code)
  const f = ensureWorkItemFolder(r.item)
  if (!f.ok) throw new Error('folder: ' + f.code)
  const rel = `Projektek/Robotok/${f.folder}`
  const pics = ['a.png', 'b.png', 'c.png']
  for (const n of pics) writeFileSync(join(abs(f.folder), n), 'PNG-' + n)
  const ops = applyDeckOps(emptyDeck(), [
    { op: 'addSlide' },
    ...pics.map((n) => ({ op: 'slide', id: 'd1', ops: [{ op: 'add', type: 'image', id: 'i-' + n, src: `${rel}/${n}`, x: 0, y: 0, width: 100, height: 100 }] })),
  ])
  if (!ops.ok) throw new Error('deck: ' + ops.detail)
  const saved = deckStore().save(getWorkItem(r.item.id)!, ops.doc, { sub: f.folder })
  if (!saved.ok) throw new Error('save')
  return { id: r.item.id, folder: f.folder, rel, pics }
}

function pictureSrcs(id: string): string[] {
  const read = deckStore().read(id)
  if (!read.ok) throw new Error('read')
  const out: string[] = []
  for (const s of read.doc.slides) for (const o of s.canvas.objects) if ((o as { src?: string }).src) out.push((o as { src: string }).src)
  return out
}

describe('a presentation moves as one piece (#491)', () => {
  it('into a group that holds another item: the whole folder moves, every picture file and every slide path follows', () => {
    const from = group('Elso')
    const to = group('Masodik')
    const other = createWorkItem({ project_id: pid, title: 'Masik', type: 'note', container_folder: to })
    if (!other.ok) throw new Error('other')
    if (!ensureWorkItemFolder(other.item).ok) throw new Error('other folder')
    const d = deckIn(from)

    const r = moveWorkItemToFolder(getWorkItem(d.id)!, to)

    expect(r).toMatchObject({ ok: true, moved: true })
    const now = getWorkItem(d.id)!.folder as string
    expect(now.startsWith(to + '/')).toBe(true)
    expect(existsSync(abs(d.folder))).toBe(false) // nothing left behind
    expect(readdirSync(abs(now)).filter((n) => n.endsWith('.png')).sort()).toEqual(d.pics)
    const srcs = pictureSrcs(d.id)
    expect(srcs).toHaveLength(3)
    for (const s of srcs) {
      expect(s.startsWith(`Projektek/Robotok/${now}/`)).toBe(true)
      expect(existsSync(join(dir, ...s.split('/')))).toBe(true) // no dead link
    }
  })

  it('into an empty group: the pictures land directly in the group and the slide paths follow', () => {
    const from = group('Elso')
    const to = group('Ures')
    const d = deckIn(from)

    const r = moveWorkItemToFolder(getWorkItem(d.id)!, to)

    expect(r).toMatchObject({ ok: true, moved: true })
    expect(getWorkItem(d.id)!.folder).toBe(to)
    expect(readdirSync(abs(to)).filter((n) => n.endsWith('.png')).sort()).toEqual(d.pics)
    expect(existsSync(abs(d.folder))).toBe(false)
    for (const s of pictureSrcs(d.id)) {
      expect(s.startsWith(`Projektek/Robotok/${to}/`)).toBe(true)
      expect(existsSync(join(dir, ...s.split('/')))).toBe(true)
    }
  })
})
