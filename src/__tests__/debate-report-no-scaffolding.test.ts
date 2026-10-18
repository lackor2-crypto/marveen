// #656: a debate report is a finished output: it gets no Kontextus / Teendő file, and the ones an earlier version made
// are removed while they are still the untouched generated template.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { sweepItemContexts, readItemContext } from '../workbench-item-context.js'
import { isDebateReportTitle } from '../debate-report-title.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let pid = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-rep-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Nemet'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

const make = async (title: string): Promise<string> => (await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title })).body.item.id as string
const abs = (rel: string): string => join(dir, ...rel.split('/'))
const rows = (table: string, id: string): number => {
  try { return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`).get(id) as { n: number }).n } catch { return 0 /* table never made: nothing generated */ }
}
const retitle = (id: string, from: string, to: string): void => {
  getDb().prepare('UPDATE work_items SET title = ? WHERE id = ?').run(to, id)
  for (const t of ['work_item_context', 'work_item_todo_file']) {
    const r = getDb().prepare(`SELECT rel FROM ${t} WHERE item_id = ?`).get(id) as { rel: string } | undefined
    if (r) writeFileSync(abs(r.rel), readFileSync(abs(r.rel), 'utf8').split(from).join(to))
  }
}

describe('debate report scaffolding', () => {
  it('knows the report titles in both languages', () => {
    expect(isDebateReportTitle('Vitáztatás jelentés: Mennyi a lakbér?')).toBe(true)
    expect(isDebateReportTitle('Debate report: How much?')).toBe(true)
    expect(isDebateReportTitle('Wohngeld jelentés')).toBe(false)
    expect(isDebateReportTitle(null)).toBe(false)
  })
  it('a report item gets neither a context nor a to-do file', async () => {
    const id = await make('Vitáztatás jelentés: Mennyi a lakbér?')
    await sweepItemContexts()
    expect(rows('work_item_context', id)).toBe(0)
    expect(rows('work_item_todo_file', id)).toBe(0)
  })
  it('a normal item still gets both', async () => {
    const id = await make('Wohngeld')
    await sweepItemContexts()
    expect(rows('work_item_context', id)).toBe(1)
    expect(rows('work_item_todo_file', id)).toBe(1)
  })
  it('untouched generated files of an old report are removed, edited ones stay', async () => {
    const a = await make('Wohngeld A')
    const b = await make('Wohngeld B')
    await sweepItemContexts()
    const aCtx = getDb().prepare('SELECT rel FROM work_item_context WHERE item_id = ?').get(a) as { rel: string }
    const aTodo = getDb().prepare('SELECT rel FROM work_item_todo_file WHERE item_id = ?').get(a) as { rel: string }
    const bCtx = getDb().prepare('SELECT rel FROM work_item_context WHERE item_id = ?').get(b) as { rel: string }
    retitle(a, 'Wohngeld A', 'Vitáztatás jelentés: A')
    retitle(b, 'Wohngeld B', 'Vitáztatás jelentés: B')
    writeFileSync(abs(bCtx.rel), readFileSync(abs(bCtx.rel), 'utf8') + '\nfontos kezi jegyzet\n')
    await sweepItemContexts()
    expect(existsSync(abs(aCtx.rel))).toBe(false)
    expect(existsSync(abs(aTodo.rel))).toBe(false)
    expect(rows('work_item_context', a)).toBe(0)
    expect(existsSync(abs(bCtx.rel))).toBe(true)
    expect(readFileSync(abs(bCtx.rel), 'utf8')).toContain('fontos kezi jegyzet')
    expect(getWorkItem(a)).toBeTruthy()
    expect(readItemContext(getWorkItem(a)!)).toBeNull()
  })
})
