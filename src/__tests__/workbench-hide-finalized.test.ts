// #552 -- finalized work: the owner's own Finalize / Reopen, and the switch that hides finalized work items
// (and the folders that hold only such items) from the work items box.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
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

  it('an agent token cannot finalize or reopen: 403 with a human sentence, status unchanged', async () => {
    const w = mk('Jegyzet')
    for (const action of ['finalize', 'reopen']) {
      const d = await call('POST', `/api/workbench/items/${w.id}/approval`, { action }, 'agent')
      expect(d.status).toBe(403)
      expect(d.body.error).toBe('approval_owner_only')
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
      if (url.includes('/api/workbench/items?')) return { status: 200, body: { ...itemsBody(items), work_folders: { box, folders, truncated: false } } }
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

  it('the open finalized item stays visible; the click on the switch persists and re-renders', async () => {
    const h = open({ 'wb.hide.done': '1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="m2"'))
    h.click({ 'data-wb-item': 'd1' })
    await vi.waitFor(() => expect(tree(h.html())).toContain('data-wb-item="d1"'))
    h.click({ 'data-wb-act': 'hide-done' })
    await vi.waitFor(() => expect(tree(h.html())).toContain('data-wb-item="deep"'))
    expect(h.storage['wb.hide.done']).toBe('0')
  })
})
