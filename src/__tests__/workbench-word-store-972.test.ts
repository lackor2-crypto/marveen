// #972 (Boss TG 7394/7401): a Word item's support files (pictures, earlier states) live in the work item's OWN
// "Feltöltések" folder, not under System/Munkapad/<id>; the files already under the old place are moved there and the
// versions / picture blocks that name them follow. An id folder with no work item is left alone and reported.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { isWordStorePath, migrateWordStores, wordStoreDir } from '../workbench-worddoc.js'
import { addBlock, addSection } from '../workbench-docmodel.js'
import { lifeName } from '../life-tree.js'
import { rmTempDir } from './helpers/rm-temp-dir.js'

describe('#972 Word support files in the item uploads folder', () => {
  let depot = ''
  let pid = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wordstore-'))
    mkdirSync(join(depot, 'Projektek/Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
  })
  afterEach(() => { delete process.env['MARVEEN_DEPOT']; rmTempDir(depot) })

  const mk = (title: string) => { const w = createWorkItem({ project_id: pid, title, type: 'document' }); if (!w.ok) throw new Error('item'); return w.item }

  it('the store folder is the item uploads folder, not the System branch', () => {
    const it = mk('Level')
    const dir = wordStoreDir(it.id)!
    expect(dir.endsWith('/Feltöltések') || dir.endsWith('/Uploads')).toBe(true)
    expect(dir.startsWith(lifeName('system', 'hu'))).toBe(false)
    expect(isWordStorePath(`${dir}/x.png`)).toBe(true)
    expect(isWordStorePath('Projektek/Iroda/Level.docx')).toBe(false)
  })

  it('old System/Munkapad/<id> files move into the item uploads folder; versions and picture blocks follow; orphans stay', () => {
    const it = mk('Lebenslauf')
    const old = `${lifeName('system', 'hu')}/Munkapad`
    mkdirSync(join(depot, old, it.id), { recursive: true })
    mkdirSync(join(depot, old, 'deadbeef'), { recursive: true })
    writeFileSync(join(depot, old, it.id, 'cv - eredeti.docx'), 'ORIGINAL')
    writeFileSync(join(depot, old, it.id, 'cv - kép 1.png'), 'PNG')
    writeFileSync(join(depot, old, 'deadbeef', 'orphan.png'), 'ORPHAN')
    const oldVer = `${old}/${it.id}/cv - eredeti.docx`
    getDb().prepare('UPDATE work_items SET current_version_id = NULL WHERE id = ?').run(it.id)
    getDb().prepare("INSERT INTO work_item_versions (id, work_item_id, version_no, source_path, created_at) VALUES ('v1', ?, 9, ?, 1)").run(it.id, oldVer)
    const sec = addSection(it.id, 'T'); if (!sec.ok) throw new Error('section')
    const blk = addBlock(it.id, sec.section.id, { kind: 'image', text: `${old}/${it.id}/cv - kép 1.png#w=40&a=l`, author: 'owner' }); if (!blk.ok) throw new Error('block')
    const blockId = blk.block.id

    const r = migrateWordStores()
    const dir = wordStoreDir(it.id)!
    expect(r.failed).toEqual([])
    expect(r.orphans).toEqual([`${old}/deadbeef`])
    expect(readFileSync(join(depot, dir, 'cv - eredeti.docx'), 'utf8')).toBe('ORIGINAL')
    expect(existsSync(join(depot, old, it.id))).toBe(false)
    expect(existsSync(join(depot, old, 'deadbeef', 'orphan.png'))).toBe(true)
    const v = getDb().prepare("SELECT source_path FROM work_item_versions WHERE id = 'v1'").get() as { source_path: string }
    expect(v.source_path).toBe(`${dir}/cv - eredeti.docx`)
    const b = getDb().prepare('SELECT text FROM wb_doc_blocks WHERE id = ?').get(blockId) as { text: string }
    expect(b.text).toBe(`${dir}/cv - kép 1.png#w=40&a=l`)
    expect(getWorkItem(it.id)).toBeTruthy()
    // a second run changes nothing
    expect(migrateWordStores().moved).toEqual([])
  })

  it('with no orphan the empty Munkapad folder goes away', () => {
    const it = mk('Kerelem')
    const old = `${lifeName('system', 'hu')}/Munkapad`
    mkdirSync(join(depot, old, it.id), { recursive: true })
    writeFileSync(join(depot, old, it.id, 'a.png'), 'x')
    const r = migrateWordStores()
    expect(r).toEqual({ moved: [expect.any(String)], orphans: [], failed: [] })
    expect(existsSync(join(depot, old))).toBe(false)
  })
})
