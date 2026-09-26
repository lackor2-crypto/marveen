// #406, 16. pont -- KEPSZERKESZTES EGERREL: a szerkesztes a bongeszoben
// (vagas, forgatas, meret, felirat, egyszinu hatter), a mentes UJ fajl + UJ
// verzio. Itt: a szerver mentese, a kep tiszta lepesei, es a felulet.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, setProjectArchived } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { sniffImage, editedImageName } from '../workbench-image-edit.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])

describe('a mentes a szerveren', () => {
  let depot = ''
  let pid = ''
  const dir = () => join(depot, 'Projektek', 'teszt')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-img-'))
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Kovács ház' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/teszt' }).ok) throw new Error('mappa')
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function imageItem(name: string, bytes: Buffer) {
    writeFileSync(join(dir(), name), bytes)
    const w = createWorkItem({ project_id: pid, title: 'Fotó', type: 'image', source_path: `Projektek/teszt/${name}` })
    if (!w.ok) throw new Error('mu')
    return w.item
  }

  it('a kesz kep UJ fajlba kerul a regi melle + UJ verzio; a regi kep bajtra erintetlen', async () => {
    const it0 = imageItem('foto.png', PNG)
    const r = await callWorkbench(`/api/workbench/items/${it0.id}/image-edit?base_version=${it0.current_version_id}`, 'POST', PNG, { 'content-type': 'image/png' })
    expect(r.status).toBe(201)
    expect(r.body.name).toBe('foto (2).png')
    expect(r.body.version.version_no).toBe(2)
    expect(readdirSync(dir()).sort()).toEqual(['foto (2).png', 'foto.png'])
    expect(readFileSync(join(dir(), 'foto.png')).equals(PNG)).toBe(true)
    // A kovetkezo mentes a MOSTANI (2.) verziora szol.
    const again = await callWorkbench(`/api/workbench/items/${it0.id}/image-edit?base_version=${r.body.version.id}`, 'POST', PNG)
    expect(again.body.name).toBe('foto (3).png')
  })

  it('a kiterjesztes a TARTALOMBOL jon: jpg forras + atlatszo (PNG) eredmeny -> foto.png', async () => {
    const it0 = imageItem('foto.jpg', JPG)
    const r = await callWorkbench(`/api/workbench/items/${it0.id}/image-edit?base_version=${it0.current_version_id}`, 'POST', PNG)
    expect(r.status).toBe(201)
    expect(r.body.name).toBe('foto.png')
  })

  it('kozben ujabb verzio -> 409; nem kep-tartalom -> 400; archivalt -> 409; nem kep munkadarab -> 400, mind emberi mondattal', async () => {
    const it0 = imageItem('foto.png', PNG)
    const stale = await callWorkbench(`/api/workbench/items/${it0.id}/image-edit?base_version=regi`, 'POST', PNG)
    expect(stale.status).toBe(409)
    expect(stale.body.message).toMatch(/új verzió készült/)
    const notImg = await callWorkbench(`/api/workbench/items/${it0.id}/image-edit?base_version=${it0.current_version_id}&lang=en`, 'POST', Buffer.from('<svg/>'))
    expect(notImg.status).toBe(400)
    expect(notImg.body.message).toMatch(/not a PNG, JPEG or WebP/)

    writeFileSync(join(dir(), 'jegyzet.md'), '# x')
    const note = createWorkItem({ project_id: pid, title: 'J', type: 'note', source_path: 'Projektek/teszt/jegyzet.md' })
    if (!note.ok) throw new Error('note')
    const bad = await callWorkbench(`/api/workbench/items/${note.item.id}/image-edit?base_version=${note.item.current_version_id}`, 'POST', PNG)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('image_edit_unsupported')

    setProjectArchived(pid, true)
    const arch = await callWorkbench(`/api/workbench/items/${it0.id}/image-edit?base_version=${it0.current_version_id}`, 'POST', PNG)
    expect(arch.status).toBe(409)
    expect(arch.body.error).toBe('project_archived')
    expect(readdirSync(dir()).sort()).toEqual(['foto.png', 'jegyzet.md'])
  })

  it('eltunt forraskep: a "nincs ott" mondat, nem 500', async () => {
    const it0 = imageItem('foto.png', PNG)
    rmSync(join(dir(), 'foto.png'))
    const r = await callWorkbench(`/api/workbench/items/${it0.id}/image-edit?base_version=${it0.current_version_id}`, 'POST', PNG)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('preview_missing')
    expect(r.body.message).not.toBe('preview_missing')
  })

  it('sniffImage / editedImageName', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(JPG)).toBe('jpg')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull()
    expect(editedImageName('Projektek/a/nyar (2).jpg', 'png')).toBe('nyar (2).png')
  })
})

describe('a felulet', () => {
  const ITEM = { id: 'w1', title: 'Fotó', type: 'image', status: 'draft', current_version_id: 'v1' }
  const PREVIEW = { available: true, kind: 'image', rel: 'P/foto.jpg', name: 'foto.jpg', url: '/api/life/file?rel=P%2Ffoto.jpg', version_id: 'v1' }
  let savedImage: unknown

  beforeEach(() => {
    savedImage = (globalThis as Record<string, unknown>)['Image']
    // A bongeszo Image-e: betolteskor 400x200-as kepet "ad".
    ;(globalThis as Record<string, unknown>)['Image'] = class {
      naturalWidth = 400
      naturalHeight = 200
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) { setTimeout(() => this.onload && this.onload(), 0) }
    }
  })
  afterEach(() => { (globalThis as Record<string, unknown>)['Image'] = savedImage })

  function setup(opts: { archived?: boolean } = {}) {
    const h = workbenchHarness()
    const project = { id: 'p1', name: 'Kovács ház', archived: !!opts.archived }
    h.respond((url) => {
      if (url.includes('/preview')) return { status: 200, body: PREVIEW }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: ITEM, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project } }
      return { status: 200, body: itemsBody([ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács ház')
    return h
  }

  async function select(h: ReturnType<typeof workbenchHarness>) {
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-preview-image'))
  }

  it('a kep mellett ott a "Kep szerkesztese"; megnyitva vagokeret, aranyok, forgatas, felirat, hatter -- es nincs kezzel irt magyar', async () => {
    const h = setup()
    await select(h)
    expect(h.html()).toContain('data-wb-act="img-open"')
    h.click({ 'data-wb-act': 'img-open' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-crop="move"'))
    const html = h.html()
    expect(html).toContain('style="left:0%;top:0%;width:100%;height:100%"')
    for (const h2 of ['nw', 'ne', 'sw', 'se']) expect(html).toContain(`data-wb-crop="${h2}"`)
    expect(html).toContain('data-wb-aspect="1:1"')
    expect(html).toContain('data-wb-act="img-rot-left"')
    expect(html).toContain('id="wbImgCapText"')
    expect(html).toContain('data-wb-act="img-bg-pick"')
    expect(html).toContain('⟦workbench.img.out_size:{"w":400,"h":200}⟧')
    expect(untranslatedHungarian(html, ['Kovács ház', 'Fotó'])).toBe('')

    // 1:1 arany: kozepre igazitott negyzet.
    h.click({ 'data-wb-act': 'img-aspect', 'data-wb-aspect': '1:1' })
    expect(h.html()).toContain('style="left:25%;top:0%;width:50%;height:100%"')
    // Forgatas: a kep 200x400 lesz; a valasztott 1:1 arany MARAD (kozepen).
    h.click({ 'data-wb-act': 'img-rot-right' })
    expect(h.html()).toContain('style="left:0%;top:25%;width:100%;height:50%"')
    expect(h.html()).toContain('⟦workbench.img.out_size:{"w":200,"h":200}⟧')
    // Szam-mezo: a keret szelessege kepben (az arany innen szabad).
    h.fire('input', { target: { id: 'wbImgCw', value: '100' } })
    h.click({ 'data-wb-act': 'img-size-half' })
    expect(h.html()).toContain('⟦workbench.img.out_size:{"w":50,"h":100}⟧')
    expect(h.html()).toContain('data-wb-aspect="free">')
    h.click({ 'data-wb-act': 'img-rot-left' })
    h.click({ 'data-wb-act': 'img-aspect', 'data-wb-aspect': 'free' })
    expect(h.html()).toContain('⟦workbench.img.out_size:{"w":400,"h":200}⟧')
  })

  it('archivalt projektben nincs szerkeszto-gomb', async () => {
    const h = setup({ archived: true })
    await select(h)
    expect(h.html()).not.toContain('data-wb-act="img-open"')
  })

  it('a hatter-kivetel arasztasa: az osszefuggo hatter atlatszo, a targyon beluli azonos szinu folt MARAD', () => {
    const h = setup()
    const ops = h.win.MarvinWorkbench._img
    // 5x5: feher keret, piros belseje, kozepen egy feher pont (a targy resze).
    const W = 5
    const data = new Uint8ClampedArray(W * W * 4)
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const edge = x === 0 || y === 0 || x === W - 1 || y === W - 1
      const center = x === 2 && y === 2
      const white = edge || center
      data[i] = 255; data[i + 1] = white ? 255 : 0; data[i + 2] = white ? 255 : 0; data[i + 3] = 255
    }
    const cleared = ops.floodKey(data, W, W, [{ x: 0, y: 0 }], 20)
    expect(cleared).toBe(16)
    expect(data[(2 * W + 2) * 4 + 3]).toBe(255) // a kozepso feher pont marad
    expect(data[(1 * W + 1) * 4 + 3]).toBe(255) // piros marad
    expect(data[3]).toBe(0)
  })

  it('a keret- es meret-matek', () => {
    const ops = setup().win.MarvinWorkbench._img
    expect(ops.aspectCrop(400, 200, 16 / 9)).toEqual({ x: 22, y: 0, w: 356, h: 200 })
    expect(ops.clampCrop({ x: -5, y: 190, w: 900, h: 50 }, 400, 200)).toEqual({ x: 0, y: 150, w: 400, h: 50 })
    expect(ops.rotSize(400, 200, 270)).toEqual({ w: 200, h: 400 })
    // A bongeszo canvas-hataran belul marad (16 MP).
    const big = ops.outSize({ x: 0, y: 0, w: 6000, h: 6000 }, 6000)
    expect(big.w * big.h).toBeLessThanOrEqual(16000000)
  })
})
