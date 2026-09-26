// #406, 9. pont -- JOVAHAGYAS MUNKADARABRA: a szerver (jegy, allapot, ki
// donthet) ES a felulet (mit lat es mit kuld a felhasznalo).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { initDatabase, getApproval, resolveApproval, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import {
  submitWorkItemForApproval, withdrawWorkItemApproval, decideWorkItemApproval,
  applyWorkItemApprovalOutcome, workItemApprovalState, listWorkItemApprovals,
  WORK_ITEM_APPROVAL_CATEGORY, APPROVAL_REASON_MAX,
} from '../workbench-approval.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import type { RouteContext } from '../web/routes/types.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

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

let pid = ''

function item(title = 'Ajánlat') {
  const r = createWorkItem({ project_id: pid, title, type: 'note' })
  if (!r.ok) throw new Error('nem jott letre')
  return r.item
}

describe('jovahagyas munkadarabra: a szerver', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Kovács weboldal' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
  })

  it('bekuldes: review allapot + EGY jegy a kozos jovahagyas-listaban, a projekthez kotve', () => {
    const w = item()
    const r = submitWorkItemForApproval(w.id, { actor: 'teszt' })
    expect(r.ok).toBe(true)
    expect(getWorkItem(w.id)!.status).toBe('review')
    const all = listWorkItemApprovals(w.id)
    expect(all).toHaveLength(1)
    expect(all[0].category).toBe(WORK_ITEM_APPROVAL_CATEGORY)
    expect(all[0].status).toBe('pending')
    expect(JSON.parse(all[0].action_payload!)).toMatchObject({ project: pid, workItem: w.id })
    // A leiras a cimet mondja, NEM a belso azonositot (azt kartya-szamnak olvasnak).
    expect(all[0].action_description).toContain('Ajánlat')
    expect(all[0].action_description).not.toMatch(/\b[0-9a-f]{8}\b/)
  })

  it('ismetelt bekuldes nem csinal masodik jegyet', () => {
    const w = item()
    submitWorkItemForApproval(w.id)
    submitWorkItemForApproval(w.id)
    expect(listWorkItemApprovals(w.id)).toHaveLength(1)
  })

  it('elfogadas -> kesz; visszadobas -> vissza munkaba, az indoklassal', () => {
    const a = item('A')
    const b = item('B')
    submitWorkItemForApproval(a.id)
    submitWorkItemForApproval(b.id)
    const ra = decideWorkItemApproval(a.id, 'approved', { by: 'teszt' })
    expect(ra.ok && ra.item.status).toBe('done')
    const rb = decideWorkItemApproval(b.id, 'rejected', { by: 'teszt', reason: 'A logó legyen nagyobb.' })
    expect(rb.ok && rb.item.status).toBe('in_progress')
    expect(workItemApprovalState(b.id)).toMatchObject({ status: 'rejected', reason: 'A logó legyen nagyobb.' })
  })

  it('tul hosszu indoklas: elutasitva, a jegy nyitva marad', () => {
    const w = item()
    submitWorkItemForApproval(w.id)
    const r = decideWorkItemApproval(w.id, 'rejected', { by: 'teszt', reason: 'x'.repeat(APPROVAL_REASON_MAX + 1) })
    expect(r).toEqual({ ok: false, code: 'reason_too_long' })
    expect(workItemApprovalState(w.id)!.status).toBe('pending')
    expect(getWorkItem(w.id)!.status).toBe('review')
  })

  it('visszavonas: a jegy withdrawn (nem itelet), a munkadarab ujra munkaban', () => {
    const w = item()
    submitWorkItemForApproval(w.id)
    const r = withdrawWorkItemApproval(w.id)
    expect(r.ok && r.item.status).toBe('in_progress')
    expect(listWorkItemApprovals(w.id)[0].status).toBe('withdrawn')
    expect(withdrawWorkItemApproval(w.id)).toEqual({ ok: false, code: 'not_in_review' })
  })

  it('dontes nyitott jegy nelkul: no_pending; kesz darab nem kuldheto be ujra', () => {
    const w = item()
    expect(decideWorkItemApproval(w.id, 'approved', { by: 'teszt' })).toEqual({ ok: false, code: 'no_pending' })
    submitWorkItemForApproval(w.id)
    decideWorkItemApproval(w.id, 'approved', { by: 'teszt' })
    expect(submitWorkItemForApproval(w.id)).toEqual({ ok: false, code: 'already_done' })
  })

  it('a Jovahagyasok oldalon hozott dontes is atallitja a munkadarabot; a lejarat nem dont', () => {
    const a = item('A')
    const b = item('B')
    submitWorkItemForApproval(a.id)
    submitWorkItemForApproval(b.id)
    const ja = listWorkItemApprovals(a.id)[0].id
    const jb = listWorkItemApprovals(b.id)[0].id
    resolveApproval(ja, 'approved', 'dashboard')
    expect(applyWorkItemApprovalOutcome(ja)!.status).toBe('done')
    resolveApproval(jb, 'timeout', 'system')
    expect(applyWorkItemApprovalOutcome(jb)).toBeNull()
    expect(getWorkItem(b.id)!.status).toBe('review')
  })

  it('mas kategoriaju jegy vagy mar tovabblepett darab: nem nyul hozza', () => {
    const w = item()
    submitWorkItemForApproval(w.id)
    const j = listWorkItemApprovals(w.id)[0].id
    withdrawWorkItemApproval(w.id)
    getDb().prepare("UPDATE approvals SET status = 'approved' WHERE id = ?").run(j)
    expect(applyWorkItemApprovalOutcome(j)).toBeNull()
    expect(getWorkItem(w.id)!.status).toBe('in_progress')
    expect(applyWorkItemApprovalOutcome('nincs-ilyen')).toBeNull()
  })

  it('route: bekuldes barkinek, DONTES csak bejelentkezett munkamenetnek; emberi mondat a hibanal', async () => {
    const w = item()
    const s = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'submit' }, 'agent')
    expect(s.status).toBe(200)
    expect(s.body.item.status).toBe('review')
    expect(s.body.approval.status).toBe('pending')

    const denied = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'approve' }, 'agent')
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('approval_owner_only')
    expect(typeof denied.body.message).toBe('string')
    expect(denied.body.message.length).toBeGreaterThan(10)
    expect(getWorkItem(w.id)!.status).toBe('review')

    const ok = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'approve' })
    expect(ok.status).toBe(200)
    expect(ok.body.item.status).toBe('done')
    expect(getApproval(ok.body.approval.id)!.resolved_by).toBe('teszt')

    const bad = await call('POST', `/api/workbench/items/${w.id}/approval`, { action: 'valami' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('approval_bad_action')

    const detail = await call('GET', `/api/workbench/items/${w.id}`, null)
    expect(detail.body.approval.status).toBe('approved')
  })
})

describe('jovahagyas munkadarabra: a felulet', () => {
  const ITEM = (status: string) => ({ id: 'w1', title: 'Ajánlat', type: 'note', status })

  function open(h: ReturnType<typeof workbenchHarness>, status: string, approval: unknown, post?: (body: any) => { status: number; body: unknown }) {
    h.respond((url, init) => {
      if (url.includes('/approval') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'))
        return post ? post(body) : { status: 200, body: { item: ITEM('review'), approval: { id: 'j1', status: 'pending', reason: null, requested_at: 1, resolved_at: null, resolved_by: null } } }
      }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: ITEM(status), versions: [], parts: [], approval } }
      return { status: 200, body: itemsBody([ITEM(status)]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-item': 'w1' })
  }

  const posts = (h: ReturnType<typeof workbenchHarness>) =>
    h.fetchCalls.filter((c) => c.url.includes('/approval') && c.init?.method === 'POST').map((c) => JSON.parse(String(c.init!.body)))

  it('munkaban levo darab: magyarazat + bekuldes gomb; a gomb bekuldi', async () => {
    const h = workbenchHarness()
    open(h, 'draft', null)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="approval-submit"'))
    expect(h.html()).toContain('workbench.approval.intro')
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'Ajánlat'])).toBe('')
    h.click({ 'data-wb-act': 'approval-submit' })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.approval.toast.submit⟧'))
    expect(posts(h)).toEqual([{ action: 'submit' }])
    expect(h.html()).toContain('data-wb-act="approval-approve"')
  })

  it('jovahagyasra var: elfogad / visszadob / visszavon; az indoklas megy a keressel', async () => {
    const h = workbenchHarness()
    open(h, 'review', { id: 'j1', status: 'pending', reason: null, requested_at: 1, resolved_at: null, resolved_by: null },
      () => ({ status: 200, body: { item: ITEM('in_progress'), approval: { id: 'j1', status: 'rejected', reason: 'Nagyobb logó', requested_at: 1, resolved_at: 2, resolved_by: 'teszt' } } }))
    await vi.waitFor(() => expect(h.html()).toContain('workbench.approval.pending'))
    expect(h.html()).toContain('data-wb-act="approval-reject"')
    expect(h.html()).toContain('data-wb-act="approval-withdraw"')
    h.inputs.wbApprovalReason = { value: '  Nagyobb logó ', focus() {} }
    h.click({ 'data-wb-act': 'approval-reject' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.approval.rejected'))
    expect(posts(h)).toEqual([{ action: 'reject', reason: 'Nagyobb logó' }])
    expect(h.html()).toContain('Nagyobb logó')
  })

  it('visszadobas indoklas nelkul: rakerdez, es ha nem, NEM kuld semmit', async () => {
    const h = workbenchHarness({ confirm: false })
    open(h, 'review', { id: 'j1', status: 'pending', reason: null, requested_at: 1, resolved_at: null, resolved_by: null })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="approval-reject"'))
    h.click({ 'data-wb-act': 'approval-reject' })
    await new Promise((r) => setTimeout(r, 10))
    expect(posts(h)).toEqual([])
  })

  it('szerverhiba: a szerver mondata latszik, nem a kod', async () => {
    const h = workbenchHarness()
    open(h, 'review', { id: 'j1', status: 'pending', reason: null, requested_at: 1, resolved_at: null, resolved_by: null },
      () => ({ status: 403, body: { error: 'approval_owner_only', message: 'Ezt csak a tulajdonos döntheti el.' } }))
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="approval-approve"'))
    h.click({ 'data-wb-act': 'approval-approve' })
    await vi.waitFor(() => expect(h.toasts).toContain('Ezt csak a tulajdonos döntheti el.'))
    expect(h.toasts).not.toContain('approval_owner_only')
  })

  it('kesz darab: csak a kesz-mondat, gomb nelkul', async () => {
    const h = workbenchHarness()
    open(h, 'done', { id: 'j1', status: 'approved', reason: null, requested_at: 1, resolved_at: 2, resolved_by: 'teszt' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.approval.done'))
    expect(h.html()).not.toContain('data-wb-act="approval-')
  })
})
