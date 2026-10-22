// TG 3462: a to-do file next to every work item ("Teendő - <name>.md"), built from the item's to-do list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { renameWorkItem } from '../workbench-assets.js'
import { addTodo, listItemTodos, updateTodo } from '../workbench-todos.js'
import { sweepItemContexts, readItemContext } from '../workbench-item-context.js'
import { todoFileName, isTodoFileName, todoFileText, ensureItemTodoFile } from '../workbench-item-todos.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { SYSTEM_PROMPT } from '../workbench-agent/context.js'

let dir = ''
let pid = ''
let itemId = ''
beforeEach(async () => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-todo-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Nemet'), { recursive: true })
  const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'Wohngeld hianypotlas' })
  itemId = c.body.item.id as string
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

const item = () => getWorkItem(itemId)!
const fileText = (rel: string) => readFileSync(join(dir, ...rel.split('/')), 'utf8')

describe('to-do file', () => {
  it('name helpers and text: open first, done after, due date shown', () => {
    expect(isTodoFileName(todoFileName('Wohngeld'))).toBe(true)
    expect(isTodoFileName('Kontextus - Wohngeld.md')).toBe(false)
    const txt = todoFileText('X', [
      { text: 'done one', due_date: null, done_at: 5 },
      { text: 'open one', due_date: '2026-10-20', done_at: null },
    ])
    expect(txt.indexOf('- [ ] open one')).toBeLessThan(txt.indexOf('- [x] done one'))
    expect(txt).toContain('2026-10-20')
    expect(todoFileText('X', [])).toMatch(/még nincs teendő|no to-do yet/)
  })

  it('the sweep makes it beside the context file, named after the item, and a rename moves it', async () => {
    await sweepItemContexts()
    const ctx = readItemContext(item())!
    const rel = `${dirname(ctx.rel)}/${todoFileName('Wohngeld hianypotlas')}`
    expect(existsSync(join(dir, ...rel.split('/')))).toBe(true)
    renameWorkItem(item(), 'Wohngeld ujra')
    await sweepItemContexts()
    const folder = dirname(readItemContext(item())!.rel)
    expect(readdirSync(join(dir, ...folder.split('/'))).filter(isTodoFileName)).toEqual([todoFileName('Wohngeld ujra')])
  })

  it('it follows the list: a new to-do and a tick change the file, a second pass changes nothing', async () => {
    await sweepItemContexts()
    const folder = dirname(readItemContext(item())!.rel)
    const rel = `${folder}/${todoFileName('Wohngeld hianypotlas')}`
    const a = addTodo({ work_item_id: itemId, text: 'Attach the payslips', due_date: null, repeat: null, by: 'test', source: 'agent' })
    if (!a.ok) throw new Error('addTodo')
    ensureItemTodoFile(item(), getProject(pid)!)
    expect(fileText(rel)).toContain('- [ ] Attach the payslips')
    updateTodo(a.todo.id, { done: true } as any)
    ensureItemTodoFile(item(), getProject(pid)!)
    expect(fileText(rel)).toContain('- [x] Attach the payslips')
    expect(listItemTodos(itemId).length).toBe(1)
    expect(readdirSync(join(dir, ...folder.split('/'))).filter(isTodoFileName).length).toBe(1)
  })

  it('the to-do file can not be attached as the item file, and the prompt tells the agent about it', async () => {
    const bad = await callWorkbench(`/api/workbench/items/${itemId}/versions`, 'POST', { source_path: `Projektek/Nemet/${todoFileName('Wohngeld hianypotlas')}` })
    expect(bad.status).toBe(400)
    expect(SYSTEM_PROMPT).toContain('Teendő - <work item name>.md')
  })
})

describe('to-do panel in the Workbench page (TG 3462)', () => {
  const js = readFileSync('web/workbench.js', 'utf8')
  const css = readFileSync('web/workbench.css', 'utf8')
  it('has the toggle beside the translation one and the right-hand panel fed by the existing list', () => {
    expect(js).toContain('data-wb-act="tp-toggle"')
    expect(js).toContain('id="wbTpPanel"')
    expect(js).toContain("twToggleHtml(o) + ' ' + tpToggleHtml()")
    expect(js).toContain('data-wb-act="td-toggle" data-wb-todo=')
    expect(css).toContain('.wb-tp-row.is-done .wb-tp-mark')
  })
})

describe('to-do panel beside a video (#754)', () => {
  const js = readFileSync('web/workbench.js', 'utf8')
  const css = readFileSync('web/workbench.css', 'utf8')
  it('a video offers the toggle and draws the list on the right of the player and timeline, in both views', () => {
    expect(js).toMatch(/return isDocSurface\(it\) \|\| frIsVideo\(it\)/)
    expect(js).toContain("(isVid ? tpBesideHtml(main + strip) : main + strip)")
    expect(js).toContain("? tpBesideHtml(videoTimelineHtml()) +")
    expect(js).toMatch(/wb-fr-tl-len[^\n]*\n\s*\+ tpToggleHtml\(\)/)
    expect(css).toMatch(/\.wb-tp-cols \{ display: flex; flex-wrap: wrap;/)
  })
})

describe('zoom covers the side panels (TG 3467)', () => {
  it('the translation and to-do panels scale with the slider', () => {
    expect(readFileSync('web/workbench.css', 'utf8')).toMatch(/\.wb-fr-scroll \.wb-tw-right \{ zoom: var\(--wb-zoom/)
  })
})
