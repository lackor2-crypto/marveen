// #508 (TG 2898, 2901): a picture from the Uploads panel dragged onto a document
// work item becomes an `image` block -- validated, embedded into the PDF/DOCX,
// never translated, and finalize stops when its file is gone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock, updateBlock, documentCheck, imageBlockPathOk } from '../workbench-docmodel.js'
import { imageSize, buildFodt, type RenderOutline } from '../workbench-docrender.js'
import { readDocImage } from '../workbench-docfinal.js'
import { parseTranslation } from '../workbench-doclang-translate.js'

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(13)
  b.write('GIF89a', 0, 'ascii')
  b.writeUInt16LE(w, 6)
  b.writeUInt16LE(h, 8)
  return b
}

/** A minimal JPEG: SOI, optional EXIF APP1 with an orientation tag, SOF0. */
function jpeg(w: number, h: number, orientation?: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]
  if (orientation) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4)
    tiff.write('MM', 0, 'ascii')
    tiff.writeUInt16BE(42, 2)
    tiff.writeUInt32BE(8, 4)
    tiff.writeUInt16BE(1, 8)
    tiff.writeUInt16BE(0x0112, 10)
    tiff.writeUInt16BE(3, 12)
    tiff.writeUInt32BE(1, 14)
    tiff.writeUInt16BE(orientation, 18)
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
    const head = Buffer.from([0xff, 0xe1, 0, 0])
    head.writeUInt16BE(body.length + 2, 2)
    parts.push(head, body)
  }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  sof.writeUInt16BE(h, 5)
  sof.writeUInt16BE(w, 7)
  parts.push(sof, Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

describe('imageSize', () => {
  it('reads PNG, GIF and JPEG pixel sizes', () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480, mime: 'image/png' })
    expect(imageSize(gif(32, 16))).toEqual({ width: 32, height: 16, mime: 'image/gif' })
    expect(imageSize(jpeg(4000, 3000))).toEqual({ width: 4000, height: 3000, mime: 'image/jpeg' })
  })
  it('a phone photo stored sideways (EXIF 6) keeps its upright proportions', () => {
    expect(imageSize(jpeg(4000, 3000, 6))).toEqual({ width: 3000, height: 4000, mime: 'image/jpeg' })
    expect(imageSize(jpeg(4000, 3000, 1))).toEqual({ width: 4000, height: 3000, mime: 'image/jpeg' })
  })
  it('not a picture -> null', () => {
    expect(imageSize(Buffer.from('%PDF-1.7 hello'))).toBeNull()
  })
})

describe('buildFodt image block', () => {
  const opts = { title: 'Hianypotlas', author: null, draft: true, lang: 'hu' as const }
  it('embeds the picture, scaled to the text width', () => {
    const data = png(4000, 3000)
    const o: RenderOutline = { sections: [{ title: '1. Mellekelt foto', status: 'draft', blocks: [
      { kind: 'image', text: 'Projektek/X/Feltöltések/a.png', img: { data, width: 4000, height: 3000, mime: 'image/png' } },
    ] }] } as unknown as RenderOutline
    const x = buildFodt(o, opts)
    expect(x).toContain('<draw:frame')
    expect(x).toContain('svg:width="16.50cm"')
    expect(x).toContain(`<office:binary-data>${data.toString('base64')}</office:binary-data>`)
    expect(x).toContain('style:name="ImageP"')
  })
  it('a picture whose file is gone prints a warning line, not a broken frame', () => {
    const o = { sections: [{ title: '1.', status: 'draft', blocks: [{ kind: 'image', text: 'Projektek/X/Feltöltések/eltunt.jpg', img: null }] }] } as unknown as RenderOutline
    const x = buildFodt(o, opts)
    expect(x).not.toContain('draw:name="Picture')
    expect(x).toContain('⚠ eltunt.jpg')
  })
})

describe('parseTranslation', () => {
  it('copies an image block unchanged, whatever the model wrote', () => {
    const src = [
      { id: 'b1', kind: 'paragraph', text: 'Szia', claims: [] },
      { id: 'b2', kind: 'image', text: 'Projektek/X/Feltöltések/a.jpg', claims: [] },
    ]
    const r = parseTranslation(JSON.stringify({ title: 'Hello', blocks: [{ id: 'b1', text: 'Hi' }, { id: 'b2', text: 'a picture' }] }), src as never)
    expect(r.ok && r.blocks[1]).toEqual({ kind: 'image', text: 'Projektek/X/Feltöltések/a.jpg', claims: [] })
  })
})

describe('image blocks in the document model', () => {
  let depot = ''
  let itemId = ''
  const upl = () => join(depot, 'Projektek', 'Iroda', 'Feltöltések')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-docimage-'))
    mkdirSync(upl(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Hianypotlas', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('the path must stay inside the depot and be a JPG/PNG/GIF', () => {
    expect(imageBlockPathOk('Projektek/Iroda/Feltöltések/a.jpg')).toBe(true)
    expect(imageBlockPathOk('Projektek/Iroda/Feltöltések/A.JPEG')).toBe(true)
    expect(imageBlockPathOk('../a.jpg')).toBe(false)
    expect(imageBlockPathOk('Projektek/../../a.jpg')).toBe(false)
    expect(imageBlockPathOk('/etc/a.jpg')).toBe(false)
    expect(imageBlockPathOk('C:/a.jpg')).toBe(false)
    expect(imageBlockPathOk('Projektek/Iroda/a.pdf')).toBe(false)
  })

  it('addBlock/updateBlock refuse a bad picture path, accept a good one', () => {
    const s = addSection(itemId, '1. Foto')
    if (!s.ok) throw new Error('fejezet')
    const bad = addBlock(itemId, s.section.id, { kind: 'image', text: '../x.jpg', author: 'owner' })
    expect(bad.ok).toBe(false)
    const good = addBlock(itemId, s.section.id, { kind: 'image', text: 'Projektek/Iroda/Feltöltések/a.jpg', author: 'owner' })
    expect(good.ok && good.block.kind).toBe('image')
    if (!good.ok) return
    expect(updateBlock(itemId, good.block.id, { text: 'Projektek/Iroda/a.docx' } as never, 'owner').ok).toBe(false)
  })

  it('finalize check: the picture file is gone -> not ready; present -> that item is ok', () => {
    const s = addSection(itemId, '1. Foto')
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { kind: 'image', text: 'Projektek/Iroda/Feltöltések/a.png', author: 'owner' })
    let it1 = documentCheck(itemId).items.find((i) => i.key === 'image_missing_file')
    expect(it1?.ok).toBe(false)
    expect(it1?.detail).toEqual(['a.png'])
    writeFileSync(join(upl(), 'a.png'), png(10, 20))
    it1 = documentCheck(itemId).items.find((i) => i.key === 'image_missing_file')
    expect(it1?.ok).toBe(true)
    const img = readDocImage('Projektek/Iroda/Feltöltések/a.png')
    expect(img && [img.width, img.height, img.mime]).toEqual([10, 20, 'image/png'])
    expect(readDocImage('Projektek/Iroda/Feltöltések/nincs.png')).toBeNull()
  })
})

describe('Uploads panel tiles (frontend source)', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  it('shows medium thumbnail tiles, pictures draggable onto a document', () => {
    expect(js).toContain('wb-fr-tiles')
    expect(js).toContain('/api/life/thumb?rel=')
    expect(js).toContain('data-wb-drag-img="1"')
    expect(js).toContain("kind: 'image'")
  })
})
