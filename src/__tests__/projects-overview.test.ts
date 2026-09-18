// A projekt Attekintese (kanban #321, spec 9-13. pont): CSAK mert adatbol.
//
// Amit ez a teszt orzi:
//   - a kovetkezo lepesek sorrendje: prioritas, hatarido, allapot -- nem
//     kitalalt lista, hanem a projekt nyitott kartyai;
//   - az "aktualis munka" csak valodi jelbol all: folyamatban levo kartya,
//     ervenyes foglalas, futo kodfeladat (a kartya nelkuli is, ha a projekt
//     kod-hid aliasan fut);
//   - a jovahagyas a kartyan at tartozik a projekthez, nincs kulon mezo;
//   - a mappa allapota kulon mondja meg, hogy "nincs Raktar", "nincs mappa",
//     "eltunt a mappa" vagy "rendben" -- a nulla fajl nem ugyanaz mindegyiknel.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createKanbanCard, moveKanbanCard, addKanbanComment, createApproval, getDb } from '../db.js'
import { resetCodeBridgeTablesForTests, listCodeTasks } from '../web/code-bridge-store.js'
import { claimCardWork } from '../web/card-work-guard.js'
import { createProject, linkObject, updateProject } from '../projects.js'
import { buildProjectOverview, sortNextSteps, type OverviewCard } from '../project-overview.js'

const DAY = 86_400_000

function mustProject(name: string) {
  const r = createProject({ name })
  if (!r.ok) throw new Error(r.code)
  return r.project
}

function addTask(id: string, alias: string, status: string, cardRef: string | null) {
  getDb().prepare(
    `INSERT INTO code_tasks (id, project, prompt, status, origin, workspace_path, card_ref, created_at)
     VALUES (?, ?, 'feladat', ?, 'dashboard', '/repo', ?, ?)`,
  ).run(id, alias, status, cardRef, Date.now())
}

let savedDepot: string | undefined
let depotDir: string | null = null

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  listCodeTasks()
  savedDepot = process.env.MARVEEN_DEPOT
  delete process.env.MARVEEN_DEPOT
})

afterEach(() => {
  if (savedDepot === undefined) delete process.env.MARVEEN_DEPOT
  else process.env.MARVEEN_DEPOT = savedDepot
  if (depotDir) { rmSync(depotDir, { recursive: true, force: true }); depotDir = null }
})

describe('kovetkezo lepesek sorrendje', () => {
  it('prioritas, aztan hatarido, aztan allapot', () => {
    const c = (id: string, priority: string, dueAt: number | null, status: string): OverviewCard =>
      ({ id, seq: null, title: id, status, priority, assignee: null, dueAt, updatedAt: 0 })
    const sorted = sortNextSteps([
      c('low', 'low', null, 'in_progress'),
      c('normal-late', 'normal', 2000, 'planned'),
      c('normal-soon', 'normal', 1000, 'planned'),
      c('urgent', 'urgent', null, 'planned'),
      c('normal-nodue-waiting', 'normal', null, 'waiting'),
      c('normal-nodue-progress', 'normal', null, 'in_progress'),
    ]).map((x) => x.id)
    expect(sorted).toEqual(['urgent', 'normal-soon', 'normal-late', 'normal-nodue-progress', 'normal-nodue-waiting', 'low'])
  })
})

describe('attekintes', () => {
  it('csak a projekt kartyait latja; aktualis munka = folyamatban + foglalas + futo kodfeladat', () => {
    const p = mustProject('Weboldal')
    createKanbanCard({ id: 'a', title: 'Folyamatban', project: p.id, status: 'planned' })
    moveKanbanCard('a', 'in_progress', 0, 'agens')
    createKanbanCard({ id: 'b', title: 'Tervezett, de foglalt', project: p.id, status: 'planned' })
    claimCardWork({ cardId: 'b', holder: 'fejleszto', kind: 'message' })
    createKanbanCard({ id: 'c', title: 'Csendes tervezett', project: p.id, status: 'planned' })
    createKanbanCard({ id: 'x', title: 'Masik projekt', project: 'mas', status: 'in_progress' })
    linkObject(p.id, 'code_alias', 'web-alias')
    addTask('t1', 'web-alias', 'running', null)
    addTask('t2', 'masik-alias', 'running', 'c')
    addTask('t3', 'web-alias', 'done', null)

    const ov = buildProjectOverview(p.id)!
    const byCard = ov.currentWork.filter((w) => w.card).map((w) => w.card!.id).sort()
    // `c` a masik aliason futo feladat miatt is aktiv -- a kartya-hivatkozas szamit.
    expect(byCard).toEqual(['a', 'b', 'c'])
    expect(ov.currentWork.find((w) => w.card?.id === 'b')!.claims[0]).toMatchObject({ holder: 'fejleszto', kind: 'message' })
    // A projekt aliasan futo, kartya nelkuli kodfeladat is latszik; a kesz nem.
    const cardless = ov.currentWork.filter((w) => !w.card)
    expect(cardless.map((w) => w.codeTasks[0].id)).toEqual(['t1'])
    expect(ov.hasDevWork).toBe(true)
    expect(ov.nextSteps.map((c) => c.id)).not.toContain('x')
    expect(ov.facts).toMatchObject({ openCards: 3, inProgress: 1, activeWork: 3 })
  })

  it('a jovahagyas a kartyan at tartozik a projekthez; az idovonal a mert esemenyekbol all', () => {
    const p = mustProject('Weboldal')
    createKanbanCard({ id: 'a', title: 'Szöveg', project: p.id, status: 'planned' })
    createKanbanCard({ id: 'z', title: 'Idegen', status: 'planned' })
    moveKanbanCard('a', 'waiting', 0, 'agens')
    addKanbanComment('a', 'agens', 'Kész az első változat')
    createApproval({ id: 'ap1', agent_id: 'agens', category: 'kanban_done', action_description: 'Kész?', action_payload: JSON.stringify({ kanban_card_id: 'a' }) })
    createApproval({ id: 'ap2', agent_id: 'agens', category: 'kanban_done', action_description: 'Idegen', action_payload: JSON.stringify({ kanban_card_id: 'z' }) })
    createApproval({ id: 'ap3', agent_id: 'agens', category: 'other', action_description: 'Nem JSON', action_payload: 'nem-json' })

    const ov = buildProjectOverview(p.id)!
    expect(ov.approvals.map((a) => a.id)).toEqual(['ap1'])
    expect(ov.approvals[0]).toMatchObject({ cardId: 'a', cardTitle: 'Szöveg' })
    const kinds = ov.activity.map((a) => a.kind).sort()
    expect(kinds).toEqual(['approval', 'comment', 'status'])
    expect(ov.activity.find((a) => a.kind === 'status')).toMatchObject({ cardId: 'a', from: 'planned', to: 'waiting', actor: 'agens' })
    expect(ov.facts).toMatchObject({ waiting: 1, pendingApprovals: 1 })
  })

  it('lejart es regota mozdulatlan kartya: szamok, nem velemeny', () => {
    const p = mustProject('Weboldal')
    const now = Date.now()
    createKanbanCard({ id: 'late', title: 'Lejárt', project: p.id, status: 'planned', due_date: Math.floor((now - DAY) / 1000) })
    createKanbanCard({ id: 'old', title: 'Régi', project: p.id, status: 'planned' })
    createKanbanCard({ id: 'done', title: 'Kész', project: p.id, status: 'done', due_date: Math.floor((now - DAY) / 1000) })
    getDb().prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(Math.floor((now - 20 * DAY) / 1000), 'old')
    const ov = buildProjectOverview(p.id, { now })!
    expect(ov.facts).toMatchObject({ openCards: 2, overdue: 1, staleOpenCards: 1 })
    expect(ov.nextSteps.map((c) => c.id)).not.toContain('done')
  })

  it('ismeretlen projekt: null', () => {
    expect(buildProjectOverview('nincs-ilyen')).toBeNull()
  })
})

describe('a mappa allapota -- a nulla fajl negyfele dolgot jelenthet', () => {
  it('Raktar nelkul: no_depot (akkor is, ha a projektnek meg nincs mappaja)', () => {
    const p = mustProject('Weboldal')
    expect(buildProjectOverview(p.id)!.folder.state).toBe('no_depot')
    updateProject(p.id, { folder_path: 'Projektek/Weboldal' })
    expect(buildProjectOverview(p.id)!.folder.state).toBe('no_depot')
  })

  it('Raktarral: no_folder / missing / ok, es a fajlok az idovonalra kerulnek', () => {
    depotDir = mkdtempSync(join(tmpdir(), 'prj-depot-'))
    process.env.MARVEEN_DEPOT = depotDir
    const p = mustProject('Weboldal')
    expect(buildProjectOverview(p.id)!.folder.state).toBe('no_folder')
    updateProject(p.id, { folder_path: 'Projektek/Weboldal' })
    expect(buildProjectOverview(p.id)!.folder.state).toBe('missing')
    mkdirSync(join(depotDir, 'Projektek', 'Weboldal', 'Tudásbázis'), { recursive: true })
    writeFileSync(join(depotDir, 'Projektek', 'Weboldal', 'Tudásbázis', 'terv.md'), 'x')
    writeFileSync(join(depotDir, 'Projektek', 'Weboldal', '.rejtett'), 'x')
    const ov = buildProjectOverview(p.id)!
    expect(ov.folder).toMatchObject({ state: 'ok', path: 'Projektek/Weboldal', recentFiles: 1 })
    expect(ov.activity.filter((a) => a.kind === 'file')).toEqual([
      expect.objectContaining({ name: 'terv.md', rel: 'Projektek/Weboldal/Tudásbázis/terv.md' }),
    ])
  })
})
