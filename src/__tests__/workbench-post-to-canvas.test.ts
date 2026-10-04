// #493: an existing composite (parts list) post can be converted, on request, to a sized canvas post.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { parseCanvas } from '../workbench-graphic.js'
import { commitCanvasChange, readCanvas } from '../workbench-canvas-store.js'

let dir = ''
let pid = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-postcanvas-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Poszt' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Poszt' }).ok) throw new Error('mappa')
  mkdirSync(join(dir, 'Projektek', 'Poszt'), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('composite post -> canvas', () => {
  it('a composite item takes a platform-sized canvas with its text on it, and the parts are untouched', () => {
    const r = createWorkItem({ project_id: pid, type: 'composite', title: 'Kozossegi poszt' })
    if (!r.ok) throw new Error('item')
    expect(readCanvas(r.item.id).ok).toBe(true)
    // The shape the front end builds (postCanvasDoc): headline + body text on a 1200 x 630 canvas.
    const parsed = parseCanvas({
      width: 1200, height: 630, background: '#ffffff', objects: [
        { type: 'text', text: 'Cim', x: 72, y: 36, width: 1056, height: 156, fontSize: 60, color: '#111111', bold: true, align: 'left' },
        { type: 'text', text: 'Szoveg', x: 72, y: 200, width: 1056, height: 300, fontSize: 34, color: '#333333', align: 'left' },
      ],
    })
    if (!parsed.ok) throw new Error('parse: ' + parsed.detail)
    const c = commitCanvasChange(getWorkItem(r.item.id)!, parsed.doc, { source: 'owner', label: 'replace' })
    expect(c.ok).toBe(true)
    const after = readCanvas(r.item.id)
    if (!after.ok) throw new Error('read')
    expect(after.exists).toBe(true)
    expect([after.doc.width, after.doc.height]).toEqual([1200, 630])
    expect(after.doc.objects).toHaveLength(2)
  })
})

describe('front end contract', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  const hu = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf8')
  const en = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf8')

  it('offers the conversion only on a composite item without a canvas, never automatically', () => {
    expect(js).toContain("it.type !== 'composite' || archived() || !WB.canvas || WB.canvas.exists")
    expect(js).toContain("a === 'post-to-canvas'")
    expect(js).toContain("item.type === 'composite')) loadCanvas(id)")
  })
  it('has the labels in Hungarian and English', () => {
    for (const k of ['tocanvas_title', 'tocanvas_hint', 'tocanvas_go']) {
      expect(hu).toContain(`"workbench.post.${k}"`)
      expect(en).toContain(`"workbench.post.${k}"`)
    }
  })
})
