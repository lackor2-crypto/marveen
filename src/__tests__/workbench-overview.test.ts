// #406, 2. pont -- PROJEKT-ATTEKINTO a Munkapad tetejen: a szerver-oldal (mert
// adat) ES a felulet (mit lat a felhasznalo).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, createKanbanCard, createApproval, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, createWorkItemVersion, addWorkItemPart } from '../workbench.js'
import { buildWorkbenchOverview, RECENT_DONE_DAYS } from '../workbench-overview.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

let pid = ''
let other = ''

function item(title: string, status: string) {
  const r = createWorkItem({ project_id: pid, title, type: 'note', status })
  if (!r.ok) throw new Error('nem jott letre')
  return r.item
}

describe('attekinto: a szerver merese', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const a = createProject({ name: 'Kovács weboldal' })
    const b = createProject({ name: 'Másik' })
    if (!a.ok || !b.ok) throw new Error('projekt')
    pid = a.project.id
    other = b.project.id
  })

  it('FRISS projekt: minden ures, de nem hiba (a szamok nullak, nem null-ok)', () => {
    const o = buildWorkbenchOverview(pid)
    expect(o.open.count).toBe(0)
    expect(o.review.count).toBe(0)
    expect(o.approvals.count).toBe(0)
    expect(o.approvals.error).toBeNull()
    expect(o.cards.open).toBe(0)
    expect(o.recent_done.count).toBe(0)
    expect(o.last_file).toBeNull()
  })

  it('nyitott / atnezesre var / friss kesz -- es a regen kesz NEM friss', () => {
    item('Vázlat', 'draft')
    item('Folyik', 'in_progress')
    const rev = item('Nézd át', 'review')
    const done = item('Kész', 'done')
    const old = item('Régi kész', 'done')
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now - (RECENT_DONE_DAYS + 2) * 86400, old.id)
    const o = buildWorkbenchOverview(pid, now)
    expect(o.open.count).toBe(3)
    expect(o.review.items.map((i) => i.id)).toEqual([rev.id])
    expect(o.recent_done.items.map((i) => i.id)).toEqual([done.id])
  })

  it('MASIK projekt adata nem szivarog at', () => {
    const r = createWorkItem({ project_id: other, title: 'Idegen', type: 'note', status: 'review' })
    expect(r.ok).toBe(true)
    const o = buildWorkbenchOverview(pid)
    expect(o.open.count).toBe(0)
    expect(o.review.count).toBe(0)
  })

  it('jovahagyasra var: a Munkapad sajat jegye ES a projekt kartyajara szolo jegy is, a masik projekte nem', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'Projekt kártya', project: pid, status: 'in_progress' })
    createKanbanCard({ id: 'bbbb2222', title: 'Másik kártya', project: other })
    createApproval({ id: 'ap1', agent_id: 'main', category: 'workbench_file_write', action_description: 'Fájl írása', action_payload: JSON.stringify({ source: 'workbench', project: pid }) })
    createApproval({ id: 'ap2', agent_id: 'main', category: 'kanban_done', action_description: 'Kész', action_payload: JSON.stringify({ kanban_card_id: 'aaaa1111' }) })
    createApproval({ id: 'ap3', agent_id: 'main', category: 'kanban_done', action_description: 'Idegen', action_payload: JSON.stringify({ kanban_card_id: 'bbbb2222' }) })
    const o = buildWorkbenchOverview(pid)
    expect(o.approvals.count).toBe(2)
    expect(o.approvals.items.map((a) => a.id).sort()).toEqual(['ap1', 'ap2'])
    expect(o.cards.open).toBe(1)
    // Boss, 2026-09-26: each approval is drawn as its own card -- it carries
    // the card's number and title; a card-less ticket has none.
    const ap2 = o.approvals.items.find((a) => a.id === 'ap2')!
    expect(ap2.card_title).toBe('Projekt kártya')
    expect(typeof ap2.card_seq).toBe('number')
    const ap1 = o.approvals.items.find((a) => a.id === 'ap1')!
    expect(ap1.card_seq).toBeNull()
  })

  it('utoljara valtozott fajl: a legfrissebb verzio-forras vagy kep-resz', () => {
    const a = item('Ajánlat', 'draft')
    createWorkItemVersion(a.id, { source_path: 'Projektek/kovacs/ajanlat.docx' })
    const b = item('Poszt', 'draft')
    addWorkItemPart({ work_item_id: b.id, kind: 'image', asset_path: 'Projektek/kovacs/foto.jpg' })
    getDb().prepare('UPDATE work_item_parts SET updated_at = updated_at + 100').run()
    const o = buildWorkbenchOverview(pid)
    expect(o.last_file?.name).toBe('foto.jpg')
    expect(o.last_file?.item_id).toBe(b.id)
  })

  it('a vegpont: 400 projekt nelkul, 404 ismeretlen projektre, kulonben a meres', async () => {
    expect((await callWorkbench('/api/workbench/overview', 'GET')).status).toBe(400)
    const miss = await callWorkbench('/api/workbench/overview?project=nincs&lang=en', 'GET')
    expect(miss.status).toBe(404)
    expect(miss.body.message).toMatch(/not found/i)
    const ok = await callWorkbench(`/api/workbench/overview?project=${pid}`, 'GET')
    expect(ok.status).toBe(200)
    expect(ok.body.overview.open.count).toBe(0)
  })
})

describe('attekinto: a felulet', () => {
  const OV = {
    open: { count: 2, items: [{ id: 'w1', title: 'Ajánlat', status: 'draft', updated_at: 1 }] },
    cards: { open: 3, error: null },
    review: { count: 1, items: [{ id: 'w2', title: 'Poszt', status: 'review', updated_at: 1 }] },
    approvals: { count: 1, items: [{ id: 'ap', category: 'x', description: 'Fájl írása: logo.png', requested_at: 1 }], error: null },
    recent_done: { count: 0, items: [], days: 14 },
    last_file: { name: 'logo.png', rel: 'P/logo.png', item_id: 'w1', item_title: 'Ajánlat', at: 1 },
  }

  function open(h: ReturnType<typeof workbenchHarness>, overview: unknown, status = 200) {
    h.respond((url) => {
      if (url.includes('/api/workbench/overview')) return status === 200 ? { status, body: { overview } } : { status, body: { error: 'x', message: 'Belső hiba' } }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/w')) return { status: 200, body: { item: { id: 'w2', title: 'Poszt', type: 'note', status: 'review' }, versions: [], parts: [] } }
      return { status: 200, body: itemsBody([{ id: 'w1', title: 'Ajánlat', type: 'note', status: 'draft' }]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  }

  it('a negy csempe a Munkapad TETEJEN all, a szamokkal es a kattinthato munkadarabokkal', async () => {
    const h = workbenchHarness()
    open(h, OV)
    await vi.waitFor(() => expect(h.html()).toContain('wb-ov-tile'))
    const html = h.html()
    expect(html.indexOf('class="wb-ov"')).toBeLessThan(html.indexOf('wb-split'))
    expect(html).toContain('workbench.ov.open')
    expect(html).toContain('workbench.ov.wait')
    expect(html).toContain('workbench.ov.done')
    expect(html).toContain('workbench.ov.file')
    expect(html).toContain('<div class="wb-ov-num">2</div>')
    // Var: 1 atnezesre varo munkadarab + 1 jegy = 2, es kiemelve.
    expect(html).toMatch(/wb-ov-wait wb-ov-attn[^]*?<div class="wb-ov-num">2<\/div>/)
    expect(html).toContain('logo.png')
    expect(html).toContain('data-wb-act="goto-approvals"')
    expect(html).toContain('data-wb-item="w2"')
  })

  it('ket jovahagyas KET kulon kis kartya: sorszam, cim, datum -- nem egy szovegfolyam', async () => {
    const h = workbenchHarness()
    open(h, { ...OV, approvals: { count: 2, error: null, items: [
      { id: 'a1', category: 'kanban_done', description: 'Kártya #404 (kanban-azonosító: cd19e75c): hosszú', requested_at: 1, card_seq: 404, card_title: 'Munkapad-ágens eszközei' },
      { id: 'a2', category: 'kanban_done', description: 'Kártya #398: Raktár', requested_at: 1, card_seq: 398, card_title: 'Raktár a MEGA-n' },
    ] } })
    await vi.waitFor(() => expect(h.html()).toContain('wb-ov-approvals'))
    const html = h.html()
    expect(html.match(/<li class="wb-ov-approval">/g)!.length).toBe(2)
    expect(html).toContain('<span class="wb-ov-apv-seq">#404</span> Munkapad-ágens eszközei')
    expect(html).toContain('<span class="wb-ov-apv-seq">#398</span> Raktár a MEGA-n')
    expect(html).toContain('workbench.ov.apv_when')
    expect(html).not.toContain('kanban-azonosító: cd19e75c')
  })

  it('a csempe munkadarabjara kattintva az nyilik meg', async () => {
    const h = workbenchHarness()
    open(h, OV)
    await vi.waitFor(() => expect(h.html()).toContain('wb-ov-tile'))
    h.click({ 'data-wb-item': 'w2' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/w2'))).toBe(true))
  })

  it('FRISS TELEPITES: ures projektben baratsagos mondatok, nem hiba', async () => {
    const h = workbenchHarness()
    open(h, { open: { count: 0, items: [] }, cards: { open: 0, error: null }, review: { count: 0, items: [] }, approvals: { count: 0, items: [], error: null }, recent_done: { count: 0, items: [], days: 14 }, last_file: null })
    await vi.waitFor(() => expect(h.html()).toContain('wb-ov-tile'))
    const html = h.html()
    expect(html).toContain('workbench.ov.open_none')
    expect(html).toContain('workbench.ov.wait_none')
    expect(html).toContain('workbench.ov.file_none')
    expect(html).not.toContain('wb-ov-attn')
    expect(html).not.toContain('wb-preview-bad')
  })

  it('A NULLA KET DOLGOT JELENT: ha nem tudtam lekerdezni, azt mondom, nem nullat', async () => {
    const h = workbenchHarness()
    open(h, null, 500)
    await vi.waitFor(() => expect(h.html()).toContain('workbench.ov.error'))
    expect(h.html()).toContain('Belső hiba')
    expect(h.html()).not.toContain('wb-ov-num')
  })

  it('egy forras kiesese (kartyak) KULON latszik, a tobbi szam megmarad', async () => {
    const h = workbenchHarness()
    open(h, { ...OV, cards: { open: null, error: 'no such table' }, approvals: { count: null, items: [], error: 'db locked' } })
    await vi.waitFor(() => expect(h.html()).toContain('wb-ov-tile'))
    const html = h.html()
    expect(html).toContain('workbench.ov.cards_unknown')
    expect(html).toContain('workbench.ov.approvals_unknown')
    // A jovahagyas-szam ismeretlen: a csempen NEM all szam.
    expect(html).not.toMatch(/wb-ov-wait[^"]*"><div class="wb-ov-title">[^<]*<\/div><div class="wb-ov-num">/)
  })

  it('minden sajat szoveg a t()-n megy at', async () => {
    const h = workbenchHarness()
    open(h, OV)
    await vi.waitFor(() => expect(h.html()).toContain('wb-ov-tile'))
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'Ajánlat', 'Poszt', 'Fájl írása: logo.png'])).toBe('')
  })
})
