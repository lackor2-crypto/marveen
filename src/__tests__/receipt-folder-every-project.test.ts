// #890 (Boss TG 5754): every WORK ITEM has its own EMPTY proof-of-submission folder next to its other standard folders;
// made once only; the saved proof lands in it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, rmdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_LANG: 'hu' }))
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { receiptFolderFor, ensureItemStandardFolders, itemStandardFolderNames, RECEIPT_FOLDER_NAMES } from '../project-files.js'

describe('receiptFolderFor (per work item)', () => {
  let depot = ''
  let saved: string | undefined
  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'rcpt-item-'))
    saved = process.env.MARVEEN_DEPOT
    process.env.MARVEEN_DEPOT = depot
    initDatabase(':memory:')
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.MARVEEN_DEPOT
    else process.env.MARVEEN_DEPOT = saved
    rmSync(depot, { recursive: true, force: true })
  })

  it('makes the empty folder in the item folder, is idempotent, and a deleted one stays deleted', () => {
    mkdirSync(join(depot, 'Projektek', 'P1', 'Munkadarabok', 'Level'), { recursive: true })
    const c = createProject({ name: 'P1', folder_path: 'Projektek/P1' })
    if (!c.ok) throw new Error('create failed')
    const item = 'Munkadarabok/Level'
    const dir = join(depot, 'Projektek', 'P1', item, RECEIPT_FOLDER_NAMES.hu)
    expect(receiptFolderFor(c.project, item)).toBe(`${item}/${RECEIPT_FOLDER_NAMES.hu}`)
    expect(readdirSync(dir)).toEqual([])
    expect(receiptFolderFor(c.project, item)).toBe(`${item}/${RECEIPT_FOLDER_NAMES.hu}`)
    rmdirSync(dir)
    expect(receiptFolderFor(c.project, item)).toBeNull()
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(depot, 'Projektek', 'P1', RECEIPT_FOLDER_NAMES.hu))).toBe(false)
  })

  it('is one of the standard folders every work item gets', () => {
    mkdirSync(join(depot, 'Projektek', 'P2', 'Munkadarabok', 'Irat'), { recursive: true })
    const c = createProject({ name: 'P2', folder_path: 'Projektek/P2' })
    if (!c.ok) throw new Error('create failed')
    ensureItemStandardFolders(c.project, 'Munkadarabok/Irat')
    expect(existsSync(join(depot, 'Projektek', 'P2', 'Munkadarabok', 'Irat', RECEIPT_FOLDER_NAMES.hu))).toBe(true)
    expect(itemStandardFolderNames()).toContain(RECEIPT_FOLDER_NAMES.hu)
  })

  it('wiring: the startup top-up and the receipt save use the item folder, no project-level folder is made by itself', () => {
    const root = join(__dirname, '..', '..')
    const assets = readFileSync(join(root, 'src', 'workbench-assets.ts'), 'utf8')
    expect(assets).toContain('receiptFolderFor(project, folder)')
    expect(assets).not.toContain('receiptFolderFor(p)')
    expect(readFileSync(join(root, 'src', 'web', 'routes', 'projects.ts'), 'utf8')).not.toContain('receiptFolderFor')
    expect(readFileSync(join(root, 'src', 'workbench-receipt.ts'), 'utf8')).toContain('workItemFolder(item.id)')
  })

  it('both language files still compile (an unescaped quote in the proof-folder hints broke en.js once)', async () => {
    const { Script } = await import('node:vm')
    const root = join(__dirname, '..', '..')
    for (const f of ['en.js', 'hu.js']) {
      expect(() => new Script(readFileSync(join(root, 'web', 'lang', f), 'utf8'), { filename: f })).not.toThrow()
    }
  })
})
