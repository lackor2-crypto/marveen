// #509 fresh-install audit: a work item made a moment ago (no marveen-item.json yet, the snapshot pass runs once a
// minute) whose folder is moved into another project in the file manager must follow its folder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder } from '../workbench-assets.js'
import { SNAPSHOT_FILE } from '../workbench-snapshot.js'

vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}) }))
const { tryHandleLife } = await import('../web/routes/life.js')
const { reconcileItemLocations } = await import('../workbench-relocate.js')

function ctxFor(path: string, body: unknown) {
  const out: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as RouteContext['req']
  ;(req as unknown as { method: string; headers: Record<string, string> }).method = 'POST'
  ;(req as unknown as { headers: Record<string, string> }).headers = { 'content-type': 'application/json' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() { return res },
    end(t?: string) { try { out.body = JSON.parse(String(t ?? '{}')) } catch { out.body = {} } },
  } as unknown as RouteContext['res']
  const url = new URL('http://localhost' + path)
  return { ctx: { req, res, url, path: url.pathname, method: 'POST' } as unknown as RouteContext, out }
}

let dir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-lifemove-'))
  process.env['MARVEEN_DEPOT'] = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('file-manager move of a just-made work item folder', () => {
  it('the item follows its folder into the other project', async () => {
    const a = createProject({ name: 'Akta' }), b = createProject({ name: 'Valoper' })
    if (!a.ok || !b.ok) throw new Error('projekt')
    updateProject(a.project.id, { folder_path: 'P/Akta' })
    updateProject(b.project.id, { folder_path: 'P/Valoper' })
    mkdirSync(join(dir, 'P', 'Akta'), { recursive: true })
    mkdirSync(join(dir, 'P', 'Valoper'), { recursive: true })
    const r = createWorkItem({ project_id: a.project.id, title: 'Kerelem', type: 'document' })
    if (!r.ok) throw new Error(r.code)
    const f = ensureWorkItemFolder(getWorkItem(r.item.id)!)
    if (!f.ok) throw new Error(f.code)
    const from = `P/Akta/${f.folder}`
    expect(existsSync(join(dir, ...from.split('/'), SNAPSHOT_FILE))).toBe(false) // no snapshot yet: the window
    const { ctx, out } = ctxFor('/api/life/move', { from, to: 'P/Valoper' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBeLessThan(300)
    const seg = f.folder.split('/').pop()!
    expect(existsSync(join(dir, 'P', 'Valoper', seg, SNAPSHOT_FILE))).toBe(true)
    // The route starts its own fire-and-forget pass, and a pass that finds one running returns at once.
    // A fixed 50 ms wait raced with it (it failed on a loaded machine): ask until the item has followed.
    for (let i = 0; i < 100 && getWorkItem(r.item.id)!.project_id !== b.project.id; i++) {
      await new Promise((r2) => setTimeout(r2, 50))
      await reconcileItemLocations()
    }
    const after = getWorkItem(r.item.id)!
    expect(after.project_id).toBe(b.project.id)
    expect(after.folder).toBe(seg)
  })
})
