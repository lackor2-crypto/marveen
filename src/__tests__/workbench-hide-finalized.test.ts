// #552 -- finalized work: the owner's own Finalize / Reopen, and the switch that hides finalized work items
// (and the folders that hold only such items) from the work items box.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, getWorkItem, listWorkItemVersions } from '../workbench.js'
import { submitWorkItemForApproval, workItemApprovalState } from '../workbench-approval.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import type { RouteContext } from '../web/routes/types.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

async function call(method: string, path: string, body: unknown, kind = 'session'): Promise<{ status: number; body: any }> {
  const chunks: Buffer[] = []
  const out = { status: 200 }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const done = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (s: number) => { out.status = s; return res }
  res.setHeader = () => res
  const req: any = Readable.from([Buffer.from(body == null ? '' : JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const auth = kind === 'session' ? { kind: 'session', user: 'teszt' } : { kind }
  const ctx = { req, res, path: url.pathname, method, url, auth } as unknown as RouteContext
  if (await tryHandleWorkbench(ctx)) await done
  const s = Buffer.concat(chunks).toString('utf-8')
  return { status: out.status, body: s ? JSON.parse(s) : null }
}

describe('#552 finalize / reopen: the server', () => {
  let pid = ''
  const mk = (title: string) => {
    const r = createWorkItem({ project_id: pid, title, type: 'note' })
    if (!r.ok) throw new Error('create')
    return r.item
  }
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Kovács weboldal' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
  })

  it('the owner session finalizes with one click, reopen puts it back to in_progress', async () => {
    const w = mk('Jegyzet')
    const f = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'finalize' })
    expect(f.status).toBe(200)
    expect(f.body.item.status).toBe('done')
    const again = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'finalize' })
    expect(again.status).toBe(409)
    const r = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'reopen' })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('in_progress')
    const r2 = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'reopen' })
    expect(r2.status).toBe(409)
    expect(r2.body.error).toBe('approval_not_done')
    expect(r2.body.message.length).toBeGreaterThan(10)
  })

  it('reopen starts a NEW version (Boss TG 3116); the version that was current stays untouched', async () => {
    const w = mk('Jegyzet')
    await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'finalize' })
    const before = listWorkItemVersions(w.id)
    const r = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'reopen' })
    expect(r.status).toBe(200)
    const after = listWorkItemVersions(w.id)
    expect(after.length).toBe(before.length + 1)
    for (const v of before) expect(after.some((x) => x.id === v.id)).toBe(true)
    const cur = after.find((x) => x.id === getWorkItem(w.id)!.current_version_id)!
    expect(cur.prompt).toMatch(/^Újranyitva – \d{4}-\d{2}-\d{2}$/)
    expect(Array.isArray(r.body.versions)).toBe(true)
    expect(r.body.versions.length).toBe(after.length)
    // A refused reopen (not finalized any more) makes no version.
    const r2 = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'reopen' })
    expect(r2.status).toBe(409)
    expect(listWorkItemVersions(w.id).length).toBe(after.length)
  })

  it('an agent token cannot finalize or reopen: 403 with a human sentence, status unchanged', async () => {
    const w = mk('Jegyzet')
    for (const action of ['finalize', 'reopen']) {
      const d = await call('POST', `/api/workbench/items/${w.id}/approval`, { action }, 'agent')
      expect(d.status).toBe(403)
      expect(d.body.error).toBe('finalize_login_needed')
    }
    expect(getWorkItem(w.id)!.status).toBe('draft')
  })

  it('finalizing a work item that waits for approval also accepts its ticket', async () => {
    const w = mk('Ajánlat')
    submitWorkItemForApproval(w.id, { actor: 'agent' })
    const f = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'finalize' })
    expect(f.status).toBe(200)
    expect(f.body.item.status).toBe('done')
    expect(workItemApprovalState(w.id)!.status).toBe('approved')
  })
})

// #825: the tree hides a work item only when it is finalized AND sent; the server says which ones went out (item_marks).
const sentMarks = (list: { id: string; status: string }[]) => Object.fromEntries(list.map((i) => [i.id, { sent: i.status === 'done', finished: i.status === 'done', sent_on: null, due: null }]))

describe('#552 hide finalized work: the tree', () => {
  const box = 'Munkadarabok'
  const item = (id: string, title: string, folder: string, status = 'draft') => ({
    id, project_id: 'p1', type: 'note', title, status, source_path: null, editor_type: 'text',
    current_version_id: null, created_at: 1, updated_at: 1, created_by: null, pinned_at: null, folder, container_folder: null,
  })
  const folders = [`${box}/Kesz`, `${box}/Vegyes`, `${box}/Ures`, `${box}/Melyen`, `${box}/Melyen/Al`]
  const items = [
    item('d1', 'Kesz egy', `${box}/Kesz`, 'done'),
    item('d2', 'Kesz ket', `${box}/Kesz`, 'done'),
    item('m1', 'Vegyes kesz', `${box}/Vegyes`, 'done'),
    item('m2', 'Vegyes aktiv', `${box}/Vegyes`, 'in_progress'),
    item('deep', 'Melyen kesz', `${box}/Melyen/Al`, 'done'),
    item('top', 'Dobozban kesz', box, 'done'),
  ]

  function open(storage: Record<string, string> = {}) {
    const h = workbenchHarness({ storage })
    h.respond((url) => {
      if (url.includes('/api/workbench/items?')) return { status: 200, body: { ...itemsBody(items), item_marks: sentMarks(items), work_folders: { box, folders, truncated: false } } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: items.find((i) => url.includes('/items/' + i.id)) || items[0], versions: [], parts: [], approval: null } }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos: [] } }
      return { status: 200, body: {} }
    })
    h.win.MarvinWorkbench.open('p1', 'Robotok')
    return h
  }
  const tree = (html: string) => html.slice(html.indexOf('class="wb-items"'))

  it('off by default: everything shows, the switch is offered', async () => {
    const h = open()
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="m2"'))
    const t = tree(h.html())
    for (const id of ['d1', 'm1', 'deep', 'top']) expect(t).toContain(`data-wb-item="${id}"`)
    expect(h.html()).toContain('data-wb-act="hide-done"')
    expect(h.html()).not.toContain('workbench.hide_done.count')
  })

  it('on: finalized items and finalized-only folders (any depth) leave; mixed and empty folders stay; counter shown', async () => {
    const h = open({ 'wb.hide.done': '1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="m2"'))
    const t = tree(h.html())
    for (const id of ['d1', 'd2', 'm1', 'deep', 'top']) expect(t).not.toContain(`data-wb-item="${id}"`)
    expect(t).not.toContain(`data-wb-folder="${box}/Kesz"`)
    expect(t).not.toContain(`data-wb-folder="${box}/Melyen"`)
    expect(t).not.toContain(`data-wb-folder="${box}/Melyen/Al"`)
    expect(t).toContain(`data-wb-folder="${box}/Vegyes"`)
    expect(t).toContain('data-wb-item="m2"')
    expect(t).toContain(`data-wb-folder="${box}/Ures"`)
    expect(h.html()).toContain('workbench.hide_done.count:{"n":5}')
  })

  // #794 (Boss TG 10463): the finalized item is hidden, but its folder stays (a sub-folder holds a file): the folder's own
  // Context / To-do notes stay with it, and the item itself is still gone.
  it('on: a folder that stays shows its own loose files, the finalized item stays hidden', async () => {
    const f = `${box}/Level`
    // #825: the folder stays because an OPEN item lives below it (not because of loose files, which belong to the hidden item).
    const its = [item('lv', 'Level', f, 'done'), item('keep', 'Nyitott al', `${f}/Mellekletek`, 'in_progress'), item('other', 'Mas', `${box}/Vegyes`, 'in_progress')]
    const wf = {
      box, folders: [f, `${f}/Mellekletek`, `${box}/Vegyes`], truncated: false,
      files: { [f]: [{ name: 'Kontextus - Level.md', size: 1, rel: 'x/Kontextus - Level.md' }], [`${f}/Mellekletek`]: [{ name: 'K1.pdf', size: 1, rel: 'x/K1.pdf' }] },
    }
    const h = workbenchHarness({ storage: { 'wb.hide.done': '1' } })
    h.respond((url) => {
      if (url.includes('/api/workbench/items?')) return { status: 200, body: { ...itemsBody(its), item_marks: sentMarks(its), work_folders: wf } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: its[1], versions: [], parts: [], approval: null } }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos: [] } }
      return { status: 200, body: {} }
    })
    h.win.MarvinWorkbench.open('p1', 'Robotok')
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="other"'))
    const t = tree(h.html())
    expect(t).toContain(`data-wb-folder="${f}"`)
    expect(t).toContain('Kontextus - Level.md')
    expect(t).not.toContain('data-wb-item="lv"')
  })

  // #825 (owner TG 4189): finalized but NOT sent is the next thing to do -- it stays (empty circle); sent leaves with its folder.
  it('a finalized item that was not sent stays with an empty circle; the sent one and its folder leave', async () => {
    const f = `${box}/Level`
    const g = `${box}/Kuldve`
    const its = [item('un', 'Nincs elkuldve', f, 'done'), item('sn', 'Elkuldve', g, 'done'), item('op', 'Nyitott', `${box}/Nyitott`, 'in_progress')]
    const marks = { un: { sent: false, finished: false, sent_on: null, due: null }, sn: { sent: true, finished: true, sent_on: '2026-11-01', due: null }, op: { sent: false, finished: false, sent_on: null, due: { date: '2026-11-03', days: 2, level: 'soon' } } }
    const h = workbenchHarness({ storage: { 'wb.hide.done': '1' } })
    h.respond((url) => {
      if (url.includes('/api/workbench/items?')) return { status: 200, body: { ...itemsBody(its), item_marks: marks, work_folders: { box, folders: [f, g, `${g}/Elkeszitett`, `${g}/Ures`, `${box}/Nyitott`], truncated: false, files: { [`${g}/Elkeszitett`]: [{ name: 'level.pdf', size: 1, rel: 'x/level.pdf' }] } } } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: its[0], versions: [], parts: [], approval: null } }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos: [] } }
      return { status: 200, body: {} }
    })
    h.win.MarvinWorkbench.open('p1', 'Robotok')
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="op"'))
    const t = tree(h.html())
    expect(t).toContain('data-wb-item="un"')
    expect(t).toContain('wb-sent-no')
    expect(t).not.toContain('data-wb-item="sn"')
    expect(t).not.toContain(`data-wb-folder="${g}"`)
    // the sent item's own sub-folders (with a loose file, and an empty one) go with it
    expect(t).not.toContain(`data-wb-folder="${g}/Elkeszitett"`)
    expect(t).not.toContain('level.pdf')
    expect(t).not.toContain(`data-wb-folder="${g}/Ures"`)
    expect(t).toContain('wb-due-soon')
  })

  // Boss TG 8804: "hiding means hiding" -- the finalized item is gone from the list even while it is open.
  it('the open finalized item is hidden too; the click on the switch persists and brings everything back', async () => {
    const h = open({ 'wb.hide.done': '1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="m2"'))
    h.win.MarvinWorkbench.open('p1', 'Robotok')
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="m2"'))
    expect(tree(h.html())).not.toContain('data-wb-item="d1"')
    h.click({ 'data-wb-act': 'hide-done' })
    await vi.waitFor(() => expect(tree(h.html())).toContain('data-wb-item="deep"'))
    expect(tree(h.html())).toContain('data-wb-item="d1"')
    expect(h.storage['wb.hide.done']).toBe('0')
  })

  it('a finalized favourite is not shown among the favourites while the switch is on', async () => {
    const m1 = items[2] as { pinned_at: number | null }
    const m2 = items[3] as { pinned_at: number | null }
    m1.pinned_at = 5; m2.pinned_at = 6
    try {
      const on = open({ 'wb.hide.done': '1' })
      await vi.waitFor(() => expect(on.html()).toContain('data-wb-item="m2"'))
      const listOf = (html: string) => { const t = tree(html); return t.slice(0, t.indexOf('</ul>')) } // the favourites + the tree
      expect(listOf(on.html())).toContain('data-wb-item="m2"')
      expect(listOf(on.html())).not.toContain('data-wb-item="m1"') // finalized: not in the favourites, not in the tree
      const off = open()
      await vi.waitFor(() => expect(off.html()).toContain('data-wb-item="m2"'))
      expect(listOf(off.html())).toContain('data-wb-item="m1"')
    } finally { m1.pinned_at = null; m2.pinned_at = null }
  })

  // #563 (Boss TG 8941): among the favourites the live work stands on top, the finalized (greyed) ones under it; each
  // group keeps its order, and the folder tree keeps its own order.
  describe('#563 finalized favourites go under the live ones', () => {
    const pins = ['d1', 'm1', 'm2', 'top'] // array order: done, done, live, done -> the greyed one used to be first
    const listOf = (html: string) => { const t = tree(html); return t.slice(0, t.indexOf('</ul>')) }
    const idsOf = (html: string) => Array.from(listOf(html).matchAll(/data-wb-item="([^"]+)"/g)).map((m) => m[1])
    const setPins = (on: boolean) => pins.forEach((id, i) => { (items.find((x) => x.id === id) as { pinned_at: number | null }).pinned_at = on ? i + 1 : null })

    it('the live favourite stands on top, the finalized ones follow in their old order; the tree keeps its order', async () => {
      const plain = open()
      await vi.waitFor(() => expect(plain.html()).toContain('data-wb-item="m2"'))
      const treeOnly = idsOf(plain.html())
      setPins(true)
      try {
        const h = open()
        await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="m2"'))
        const ids = idsOf(h.html())
        expect(ids.slice(0, 4)).toEqual(['m2', 'd1', 'm1', 'top'])
        expect(ids.slice(4)).toEqual(treeOnly) // the folder tree is not reordered by the favourites
      } finally { setPins(false) }
    })

    it('with the hide switch on the finalized favourites are gone and the live one stays on top', async () => {
      setPins(true)
      try {
        const h = open({ 'wb.hide.done': '1' })
        await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="m2"'))
        const ids = idsOf(h.html())
        expect(ids.filter((x) => pins.includes(x) && x !== 'm2')).toEqual([])
        expect(ids[0]).toBe('m2')
        expect(listOf(h.html())).toContain('wb-fav-row')
        expect(h.html()).toContain('workbench.hide_done.count:{"n":5}')
      } finally { setPins(false) }
    })

    it('a phone width changes nothing: the rows keep DOM order, no CSS order rule is set on a list row itself', () => {
      const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf-8')
      // `.wb-item-row .wb-item { order }` only places the buttons INSIDE one row; a rule on the row would reshuffle the list.
      const rowRules = css.split('\n').filter((l) => /\border\s*:/.test(l) && /(wb-item-row|wb-fav-row|wb-folder-row)\s*(,|\{)/.test(l))
      expect(rowRules).toEqual([])
    })
  })
})
