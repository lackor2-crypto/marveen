/**
 * #909 (follow-up of the finalize gate): accepting a work item's approval ticket finalizes it too -- on the Workbench ("approve")
 * and on the Approvals page (PATCH /api/approvals/:id -> applyWorkItemApprovalOutcome). Both must ask the same trigger
 * question as the Finalize button: no trigger document and no "none" mark = the item does not become done.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { beforeEach, describe, expect, it } from 'vitest'
import { initDatabase, resolveApproval } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, getWorkItem, setWorkItemNoTrigger } from '../workbench.js'
import { applyWorkItemApprovalOutcome, decideWorkItemApproval, listWorkItemApprovals, submitWorkItemForApproval } from '../workbench-approval.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import type { RouteContext } from '../web/routes/types.js'

async function call(method: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const chunks: Buffer[] = []
  const out = { status: 200 }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const done = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (s: number) => { out.status = s; return res }
  res.setHeader = () => res
  const req: any = Readable.from([Buffer.from(body == null ? '' : JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: 'session', user: 'teszt' } } as unknown as RouteContext
  if (await tryHandleWorkbench(ctx)) await done
  const s = Buffer.concat(chunks).toString('utf-8')
  return { status: out.status, body: s ? JSON.parse(s) : null }
}

let pid = ''
function review(): string {
  const r = createWorkItem({ project_id: pid, title: 'Kérelem', type: 'note' })
  if (!r.ok) throw new Error('item')
  submitWorkItemForApproval(r.item.id, { actor: 'teszt' })
  return r.item.id
}

describe('accepting the approval ticket asks the trigger question', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Próba' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
  })

  it('the Approvals page decision does not finalize an item without a trigger document or the "none" mark', () => {
    const id = review()
    const t = listWorkItemApprovals(id)[0]
    resolveApproval(t.id, 'approved', 'teszt', null, null)
    applyWorkItemApprovalOutcome(t.id)
    expect(getWorkItem(id)!.status).toBe('review')
  })

  it('...and does finalize it once the owner marked "no trigger document"', () => {
    const id = review()
    setWorkItemNoTrigger(id, true)
    const t = listWorkItemApprovals(id)[0]
    resolveApproval(t.id, 'approved', 'teszt', null, null)
    applyWorkItemApprovalOutcome(t.id)
    expect(getWorkItem(id)!.status).toBe('done')
  })

  it('the Workbench "approve" answers 409 finalize_trigger_missing and leaves the ticket open', async () => {
    const id = review()
    const r = await call('POST', `/api/workbench/items/${id}/approval`, { action: 'approve' })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('finalize_trigger_missing')
    expect(getWorkItem(id)!.status).toBe('review')
    expect(listWorkItemApprovals(id)[0].status).toBe('pending')
  })

  it('the Workbench "approve" works after the "none" mark; a rejection never needed the trigger', async () => {
    const id = review()
    setWorkItemNoTrigger(id, true)
    const ok = await call('POST', `/api/workbench/items/${id}/approval`, { action: 'approve' })
    expect(ok.status).toBe(200)
    expect(getWorkItem(id)!.status).toBe('done')
    const other = review()
    const rej = decideWorkItemApproval(other, 'rejected', { by: 'teszt', reason: 'Nem jó.' })
    expect(rej.ok && rej.item.status).toBe('in_progress')
  })
})

describe('the page answers a refused approve like a refused finalize', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
  it('asks the "none" question for approve too and keeps the typed reason for the retry', () => {
    expect(js).toContain("(action === 'finalize' || action === 'approve') && askNoTriggerThen(")
    expect(js).toContain('approvalAction(action, true, body.reason)')
  })
})
