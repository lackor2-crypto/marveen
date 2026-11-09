// #890 (Boss TG 5744/5748): every project has the EMPTY proof-of-submission folder from the start; made once only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, rmdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_LANG: 'hu' }))
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { receiptFolderFor, RECEIPT_FOLDER_NAMES } from '../project-files.js'

describe('receiptFolderFor', () => {
  let depot = ''
  let saved: string | undefined
  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'rcpt-all-'))
    saved = process.env.MARVEEN_DEPOT
    process.env.MARVEEN_DEPOT = depot
    initDatabase(':memory:')
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.MARVEEN_DEPOT
    else process.env.MARVEEN_DEPOT = saved
    rmSync(depot, { recursive: true, force: true })
  })

  it('makes the empty folder, is idempotent, and a deleted one stays deleted', () => {
    mkdirSync(join(depot, 'Projektek', 'P1'), { recursive: true })
    const c = createProject({ name: 'P1', folder_path: 'Projektek/P1' })
    if (!c.ok) throw new Error('create failed')
    const dir = join(depot, 'Projektek', 'P1', RECEIPT_FOLDER_NAMES.hu)
    expect(receiptFolderFor(c.project)).toBe(RECEIPT_FOLDER_NAMES.hu)
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
    expect(receiptFolderFor(c.project)).toBe(RECEIPT_FOLDER_NAMES.hu)
    rmdirSync(dir)
    expect(receiptFolderFor(c.project)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  it('an existing English-named folder is reused, not duplicated', () => {
    mkdirSync(join(depot, 'Projektek', 'P2', RECEIPT_FOLDER_NAMES.en), { recursive: true })
    const c = createProject({ name: 'P2', folder_path: 'Projektek/P2' })
    if (!c.ok) throw new Error('create failed')
    expect(receiptFolderFor(c.project)).toBe(RECEIPT_FOLDER_NAMES.en)
    expect(existsSync(join(depot, 'Projektek', 'P2', RECEIPT_FOLDER_NAMES.hu))).toBe(false)
  })

  it('is wired into the startup pass, the create route and the first project folder', () => {
    const root = join(__dirname, '..', '..')
    expect(readFileSync(join(root, 'src', 'workbench-assets.ts'), 'utf8')).toContain('receiptFolderFor(p)')
    expect(readFileSync(join(root, 'src', 'web', 'routes', 'projects.ts'), 'utf8')).toContain('receiptFolderFor(made.project)')
    expect(readFileSync(join(root, 'src', 'project-files.ts'), 'utf8')).toMatch(/receiptFolderFor\(p\) \} catch/)
  })
})
