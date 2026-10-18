// #706: an upload whose content is already in the Life tree is linked, not copied; the tree rows carry the time;
// the tree button says "files" (plural). Opt-in (dedupe=1), never throws, "not known" -> a normal copy.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'wb-dedupe-store-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { initDatabase } = await import('../db.js')
const { createProject, updateProject } = await import('../projects.js')
const { startDupIndex, waitDupIndex } = await import('../life-dup-index.js')
const { callWorkbench } = await import('./helpers/workbench-route-call.js')
const { fileStamp } = await import('../workbench-assets.js')

let depot = ''
let pid = ''
const BYTES = 'EZ-A-TARTALOM-0123456789'

beforeEach(() => {
  initDatabase(':memory:')
  rmSync(join(store, 'life-dup-index.json'), { force: true })
  depot = mkdtempSync(join(tmpdir(), 'wb-dedupe-'))
  mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
  mkdirSync(join(depot, 'Archivum'), { recursive: true })
  process.env['MARVEEN_DEPOT'] = depot
  const p = createProject({ name: 'Kovács weboldal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  const up = updateProject(pid, { folder_path: 'Projektek/teszt' })
  if (!up.ok) throw new Error('mappa')
})
afterEach(() => {
  rmSync(depot, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

const projectFiles = (): string[] => {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name)); else out.push(join(d, e.name))
    }
  }
  walk(join(depot, 'Projektek', 'teszt'))
  return out
}
const up = (name: string, body: string, dedupe = true) =>
  callWorkbench(`/api/workbench/items/upload?project=${pid}&name=${encodeURIComponent(name)}${dedupe ? '&dedupe=1' : ''}`, 'POST', Buffer.from(body))

describe('#706 upload duplicate detection', () => {
  it('the same content already in the tree (indexed) -> a link, no copy in the project', async () => {
    writeFileSync(join(depot, 'Archivum', 'regi.txt'), BYTES)
    startDupIndex(); await waitDupIndex()
    const r = await up('masik-nev.txt', BYTES)
    expect(r.status).toBe(200)
    expect(r.body.linked).toBe(true)
    expect(r.body.existing).toBe('Archivum/regi.txt')
    expect(projectFiles()).toHaveLength(0)
    // the second time the link is already there -> still no copy, flagged as already linked
    const r2 = await up('harmadik.txt', BYTES)
    expect(r2.body.linked).toBe(true)
    expect(r2.body.already_linked).toBe(true)
    expect(projectFiles()).toHaveLength(0)
  })

  it('different content of the same size is a normal copy', async () => {
    writeFileSync(join(depot, 'Archivum', 'regi.txt'), BYTES)
    startDupIndex(); await waitDupIndex()
    const r = await up('uj.txt', BYTES.replace('0', '9'))
    expect(r.status).toBe(201)
    expect(r.body.linked).toBeUndefined()
    expect(projectFiles()).toHaveLength(1)
  })

  it('nothing in the index -> a normal copy (not known is not "checked everywhere")', async () => {
    writeFileSync(join(depot, 'Archivum', 'regi.txt'), BYTES)
    const r = await up('uj.txt', BYTES)
    expect(r.status).toBe(201)
    expect(r.body.linked).toBeUndefined()
    expect(projectFiles()).toHaveLength(1)
  })

  it('without dedupe=1 the old behaviour stays: always a copy', async () => {
    writeFileSync(join(depot, 'Archivum', 'regi.txt'), BYTES)
    startDupIndex(); await waitDupIndex()
    const r = await up('uj.txt', BYTES, false)
    expect(r.status).toBe(201)
    expect(r.body.linked).toBeUndefined()
    expect(projectFiles()).toHaveLength(1)
  })

  it('the file the index knows was deleted since -> a normal copy', async () => {
    writeFileSync(join(depot, 'Archivum', 'regi.txt'), BYTES)
    startDupIndex(); await waitDupIndex()
    rmSync(join(depot, 'Archivum', 'regi.txt'))
    const r = await up('uj.txt', BYTES)
    expect(r.status).toBe(201)
    expect(existsSync(join(depot, 'Projektek', 'teszt'))).toBe(true)
    expect(projectFiles()).toHaveLength(1)
  })
})

describe('#706 time line and label', () => {
  it('fileStamp prefers the creation time and falls back to the modification time', () => {
    expect(fileStamp({ birthtimeMs: 1700000000123.4, mtimeMs: 5 } as any)).toBe(1700000000123)
    expect(fileStamp({ birthtimeMs: 0, mtimeMs: 1600000000000 } as any)).toBe(1600000000000)
  })

  it('the HU and EN labels are plural and the new texts exist in both languages', () => {
    const hu = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf-8')
    const en = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf-8')
    expect(hu).toMatch(/"workbench\.treeup\.button": "Fájlok feltöltése"/)
    expect(en).toMatch(/"workbench\.treeup\.button": "Upload files"/)
    for (const k of ['workbench.file.when_title', 'workbench.upload.dup_linked', 'workbench.upload.dup_already']) {
      expect(hu).toContain(`"${k}"`)
      expect(en).toContain(`"${k}"`)
    }
  })

  it('the client renders the time after the size and sends dedupe=1', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
    expect(js).toContain('function fileWhenHtml')
    expect((js.match(/fileWhenHtml\(f\)/g) || []).length).toBeGreaterThanOrEqual(3)
    expect((js.match(/dedupe=1/g) || []).length).toBe(2)
  })
})
