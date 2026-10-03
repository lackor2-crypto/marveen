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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createKanbanCard, moveKanbanCard, addKanbanComment, createApproval, getDb } from '../db.js'
import { resetCodeBridgeTablesForTests, listCodeTasks } from '../web/code-bridge-store.js'
import { claimCardWork } from '../web/card-work-guard.js'
import { createProject, linkObject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { submitWorkItemForApproval } from '../workbench-approval.js'
import { listBoardWorkItems, buildWorkbenchOverview } from '../workbench-overview.js'
import { summaryFacts } from '../project-summary.js'
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
    // A kartya szuletese is esemeny (a sor sajat created_at-jebol).
    expect(kinds).toEqual(['approval', 'card_created', 'comment', 'status'])
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

  it('a munkadarabok is beleszamitanak a szamokba, az aktualis munkaba es a kovetkezo lepesekbe', () => {
    const p = mustProject('Tozsde')
    const other = mustProject('Masik')
    const mk = (project: string, title: string, status: string) => {
      const r = createWorkItem({ project_id: project, title, type: 'note', status })
      if (!r.ok) throw new Error('nem jott letre')
      return r.item
    }
    mk(p.id, 'Tervezet', 'draft')
    const running = mk(p.id, 'Fut', 'in_progress')
    mk(p.id, 'Atnezesre var', 'review')
    mk(p.id, 'Kesz', 'done')
    mk(other.id, 'Idegen', 'in_progress')
    createKanbanCard({ id: 'k', title: 'Kartya', project: p.id, status: 'planned' })

    const ov = buildProjectOverview(p.id)!
    // a kartya (1) + draft + in_progress + review; a kesz es az idegen nem szamit
    expect(ov.facts.openCards).toBe(4)
    expect(ov.facts.inProgress).toBe(1)
    expect(ov.facts.waiting).toBe(1)
    expect(ov.facts.activeWork).toBe(1)
    expect(ov.workItems.map((w) => w.title).sort()).toEqual(['Atnezesre var', 'Fut', 'Tervezet'])
    expect(ov.workItems.find((w) => w.id === running.id)?.status).toBe('in_progress')
  })

  it('munkadarab nelkuli (friss) projekten a munkadarab-lista ures, nem hiba', () => {
    const p = mustProject('Ures')
    const ov = buildProjectOverview(p.id)!
    expect(ov.workItems).toEqual([])
    expect(ov.doneWorkItems).toEqual([])
    expect(ov.approvals).toEqual([])
    expect(ov.facts).toMatchObject({ openCards: 0, done: 0, pendingApprovals: 0 })
  })

  // Boss, 2026-10-01 (TG 2021), the case itself: the Kanban tab showed 7M, 13M
  // and 14M, all three finished, and every number on the Overview was zero --
  // nothing counted a finished item.
  it('csupa KESZ munkadarab: a "kesz" szam annyi, amennyit a Kanban ful Kesz oszlopa mutat', () => {
    const p = mustProject('Tozsde')
    const now = Date.now()
    const mk = (title: string) => {
      const r = createWorkItem({ project_id: p.id, title, type: 'note', status: 'done' })
      if (!r.ok) throw new Error('nem jott letre')
      return r.item
    }
    mk('BL szignal')
    mk('BB szignal')
    const old = mk('Regi kesz')
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(Math.floor((now - 20 * DAY) / 1000), old.id)
    createKanbanCard({ id: 'kesz', title: 'Kesz kartya', project: p.id, status: 'done' })

    const ov = buildProjectOverview(p.id, { now })!
    expect(ov.facts.openCards).toBe(0)
    // ket friss kesz munkadarab + a kesz kartya; a 20 napos mar nincs a tablan
    expect(ov.facts.done).toBe(3)
    expect(ov.doneWorkItems.map((w) => w.title).sort()).toEqual(['BB szignal', 'BL szignal'])
    const boardDone = listBoardWorkItems(p.id, Math.floor(now / 1000)).filter((w) => w.column === 'done')
    expect(ov.doneWorkItems.length).toBe(boardDone.length)
    // ...es az idovonalon is ott vannak, a mostani allapotukkal
    const work = ov.activity.filter((a) => a.kind === 'work')
    expect(work.map((a) => a.name)).toEqual(expect.arrayContaining(['BL szignal', 'BB szignal', 'Regi kesz']))
    expect(work.every((a) => a.to === 'done' && !!a.workItemId)).toBe(true)
  })

  it('a munkadarab jovahagyasi kerese a projekte: a szamban es a listan is ott van', () => {
    const p = mustProject('Tozsde')
    const other = mustProject('Masik')
    const mk = (project: string, title: string) => {
      const r = createWorkItem({ project_id: project, title, type: 'note' })
      if (!r.ok) throw new Error('nem jott letre')
      return r.item
    }
    const mine = mk(p.id, 'Ajanlat')
    const foreign = mk(other.id, 'Idegen')
    expect(submitWorkItemForApproval(mine.id).ok).toBe(true)
    expect(submitWorkItemForApproval(foreign.id).ok).toBe(true)
    // a projekt egeszere szolo keres (nincs munkadarab, nincs kartya)
    createApproval({ id: 'share', agent_id: 'fo', category: 'workbench_share', action_description: 'Link', action_payload: JSON.stringify({ source: 'workbench', project: p.id, workItem: null }) })

    const ov = buildProjectOverview(p.id)!
    // kartya nincs a projekten -- a keres megis megvan
    expect(ov.facts).toMatchObject({ waiting: 1, pendingApprovals: 2 })
    const item = ov.approvals.find((a) => a.workItemId === mine.id)!
    expect(item).toMatchObject({ cardId: null, workItemTitle: 'Ajanlat', workItemSeq: mine.seq })
    expect(ov.approvals.find((a) => a.id === 'share')).toMatchObject({ cardId: null, workItemId: null })
    expect(ov.approvals.some((a) => a.workItemId === foreign.id)).toBe(false)
    // ugyanannyi, mint amennyit a Munkapad csikja mutat ugyanerre a projektre
    expect(ov.facts.pendingApprovals).toBe(buildWorkbenchOverview(p.id).approvals.count)

    const facts = summaryFacts(ov.project, ov, 'en')
    expect(facts).toContain('- "Ajanlat" (status review')
    expect(facts).toContain('- work item "Ajanlat" (requested')
    expect(facts).toMatch(/Counts \(kanban cards and Workbench work items together\): open 1, .*pending approval requests 2, done 0/)
  })

  // The strip also takes a request that names its card only in the text, or by
  // the short id. Two copies of the rule drifted exactly there.
  it('a kartyat csak a szovegeben megnevezo keres is szamit -- ugyanugy, mint a Munkapad csikjan', () => {
    const p = mustProject('Tozsde')
    createKanbanCard({ id: 'abcd1234-0000-4000-8000-000000000001', title: 'Hosszu azonosito', project: p.id, status: 'waiting' })
    createKanbanCard({ id: 'beef5678', title: 'Csak a szovegben', project: p.id, status: 'waiting' })
    createApproval({ id: 'short', agent_id: 'fo', category: 'kanban_done', action_description: 'Kesz?', action_payload: JSON.stringify({ kanban_card_id: 'abcd1234' }) })
    createApproval({ id: 'text', agent_id: 'fo', category: 'kanban_done', action_description: 'Kartya #2 (kanban-azonosito: beef5678) kesz', action_payload: null })
    createApproval({ id: 'stranger', agent_id: 'fo', category: 'kanban_done', action_description: 'Kartya (kanban-azonosito: 00000000) kesz', action_payload: null })

    const ov = buildProjectOverview(p.id)!
    expect(ov.approvals.map((a) => [a.id, a.cardTitle]).sort()).toEqual([['short', 'Hosszu azonosito'], ['text', 'Csak a szovegben']])
    expect(ov.facts.pendingApprovals).toBe(2)
    expect(ov.facts.pendingApprovals).toBe(buildWorkbenchOverview(p.id).approvals.count)
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

// The page itself: the server can count a finished item all it likes, the owner
// sees the tile. Drawn with the real functions cut out of web/app.js.
describe('a felulet rajzolja is, amit a szerver megszamolt', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
  const cut = (name: string): string => {
    const start = app.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`nincs ilyen fuggveny: ${name}`)
    return app.slice(start, app.indexOf('\n}\n', start) + 3)
  }
  const load = (names: string[], want: string): ((...a: unknown[]) => string) => {
    const stubs = `
      const escapeHtml = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      const escapeAttr = escapeHtml;
      const t = (k, p) => k + (p ? JSON.stringify(p) : '');
      const _prjAgo = () => 'most';
      const _prjEmptyLine = (k) => '<p>' + k + '</p>';`
    // eslint-disable-next-line no-new-func
    return new Function(`${stubs}\n${names.map(cut).join('\n')}\nreturn ${want}`)() as (...a: unknown[]) => string
  }

  it('van "kesz" csempe, es a szerver szamat mutatja', () => {
    const facts = load(['_prjFactsHtml'], '_prjFactsHtml')
    const html = facts({ facts: { openCards: 0, inProgress: 0, waiting: 0, pendingApprovals: 0, done: 3, overdue: 0, staleOpenCards: 0 } })
    expect(html).toMatch(/<span class="prj-fact-n">3<\/span><span class="prj-fact-l">projects\.fact\.done<\/span>/)
    expect(html).toContain('projects.fact.done_hint')
    // the pending-approval tile duplicated the waiting tile (Boss TG 2222); the list below shows the requests
    expect(html).not.toContain('projects.fact.approvals')
  })

  it('a munkadarab jovahagyasi kerese a munkadarabra mutat, nem ures kartya-linkre', () => {
    const approvals = load(['_prjCardLink', '_prjWorkLink', '_prjApprovalsHtml'], '_prjApprovalsHtml')
    const ov = {
      project: { id: 'p1', name: 'Tozsde' },
      approvals: [
        { id: 'a1', cardId: null, cardTitle: '', workItemId: 'w1', workItemSeq: 13, workItemTitle: 'BB szignal', description: '', agentId: 'fo', requestedAt: 1 },
        { id: 'a2', cardId: 'c1', cardTitle: 'Kartya', workItemId: null, workItemSeq: null, workItemTitle: null, description: '', agentId: 'fo', requestedAt: 1 },
        { id: 'a3', cardId: null, cardTitle: '', workItemId: null, workItemSeq: null, workItemTitle: null, description: '', agentId: 'fo', requestedAt: 1 },
      ],
    }
    const html = approvals(ov)
    expect(html).toContain('data-work-open="w1" data-work-project="p1" data-work-project-name="Tozsde">13M BB szignal</a>')
    expect(html).toContain('data-prj-card="c1">Kartya</a>')
    expect(html).toContain('projects.approvals.project_level')
    expect(html).not.toContain('data-prj-card="null"')
    expect(html).not.toContain('data-prj-card=""')
  })
})
