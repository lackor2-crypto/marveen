// #406, 18. pont -- csak olvashato betekinto link: lejar, visszavonhato, a
// letrehozas a permission_change kapun megy at, a nyilvanos lap szkript
// nelkul, sandboxban fut, es mas projektet / API-t nem er el.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { initDatabase, getApproval, resolveApproval, getDb } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import {
  requestShare, revokeShare, settleShareApprovals, resolveShareToken, shareToken, listProjectShares,
  getShare, _setShareDeps, SHARE_CATEGORY,
} from '../workbench-share.js'
import { tryHandleWorkbenchShareView } from '../web/routes/workbench-share-view.js'
import { requiresAuth } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

let pid = ''
let itemId = ''
let level = 3

function setup() {
  initDatabase(':memory:')
  const p = createProject({ name: 'Kovács weboldal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  const it = createWorkItem({ project_id: pid, title: 'Ajánlat', type: 'note' })
  if (!it.ok) throw new Error('munkadarab')
  itemId = it.item.id
  level = 3
  _setShareDeps({ level: () => level })
}

afterEach(() => _setShareDeps())

function share(over: Record<string, unknown> = {}) {
  return requestShare({ kind: 'item', project_id: pid, work_item_id: itemId, days: 7, lang: 'hu', actor: 'teszt', ...over })
}

async function view(path: string, method = 'GET') {
  const chunks: Buffer[] = []
  const out = { status: 200, headers: {} as Record<string, string> }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const done = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (s: number, h?: Record<string, string>) => { out.status = s; if (h) out.headers = { ...out.headers, ...h }; return res }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const handled = await tryHandleWorkbenchShareView({ req, res, path: url.pathname, method, url } as unknown as RouteContext)
  if (handled) await done
  return { handled, status: out.status, headers: out.headers, text: Buffer.concat(chunks).toString('utf-8') }
}

describe('betekinto link: letrehozas es kapu', () => {
  beforeEach(setup)

  it('3-as szint: azonnal el, a token feloldodik; atirt token nem', () => {
    const r = share()
    expect(r).toMatchObject({ ok: true, state: 'active' })
    if (!r.ok) return
    const tok = shareToken(r.share.id)
    expect(resolveShareToken(tok)?.id).toBe(r.share.id)
    const exp = r.share.expires_at as number
    expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(7 * 86_400 - 60)
    const bad = tok.slice(0, -2) + (tok.endsWith('AA') ? 'BB' : 'AA')
    expect(resolveShareToken(bad)).toBeNull()
    expect(resolveShareToken(r.share.id)).toBeNull()
    expect(resolveShareToken('')).toBeNull()
  })

  it('2-es szint: permission_change jegy, fuggo; ugyanarra masodik kattintas nem nyit ujat', () => {
    level = 2
    const r = share()
    expect(r).toMatchObject({ ok: true, state: 'pending' })
    if (!r.ok) return
    const a = getApproval(r.share.approval_id as string)
    expect(a?.category).toBe(SHARE_CATEGORY)
    expect(SHARE_CATEGORY).toBe('permission_change')
    expect(a?.action_description).toContain('Ajánlat')
    expect(resolveShareToken(shareToken(r.share.id))).toBeNull()
    const again = share()
    expect(again.ok && again.share.id).toBe(r.share.id)
  })

  it('jovahagyas utan el (lejarat az elesitestol), elutasitas utan nem', () => {
    level = 2
    const r1 = share()
    const r2 = share({ days: 1 })
    if (!r1.ok || !r2.ok) throw new Error('share')
    resolveApproval(r1.share.approval_id as string, 'approved', 'owner')
    resolveApproval(r2.share.approval_id as string, 'rejected', 'owner')
    expect(settleShareApprovals()).toBe(2)
    expect(getShare(r1.share.id)).toMatchObject({ status: 'active' })
    expect(resolveShareToken(shareToken(r1.share.id))?.id).toBe(r1.share.id)
    expect(getShare(r2.share.id)).toMatchObject({ status: 'rejected', expires_at: null })
    expect(resolveShareToken(shareToken(r2.share.id))).toBeNull()
    expect(settleShareApprovals()).toBe(0)
  })

  it('1-es szint: tiltva, nincs jegy, nincs link', () => {
    level = 1
    expect(share()).toEqual({ ok: false, code: 'blocked' })
    expect(listProjectShares(pid)).toHaveLength(0)
  })

  it('visszavonas es lejarat utan a token halott', () => {
    const r = share()
    const r2 = share({ days: 30 })
    if (!r.ok || !r2.ok) throw new Error('share')
    revokeShare(r.share.id)
    expect(resolveShareToken(shareToken(r.share.id))).toBeNull()
    getDb().prepare('UPDATE work_item_shares SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, r2.share.id)
    expect(resolveShareToken(shareToken(r2.share.id))).toBeNull()
    expect(listProjectShares(pid).every((s) => !s.live && !s.path)).toBe(true)
  })

  it('mas projekt munkadarabja nem adhato ki ennek a projektnek a neveben', () => {
    const p2 = createProject({ name: 'Masik' })
    if (!p2.ok) throw new Error('p2')
    const other = createWorkItem({ project_id: p2.project.id, title: 'Titok', type: 'note' })
    if (!other.ok) throw new Error('other')
    expect(share({ work_item_id: other.item.id })).toEqual({ ok: false, code: 'item_not_found' })
    expect(share({ days: 3 })).toEqual({ ok: false, code: 'bad_days' })
    expect(share({ kind: 'x' })).toEqual({ ok: false, code: 'bad_kind' })
    expect(requestShare({ kind: 'handoff', project_id: pid, scope: 'minden', lang: 'hu', actor: null })).toEqual({ ok: false, code: 'bad_scope' })
  })

  it('a hitelesito kapu a /view/ utat nem kapuzza, az API-t igen', () => {
    expect(requiresAuth('/view/abc', 'GET')).toBe(false)
    expect(requiresAuth('/api/workbench/shares', 'GET')).toBe(true)
    expect(requiresAuth('/api/workbench/shares', 'POST')).toBe(true)
  })
})

describe('betekinto link: a nyilvanos lap', () => {
  beforeEach(setup)

  it('munkadarab-lap: 200, sandbox CSP, szkript nincs, a szamlalo no', async () => {
    const evil = createWorkItem({ project_id: pid, title: 'Ajánlat <script>alert(1)</script>', type: 'note' })
    if (!evil.ok) throw new Error('evil')
    const r = share({ work_item_id: evil.item.id })
    if (!r.ok) throw new Error('share')
    const v = await view(`/view/${shareToken(r.share.id)}`)
    expect(v.status).toBe(200)
    expect(v.headers['Content-Security-Policy']).toContain('sandbox')
    expect(v.headers['Content-Security-Policy']).toContain("default-src 'none'")
    expect(v.headers['Referrer-Policy']).toBe('no-referrer')
    expect(v.text).toContain('Ajánlat')
    expect(v.text).toContain('Csak olvasható')
    expect(v.text.toLowerCase()).not.toContain('<script')
    expect(getShare(r.share.id)?.view_count).toBe(1)
  })

  it('rossz / visszavont token: 404 emberi mondattal, ket nyelven ha nem tudni a nyelvet', async () => {
    const v = await view('/view/nincs-ilyen')
    expect(v.status).toBe(404)
    expect(v.text).toContain('Ez a link nem érvényes')
    expect(v.text).toContain('This link is not valid')
    const r = share({ lang: 'en' })
    if (!r.ok) throw new Error('share')
    revokeShare(r.share.id)
    const g = await view(`/view/${shareToken(r.share.id)}`)
    expect(g.status).toBe(404)
    expect(g.text).toContain('This link is not valid')
    expect(g.text).not.toContain('Ajánlat')
  })

  it('csomag-lap: csak ennek a projektnek a munkadarabjai; iras 405', async () => {
    const p2 = createProject({ name: 'Masik' })
    if (!p2.ok) throw new Error('p2')
    createWorkItem({ project_id: p2.project.id, title: 'Idegen titok', type: 'note' })
    const r = requestShare({ kind: 'handoff', project_id: pid, scope: 'all', lang: 'hu', actor: null })
    if (!r.ok) throw new Error('share')
    const tok = shareToken(r.share.id)
    const v = await view(`/view/${tok}`)
    expect(v.status).toBe(200)
    expect(v.text).toContain('Kovács weboldal')
    expect(v.text).toContain('Ajánlat')
    expect(v.text).not.toContain('Idegen titok')
    expect(v.text.toLowerCase()).not.toContain('<script')
    expect((await view(`/view/${tok}`, 'POST')).status).toBe(405)
    expect((await view(`/view/${tok}/file`)).status).toBe(404)
  })

  it('munkadarab-link a csomagot nem tolti le; mas ut nem a mienk', async () => {
    const r = share()
    if (!r.ok) throw new Error('share')
    expect((await view(`/view/${shareToken(r.share.id)}/download`)).status).toBe(404)
    expect((await view('/api/workbench/shares')).handled).toBe(false)
  })
})

describe('betekinto link: API', () => {
  beforeEach(setup)

  it('letrehozas, lista, visszavonas; hibak emberi mondattal', async () => {
    const c = await callWorkbench('/api/workbench/shares', 'POST', { kind: 'item', project: pid, item_id: itemId, days: 7 })
    expect(c.status).toBe(200)
    expect(c.body.state).toBe('active')
    expect(c.body.shares[0].path).toMatch(/^\/view\//)
    const l = await callWorkbench(`/api/workbench/shares?project=${pid}`, 'GET')
    expect(l.body.shares).toHaveLength(1)
    const rv = await callWorkbench(`/api/workbench/shares/${c.body.share.id}/revoke`, 'POST', {})
    expect(rv.status).toBe(200)
    expect(rv.body.shares[0].live).toBe(false)
    expect((await callWorkbench('/api/workbench/shares/nincs/revoke', 'POST', {})).status).toBe(404)
    const bd = await callWorkbench('/api/workbench/shares', 'POST', { kind: 'item', project: pid, item_id: itemId, days: 5 })
    expect(bd.status).toBe(400)
    expect(bd.body.message).toBeTruthy()
    level = 1
    expect((await callWorkbench('/api/workbench/shares', 'POST', { kind: 'item', project: pid, item_id: itemId })).status).toBe(403)
    level = 3
    setProjectArchived(pid, true)
    expect((await callWorkbench('/api/workbench/shares', 'POST', { kind: 'item', project: pid, item_id: itemId })).status).toBe(409)
  })
})

describe('betekinto link: a felulet', () => {
  const PLAN = { items: [{ id: 'w1', title: 'Ajánlat', type: 'note', status: 'done' }], all_count: 1, done_count: 1, files: 1, total_bytes: 100, too_large: false }

  function open(shares: unknown[], post?: { status: number; body: unknown }) {
    const h = workbenchHarness()
    h.respond((url, init) => {
      if (url.includes('/api/workbench/shares/')) return post || { status: 200, body: { shares: [] } }
      if (url.includes('/api/workbench/shares')) return post && init?.method === 'POST' ? post : { status: 200, body: { shares, public_base: 'https://marveen.example' } }
      if (url.includes('/api/workbench/handoff')) return { status: 200, body: { plan: PLAN } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'ho-open' })
    return h
  }

  it('ures allapot: letrehozo gomb es napok, fordithatoan', async () => {
    const h = open([])
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="share-create"'))
    expect(h.html()).toContain('data-wb-days="7" aria-pressed="true"')
    expect(h.html()).not.toContain('workbench.share.local_only')
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'Ajánlat'])).toBe('')
  })

  it('elo link: masolhato teljes cim es visszavonas-gomb; fuggo: jovahagyasokhoz visz', async () => {
    const h = open([
      { id: 's1', kind: 'handoff', scope: 'done', status: 'active', live: true, path: '/view/tok1', expires_at: 2_000_000_000, view_count: 2 },
      { id: 's2', kind: 'handoff', scope: 'all', status: 'pending', live: false, path: null },
    ])
    await vi.waitFor(() => expect(h.html()).toContain('https://marveen.example/view/tok1'))
    const html = h.html()
    expect(html).toContain('data-wb-act="share-revoke" data-wb-share="s1"')
    expect(html).toContain('data-wb-act="share-revoke" data-wb-share="s2"')
    expect(html).toContain('data-wb-act="goto-approvals"')
    expect(html).toContain('workbench.share.st.pending')
  })

  it('kattintas: POST a jelenlegi napszammal, toast', async () => {
    const h = open([], { status: 200, body: { state: 'pending', share: {}, shares: [] } })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="share-create"'))
    h.click({ 'data-wb-act': 'share-days', 'data-wb-days': '30' })
    h.click({ 'data-wb-act': 'share-create', 'data-wb-share-kind': 'handoff' })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.share.toast_pending⟧'))
    const call = h.fetchCalls.find((c) => c.url.startsWith('/api/workbench/shares?') && c.init?.method === 'POST')
    expect(JSON.parse(call?.init?.body as string)).toMatchObject({ kind: 'handoff', project: 'p1', days: 30, scope: 'done' })
  })
})
