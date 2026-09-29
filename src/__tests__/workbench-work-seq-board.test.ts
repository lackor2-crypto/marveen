// TG 1843 + TG 1836 "B": a work item gets a referable number ("28M") in its own
// color, and it shows on the Kanban board / project Kanban tab too, framed.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, getWorkItem, ensureWorkbenchTables } from '../workbench.js'
import { listBoardWorkItems, buildWorkbenchOverview } from '../workbench-overview.js'

const WEB = join(__dirname, '..', '..', 'web')
const APP = readFileSync(join(WEB, 'app.js'), 'utf8')
const WBJS = readFileSync(join(WEB, 'workbench.js'), 'utf8')
const HTML = readFileSync(join(WEB, 'index.html'), 'utf8')
const HU = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

let pid = ''
let other = ''
function item(project: string, title: string, status = 'draft') {
  const r = createWorkItem({ project_id: project, title, type: 'note', status })
  if (!r.ok) throw new Error('nem jott letre')
  return r.item
}

describe('munkadarab-sorszam (28M)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const a = createProject({ name: 'Egyik' })
    const b = createProject({ name: 'Masik' })
    if (!a.ok || !b.ok) throw new Error('projekt')
    pid = a.project.id
    other = b.project.id
  })

  it('friss telepitesen 1-tol szamoz, projekteken at egyedi, sosem ismetel', () => {
    const x = item(pid, 'Elso')
    const y = item(other, 'Masodik')
    const z = item(pid, 'Harmadik')
    expect([x.seq, y.seq, z.seq]).toEqual([1, 2, 3])
  })

  it('"28M" / "#28m" alakkal is megtalalhato, a hexa azonosito tovabbra is mukodik', () => {
    const x = item(pid, 'Elso')
    const y = item(pid, 'Masodik')
    expect(getWorkItem(`${y.seq}M`)?.id).toBe(y.id)
    expect(getWorkItem(`#${y.seq}m`)?.id).toBe(y.id)
    expect(getWorkItem(x.id)?.id).toBe(x.id)
    expect(getWorkItem('999M')).toBeUndefined()
  })

  it('a regi, sorszam nelkuli sorok a letrehozas sorrendjeben kapnak szamot', () => {
    // A file DB, reopened: that is what an update does to an existing install.
    const dir = mkdtempSync(join(tmpdir(), 'wb-seq-'))
    const file = join(dir, 'db.sqlite')
    initDatabase(file)
    const pr = createProject({ name: 'Regi' })
    if (!pr.ok) throw new Error('projekt')
    const x = item(pr.project.id, 'Regi A')
    const y = item(pr.project.id, 'Regi B')
    getDb().exec('DROP INDEX IF EXISTS idx_work_items_seq')
    getDb().prepare('UPDATE work_items SET seq = NULL').run()
    initDatabase(file)
    ensureWorkbenchTables()
    expect(getWorkItem(x.id)?.seq).toBe(1)
    expect(getWorkItem(y.id)?.seq).toBe(2)
    rmSync(dir, { recursive: true, force: true })
  })

  it('az attekinto sav is visszaadja a sorszamot', () => {
    const x = item(pid, 'Vazlat')
    expect(buildWorkbenchOverview(pid).work.draft.items[0].seq).toBe(x.seq)
  })
})

describe('munkadarabok a Kanban-tablan (TG 1836 B)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const a = createProject({ name: 'Egyik' })
    const b = createProject({ name: 'Masik' })
    if (!a.ok || !b.ok) throw new Error('projekt')
    pid = a.project.id
    other = b.project.id
  })

  it('ures adatbazison ures lista, nem hiba', () => {
    expect(listBoardWorkItems()).toEqual([])
  })

  it('az allapot a kanban oszlopara kepzodik, projektnevvel, szurheto projektre', () => {
    item(pid, 'V', 'draft'); item(pid, 'F', 'in_progress'); item(pid, 'A', 'review'); item(other, 'K', 'done')
    const all = listBoardWorkItems()
    const col = (t: string) => all.find((w) => w.title === t)!.column
    expect([col('V'), col('F'), col('A'), col('K')]).toEqual(['planned', 'in_progress', 'waiting', 'done'])
    expect(all.find((w) => w.title === 'K')!.project_name).toBe('Masik')
    expect(listBoardWorkItems(pid).map((w) => w.title).sort()).toEqual(['A', 'F', 'V'])
  })

  it('a regen kesz munkadarab mar nem latszik', () => {
    const k = item(pid, 'Regen kesz', 'done')
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(1000, k.id)
    expect(listBoardWorkItems(pid)).toEqual([])
  })

  it('a felulet: keretes munkadarab mindket tablan, kapcsolo, kattintasra a Munkapad', () => {
    expect(APP).toContain("fetch('/api/workbench/board-items')")
    expect(APP).toContain("'/api/workbench/board-items?project=' + encodeURIComponent(pid)")
    expect(APP).toContain('works.map((w) => workItemBoardHtml(w, true))')
    expect(APP).toContain('works.map((w) => workItemBoardHtml(w, false))')
    expect(APP).toContain('window.MarvinWorkbench.restore(wbLoad)')
    expect(HTML).toContain('id="kanbanShowWork"')
    expect(WBJS).toContain("function workSeqText(it) { return it && it.seq ? it.seq + 'M' : '' }")
    for (const k of ['kanban.work.tag', 'kanban.filter.show_work', 'workbench.work_seq.title']) {
      expect(HU).toContain(`"${k}"`)
      expect(EN).toContain(`"${k}"`)
    }
  })
})
