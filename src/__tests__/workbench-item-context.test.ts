// TG 3125 + 3127: a context md file next to every work item, named after it and following its rename;
// the item's JSON files carry the item's name too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { getWorkItem, createWorkItemVersion, createWorkItem } from '../workbench.js'
import { renameWorkItem, assignWorkItemFolder } from '../workbench-assets.js'
import { sweepItemContexts, contextFileName, nameWithItemStem, appendItemContext, readItemContext, rewriteItemContext, recordTaskFromChat } from '../workbench-item-context.js'
import { readdirSync } from 'node:fs'
import { todoFileName } from '../workbench-item-todos.js'
import { addSection } from '../workbench-docmodel.js'
import { createVariant } from '../workbench-doclang.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { TOOLS } from '../workbench-agent/tools.js'
import { SYSTEM_PROMPT } from '../workbench-agent/context.js'

let dir = ''
let pid = ''
let itemId = ''
beforeEach(async () => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-ctx-'))
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
const where = () => readItemContext(item())!

describe('context file next to the work item', () => {
  it('the sweep makes it, named after the item, in the item folder', async () => {
    const r = await sweepItemContexts()
    expect(r.created).toBeGreaterThanOrEqual(1)
    const ctx = where()
    expect(ctx.rel.endsWith('/' + contextFileName('Wohngeld hianypotlas'))).toBe(true)
    expect(existsSync(join(dir, ...ctx.rel.split('/')))).toBe(true)
    expect(ctx.text).toContain('marveen:files:begin')
  })
  it('a renamed item renames the file, and a second sweep changes nothing', async () => {
    await sweepItemContexts()
    const before = where().rel
    renameWorkItem(item(), 'Wohngeld ujra')
    const r = await sweepItemContexts()
    expect(r.renamed).toBe(1)
    const after = where().rel
    expect(after).not.toBe(before)
    expect(after.endsWith(contextFileName('Wohngeld ujra'))).toBe(true)
    expect(existsSync(join(dir, ...before.split('/')))).toBe(false)
    expect((await sweepItemContexts()).renamed).toBe(0)
  })
  it('adopts a context file the chat already wrote by hand instead of making a second one', async () => {
    const sub = 'Munkadarabok/Wohngeld 2026'
    const folder = `Projektek/Nemet/${sub}`
    mkdirSync(join(dir, ...folder.split('/')), { recursive: true })
    const rel = `${folder}/${contextFileName('Wohngeld hianypotlas')}`
    writeFileSync(join(dir, ...rel.split('/')), '# kezi kontextus\nfontos tartalom\n')
    assignWorkItemFolder(itemId, sub)
    await sweepItemContexts()
    expect(where().rel).toBe(rel)
    expect(readFileSync(join(dir, ...rel.split('/')), 'utf8')).toContain('fontos tartalom')
  })
  it('append goes under the section, rewrite keeps the machine block', async () => {
    await sweepItemContexts()
    const a = appendItemContext(item(), getProject(pid)!, 'decisions', 'Hatarido: 2026-11-01')
    expect(a.ok).toBe(true)
    expect(where().text).toMatch(/## (Döntések|Decisions)\s+Hatarido: 2026-11-01/)
    const w = rewriteItemContext(item(), getProject(pid)!, '# Uj\n\nrendezett')
    expect(w.ok).toBe(true)
    const t = where().text
    expect(t).toContain('rendezett')
    expect(t).toContain('marveen:files:begin')
  })
})

describe('appending to the Task section', () => {
  it('lands before the machine block, replaces the placeholder and survives a refresh', async () => {
    await sweepItemContexts()
    const a = appendItemContext(item(), getProject(pid)!, 'task', 'Wohngeld Hiánypótlás')
    expect(a.ok).toBe(true)
    const t = where().text
    expect(t.indexOf('Wohngeld Hiánypótlás')).toBeLessThan(t.indexOf('marveen:files:begin'))
    expect(t).not.toMatch(/még nincs felismerve|not recognised yet/)
    await sweepItemContexts()
    expect(where().text).toContain('Wohngeld Hiánypótlás')
  })
})

describe('the first chat message is the task (#794)', () => {
  it('fills the Task section once, while it is still the placeholder; later messages and a missing file change nothing', async () => {
    // no context file yet: nothing is made
    expect(recordTaskFromChat(item(), getProject(pid)!, 'Levelet akarok irni')).toBe(false)
    await sweepItemContexts()
    expect(recordTaskFromChat(item(), getProject(pid)!, '   ')).toBe(false)
    expect(recordTaskFromChat(item(), getProject(pid)!, 'Levelet akarok irni a berlini rendorsegnek, cim: rendorseg@example.org')).toBe(true)
    const t = where().text
    expect(t).toContain('rendorseg@example.org')
    expect(t).not.toMatch(/még nincs felismerve|not recognised yet/)
    expect(t.indexOf('rendorseg@example.org')).toBeLessThan(t.indexOf('marveen:files:begin'))
    // the section is no placeholder any more: the second message is not recorded
    expect(recordTaskFromChat(item(), getProject(pid)!, 'Masodik uzenet')).toBe(false)
    expect(where().text).not.toContain('Masodik uzenet')
  })
})

describe('JSON files carry the item name', () => {
  it('a legacy timestamp-named canvas file is renamed with the item name and the version follows', async () => {
    await sweepItemContexts()
    const folder = where().rel.split('/').slice(0, -1).join('/')
    const legacy = `${folder}/20261007-153333.canvas.json`
    writeFileSync(join(dir, ...legacy.split('/')), '{}')
    createWorkItemVersion(itemId, { source_path: legacy })
    await sweepItemContexts()
    const v = getWorkItem(itemId)!.source_path || ''
    expect(v.endsWith('wohngeld-hianypotlas 20261007-153333.canvas.json')).toBe(true)
    expect(existsSync(join(dir, ...v.split('/')))).toBe(true)
    expect(existsSync(join(dir, ...legacy.split('/')))).toBe(false)
  })
  it('a rename of the item renames the JSON file too', async () => {
    await sweepItemContexts()
    const folder = where().rel.split('/').slice(0, -1).join('/')
    const f = `${folder}/wohngeld-hianypotlas 20261007-153333.canvas.json`
    writeFileSync(join(dir, ...f.split('/')), '{}')
    createWorkItemVersion(itemId, { source_path: f })
    await sweepItemContexts()
    renameWorkItem(item(), 'Wohngeld ujra')
    await sweepItemContexts()
    const v = getWorkItem(itemId)!.source_path || ''
    expect(v.endsWith('wohngeld-ujra 20261007-153333.canvas.json')).toBe(true)
  })
  it('new names get the prefix; one that has it is left alone', () => {
    expect(nameWithItemStem('Wohngeld hianypotlas', '20261007.canvas.json')).toBe('wohngeld-hianypotlas 20261007.canvas.json')
    expect(nameWithItemStem('Wohngeld hianypotlas', 'wohngeld-hianypotlas.canvas.json')).toBe('wohngeld-hianypotlas.canvas.json')
  })
})

describe('the agent is bound to keep the file', () => {
  it('has the tools and the hard rule', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toContain('context.append')
    expect(names).toContain('context.rewrite')
    expect(SYSTEM_PROMPT).toContain('CONTEXT FILE')
    expect(SYSTEM_PROMPT).toContain('without being asked')
  })
})

// #590 follow-up (Boss TG 3241): the context file is the item's notes, never the item's FILE.
// Data the old code left behind: the API refuses the context file now, so the test writes the stale pointer by hand.
function legacyPointAt(rel: string): void {
  const v = createWorkItemVersion(itemId, {})
  if (!v.ok) throw new Error('version')
  const db = getDb()
  db.prepare('UPDATE work_item_versions SET source_path = ? WHERE id = ?').run(rel, v.version.id)
  db.prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(rel, itemId)
}
describe('the context file is never the work item file', () => {
  it('attaching it as the item file is refused with a human sentence', async () => {
    await sweepItemContexts()
    const rel = where().rel
    const r = await callWorkbench(`/api/workbench/items/${itemId}/versions`, 'POST', { source_path: rel })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('context_not_attachable')
    expect(item().source_path).toBeNull()
  })
  it('an item the chat already pointed at its context file is put back by the sweep (and its versions cleaned)', async () => {
    await sweepItemContexts()
    const rel = where().rel
    legacyPointAt(rel)
    legacyPointAt(rel)
    expect(item().source_path).toBe(rel)
    await sweepItemContexts()
    expect(item().source_path).toBeNull()
    const { listWorkItemVersions } = await import('../workbench.js')
    expect(listWorkItemVersions(itemId).some((v) => v.source_path === rel)).toBe(false)
    // idempotent
    await sweepItemContexts()
    expect(item().source_path).toBeNull()
  })
  it('an item with a real earlier file goes back to that file, not to nothing', async () => {
    await sweepItemContexts()
    const rel = where().rel
    const real = rel.replace(/[^/]+$/, 'kerelem.docx')
    createWorkItemVersion(itemId, { source_path: real })
    legacyPointAt(rel)
    await sweepItemContexts()
    expect(item().source_path).toBe(real)
  })
})

// Boss (Workbench chat 2026-10-15): ONE context file per work item, whatever the language it is translated into.
describe('a language version has no context file of its own', () => {
  const ctxFiles = (rel: string): string[] => readdirSync(join(dir, ...rel.split('/').slice(0, -1))).filter((n) => /^(Kontextus|Context) - .+\.md$/.test(n))
  const makeDe = () => {
    addSection(itemId, '1. Tenyallas')
    const r = createVariant(item(), 'de', 'teszt')
    if (!r.ok) throw new Error(r.detail)
    return r.item
  }
  it('the sweep makes one file for the original and none for the version, even in the same folder', async () => {
    const orig = (await (async () => { await sweepItemContexts(); return where() })())
    const de = makeDe()
    await sweepItemContexts()
    await sweepItemContexts()
    expect(ctxFiles(orig.rel)).toEqual([contextFileName('Wohngeld hianypotlas')])
    expect(readItemContext(getWorkItem(de.id)!)!.rel).toBe(orig.rel)
  })
  it('append and rewrite on the version go to the original file; nothing else appears', async () => {
    await sweepItemContexts()
    const orig = where()
    const de = getWorkItem(makeDe().id)!
    expect(appendItemContext(de, getProject(pid)!, 'info', 'Fordítási megjegyzés').ok).toBe(true)
    expect(rewriteItemContext(de, getProject(pid)!, '# Egyetlen\n\nközös jegyzet').ok).toBe(true)
    expect(where().text).toContain('közös jegyzet')
    expect(ctxFiles(orig.rel)).toHaveLength(1)
  })
  it('a version made before any original file existed still gets no file of its own', async () => {
    const de = getWorkItem(makeDe().id)!
    await sweepItemContexts()
    const rel = readItemContext(item())!.rel
    expect(ctxFiles(rel)).toEqual([contextFileName('Wohngeld hianypotlas')])
    expect(readItemContext(de)!.rel).toBe(rel)
  })
  it('an old pointer of the version is cleared and the file is not written back after it is removed', async () => {
    await sweepItemContexts()
    const rel = where().rel
    const de = getWorkItem(makeDe().id)!
    const stray = `${rel.split('/').slice(0, -1).join('/')}/${contextFileName(de.title)}`
    writeFileSync(join(dir, ...stray.split('/')), 'ures')
    const { getDb } = await import('../db.js')
    getDb().prepare('INSERT OR REPLACE INTO work_item_context (item_id, rel, stem) VALUES (?, ?, ?)').run(de.id, stray, 'x')
    rmSync(join(dir, ...stray.split('/')))
    await sweepItemContexts()
    await sweepItemContexts()
    expect(ctxFiles(rel)).toEqual([contextFileName('Wohngeld hianypotlas')])
    expect((getDb().prepare('SELECT rel FROM work_item_context WHERE item_id = ?').get(de.id) as { rel: string }).rel).toBe('')
  })
})

// #593: the guard lives in the data layer, so no way of setting a file (new item, new version, direct call) can attach the notes.
describe('the context file is refused by the data layer, not only by one route', () => {
  it('createWorkItemVersion refuses the context file and the to-do file, and changes nothing', async () => {
    await sweepItemContexts()
    const rel = where().rel
    const r = createWorkItemVersion(itemId, { source_path: rel })
    expect(r).toEqual({ ok: false, code: 'context_not_attachable' })
    const todo = rel.replace(/[^/]+$/, todoFileName('Wohngeld hianypotlas'))
    expect(createWorkItemVersion(itemId, { source_path: todo })).toEqual({ ok: false, code: 'context_not_attachable' })
    expect(item().source_path).toBeNull()
  })
  it('creating an item straight onto a context file is refused (HTTP and direct)', async () => {
    await sweepItemContexts()
    const rel = where().rel
    const direct = createWorkItem({ project_id: pid, type: 'document', title: 'Masik', source_path: rel })
    expect(direct).toEqual({ ok: false, code: 'context_not_attachable' })
    const viaHttp = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'Harmadik', source_path: rel })
    expect(viaHttp.status).toBe(400)
    expect(viaHttp.body.error).toBe('context_not_attachable')
  })
  it('a real file is still attachable', async () => {
    await sweepItemContexts()
    const real = where().rel.replace(/[^/]+$/, 'kerelem.docx')
    const r = createWorkItemVersion(itemId, { source_path: real })
    expect(r.ok).toBe(true)
    expect(item().source_path).toBe(real)
  })
})
