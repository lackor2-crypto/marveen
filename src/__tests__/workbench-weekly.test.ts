// #406, 13. pont -- AUTOMATIKUS HETI OSSZEFOGLALO: a het hatarai, a szamitas,
// a mentes (egyszer, megmarad), a sopres, a vegpont ES a felulet.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, createWorkItemVersion } from '../workbench.js'
import { addDecision } from '../workbench-decisions.js'
import {
  weekStartOf, nextWeekStart, prevWeekStart, computeWeeklySummary, ensureLastWeekSummary,
  listWeeklySummaries, currentWeekSummary, sweepWeeklySummaries,
} from '../workbench-weekly.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

const sec = (d: Date): number => Math.floor(d.getTime() / 1000)
// 2026-09-23 szerda 10:00 helyi ido -> a het hetfo 09-21 00:00.
const WED = sec(new Date(2026, 8, 23, 10, 0, 0))
const MON = sec(new Date(2026, 8, 21, 0, 0, 0))

let pid = ''

/** Minden idobelyeget egy adott pillanatra allit (a tesztben a "mult het"). */
function backdate(table: string, at: number) {
  getDb().prepare(`UPDATE ${table} SET created_at = ?`).run(at)
  if (table === 'work_items') getDb().prepare('UPDATE work_items SET updated_at = ?').run(at)
}

describe('heti osszefoglalo: a szerver', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Kovács weboldal' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
  })

  it('a het hetfo 00:00-tol a kovetkezo hetfo 00:00-ig tart (helyi ido)', () => {
    expect(weekStartOf(WED)).toBe(MON)
    expect(weekStartOf(MON)).toBe(MON)
    expect(weekStartOf(MON - 1)).toBe(prevWeekStart(MON))
    expect(nextWeekStart(MON)).toBe(sec(new Date(2026, 8, 28, 0, 0, 0)))
    // vasarnap is az elozo hetfohoz tartozik
    expect(weekStartOf(sec(new Date(2026, 8, 27, 23, 0, 0)))).toBe(MON)
  })

  it('friss projekt, semmi nem tortent: "csendes", nem hiba', () => {
    const s = currentWeekSummary(pid, WED)
    expect(s).toMatchObject({ live: true, quiet: true, errors: [], open_now: 0 })
  })

  it('szamol: uj, kesz, valtozat, dontes -- a heten kivuli esemeny nem szamit bele', () => {
    const a = createWorkItem({ project_id: pid, title: 'Ajánlat', type: 'document', status: 'done' })
    const b = createWorkItem({ project_id: pid, title: 'Poszt', type: 'composite' })
    if (!a.ok || !b.ok) throw new Error('munkadarab')
    createWorkItemVersion(b.item.id, {})
    createWorkItemVersion(b.item.id, {})
    addDecision({ project_id: pid, text: 'A logó kék marad.' })
    // mind a mult hetre
    const lastWeek = prevWeekStart(MON) + 3600
    for (const t of ['work_items', 'work_item_versions', 'workbench_decisions']) backdate(t, lastWeek)
    const s = computeWeeklySummary(pid, prevWeekStart(MON), MON, WED, false)
    expect(s.counts).toMatchObject({ items_created: 2, finished: 1, decisions: 1 })
    expect(s.created.sort()).toEqual(['Ajánlat', 'Poszt'])
    expect(s.finished).toEqual(['Ajánlat'])
    expect(s.decisions).toEqual(['A logó kék marad.'])
    expect(s.busiest[0]).toMatchObject({ title: 'Poszt' })
    expect(s.quiet).toBe(false)
    // az ezt koveto het: semmi
    expect(computeWeeklySummary(pid, MON, nextWeekStart(MON), WED, true).quiet).toBe(true)
  })

  it('a mult heti osszefoglalo EGYSZER keszul el, es megmarad', () => {
    getDb().prepare('UPDATE projects SET created_at = ?').run(prevWeekStart(MON) - 10)
    expect(ensureLastWeekSummary(pid, WED)).toBe('created')
    expect(ensureLastWeekSummary(pid, WED)).toBe('exists')
    const weeks = listWeeklySummaries(pid)
    expect(weeks).toHaveLength(1)
    expect(weeks[0]).toMatchObject({ week_start: prevWeekStart(MON), week_end: MON, live: false })
  })

  it('a heten letrehozott projektnek nincs "mult hete"', () => {
    getDb().prepare('UPDATE projects SET created_at = ?').run(MON + 100)
    expect(ensureLastWeekSummary(pid, WED)).toBe('too_new')
    expect(listWeeklySummaries(pid)).toEqual([])
  })

  it('olvashatatlan forras: NEM ment el hamis "csendes" hetet, jelzi a hibat', () => {
    getDb().prepare('UPDATE projects SET created_at = ?').run(prevWeekStart(MON) - 10)
    getDb().exec('CREATE TABLE workbench_decisions (x INTEGER)')
    const s = computeWeeklySummary(pid, prevWeekStart(MON), MON, WED, false)
    expect(s.errors.map((e) => e.source)).toContain('decisions')
    expect(s.quiet).toBe(false)
    expect(ensureLastWeekSummary(pid, WED)).toBe('failed')
    expect(listWeeklySummaries(pid)).toEqual([])
  })

  it('a sopres minden aktiv projektre elkesziti, masodszorra nem duplaz', () => {
    const q = createProject({ name: 'Másik' })
    if (!q.ok) throw new Error('projekt')
    getDb().prepare('UPDATE projects SET created_at = ?').run(prevWeekStart(MON) - 10)
    expect(sweepWeeklySummaries(WED)).toEqual({ created: 2, failed: 0 })
    expect(sweepWeeklySummaries(WED)).toEqual({ created: 0, failed: 0 })
  })

  it('vegpont: folyo het + mentett hetek; hibak emberi mondattal', async () => {
    const ok = await callWorkbench(`/api/workbench/weekly?project=${pid}&lang=hu`, 'GET')
    expect(ok.status).toBe(200)
    expect(ok.body.current).toMatchObject({ live: true })
    expect(Array.isArray(ok.body.weeks)).toBe(true)
    const none = await callWorkbench('/api/workbench/weekly?lang=en', 'GET')
    expect(none.status).toBe(400)
    const missing = await callWorkbench('/api/workbench/weekly?project=nincs&lang=hu', 'GET')
    expect(missing.status).toBe(404)
    expect(typeof missing.body.message).toBe('string')
  })
})

describe('heti osszefoglalo: a felulet', () => {
  const WEEK = (over: Record<string, unknown> = {}) => ({
    project_id: 'p1', week_start: MON, week_end: nextWeekStart(MON), live: true, generated_at: WED,
    counts: { items_created: 1, versions: 3, files: 0, approvals_requested: 0, approvals_approved: 0, approvals_rejected: 0, cards_created: 0, cards_done: 0, decisions: 1, finished: 0 },
    created: ['Ajánlat'], finished: [], busiest: [{ title: 'Ajánlat', versions: 3 }], decisions: ['A logó kék marad.'],
    open_now: 1, quiet: false, errors: [], ...over,
  })

  function open(reply: () => { status: number; body: unknown }) {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/api/workbench/weekly')) return reply()
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'wk-open' })
    return h
  }

  it('a folyo het szamai, nevei es a dontesek; forditott szovegek', async () => {
    const h = open(() => ({ status: 200, body: { current: WEEK(), weeks: [] } }))
    await vi.waitFor(() => expect(h.html()).toContain('workbench.wk.this_week'))
    expect(h.html()).toContain('workbench.wk.f.created')
    expect(h.html()).toContain('A logó kék marad.')
    expect(h.html()).toContain('workbench.wk.no_history')
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'Ajánlat', 'A logó kék marad.'])).toBe('')
  })

  it('regi het kivalaszthato', async () => {
    const old = WEEK({ live: false, week_start: prevWeekStart(MON), week_end: MON, created: ['Régi anyag'] })
    const h = open(() => ({ status: 200, body: { current: WEEK(), weeks: [old] } }))
    await vi.waitFor(() => expect(h.html()).toContain(`data-wb-week="${prevWeekStart(MON)}"`))
    h.click({ 'data-wb-act': 'wk-show', 'data-wb-week': String(prevWeekStart(MON)) })
    await vi.waitFor(() => expect(h.html()).toContain('Régi anyag'))
    expect(h.html()).toContain('workbench.wk.week_of')
  })

  it('csendes het: kulon mondat; hianyos forras: sarga figyelmeztetes', async () => {
    const h = open(() => ({ status: 200, body: { current: WEEK({ quiet: true }), weeks: [] } }))
    await vi.waitFor(() => expect(h.html()).toContain('workbench.wk.quiet_now'))
    const h2 = open(() => ({ status: 200, body: { current: WEEK({ errors: [{ source: 'cards', detail: 'x' }] }), weeks: [] } }))
    await vi.waitFor(() => expect(h2.html()).toContain('workbench.wk.partial'))
    expect(h2.html()).toContain('wb-wk-warn')
  })

  it('betoltesi hiba: a szerver mondata + ujraproba, nem "csendes het"', async () => {
    const h = open(() => ({ status: 500, body: { error: 'x', message: 'Belső hiba' } }))
    await vi.waitFor(() => expect(h.html()).toContain('Belső hiba'))
    expect(h.html()).toContain('data-wb-act="wk-refresh"')
    expect(h.html()).not.toContain('workbench.wk.quiet')
  })
})
