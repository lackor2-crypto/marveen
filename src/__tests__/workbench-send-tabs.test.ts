// Boss, 2026-11-08 (#879): the "Send" panel is one panel with four Excel-like tabs, and the proof an online portal
// returns goes into ONE project-level folder (never the work item's own folder).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_LANG: 'hu' }))
const appended: string[] = []
vi.mock('../workbench-item-context.js', () => ({
  appendItemContext: (_o: unknown, _p: unknown, _k: string, line: string) => { appended.push(line) },
  contextOwner: (it: unknown) => it,
}))
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { saveReceiptFile, defaultReceiptFolder } from '../workbench-receipt.js'

const root = join(__dirname, '..', '..')
const js = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')
const hu = readFileSync(join(root, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(root, 'web', 'lang', 'en.js'), 'utf8')
const route = readFileSync(join(root, 'src', 'web', 'routes', 'workbench.ts'), 'utf8')

describe('the saved proof lands in a project-level folder', () => {
  let depot = ''
  let saved: string | undefined
  beforeEach(() => {
    appended.length = 0
    depot = mkdtempSync(join(tmpdir(), 'wb-rcpt-'))
    saved = process.env.MARVEEN_DEPOT
    process.env.MARVEEN_DEPOT = depot
    initDatabase(':memory:')
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.MARVEEN_DEPOT
    else process.env.MARVEEN_DEPOT = saved
    rmSync(depot, { recursive: true, force: true })
  })

  it('default folder, file written, Kontextus line appended, never overwritten', () => {
    mkdirSync(join(depot, 'Projektek', 'Rcpt'), { recursive: true })
    const c = createProject({ name: 'Rcpt', folder_path: 'Projektek/Rcpt' })
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const item = { id: 'it1', project_id: c.project.id } as never
    const a = saveReceiptFile(item, '', 'igazolas.pdf', Buffer.from('PDF-1'))
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.folder).toBe(defaultReceiptFolder())
    expect(a.rel.includes(defaultReceiptFolder())).toBe(true)
    expect(appended.length).toBe(1)
    expect(appended[0]).toContain(a.rel)
    const b = saveReceiptFile(item, '', 'igazolas.pdf', Buffer.from('PDF-2'))
    expect(b.ok && b.renamed).toBe(true)
    const custom = saveReceiptFile(item, 'Saját bizonylatok', 'x.pdf', Buffer.from('X'))
    expect(custom.ok && custom.folder).toBe('Saját bizonylatok')
    expect(existsSync(join(depot, 'Projektek', 'Rcpt', 'Saját bizonylatok', 'x.pdf'))).toBe(true)
  })

  it('an unknown project is refused', () => {
    expect(saveReceiptFile({ id: 'it2', project_id: 'nope' } as never, '', 'a.pdf', Buffer.from('x')).ok).toBe(false)
  })
})

describe('the panel (source contract)', () => {
  it('the banner has ONE Send button; the four ways are tabs of one panel', () => {
    expect(js).toContain('data-wb-act="send-tab"')
    expect(js).toContain('class="wb-send-tabs" role="tablist"')
    for (const k of ['email', 'post', 'portal', 'in_person']) expect(js).toContain("'" + k + "'")
    expect(js).toContain("else if (a === 'send-tab')")
    expect(js).toContain("else if (a === 'receipt-save')")
  })
  it('the receipt route has the same guards as the upload package route', () => {
    expect(route).toContain("segs[1] === 'receipt-file'")
    expect(route).toContain('saveReceiptFile')
  })
  it('every new key exists in Hungarian and English', () => {
    const keys = Array.from(new Set(Array.from(js.matchAll(/t\('(workbench\.send\.[a-z_0-9.]+)'/g)).map((m) => m[1]))).filter((k) => !/[._]$/.test(k))
    expect(keys.length).toBeGreaterThan(15)
    const miss = keys.filter((k) => !hu.includes('"' + k + '"') || !en.includes('"' + k + '"'))
    expect(miss).toEqual([])
    for (const k of keys) { expect(hu).toContain("\"" + k + "\"") ; expect(en).toContain("\"" + k + "\"") }
    for (const k of ['email', 'post', 'portal', 'in_person']) { expect(hu).toContain('"workbench.send.tab.' + k + '"'); expect(en).toContain('"workbench.send.tab.' + k + '"') }
  })
})
