// A regi adatok atvetele a projektekbe (kanban #321, terv 1.1).
//
// A tulajdonos kikotesei, amiket ez a teszt orzi:
//   - a dry-run SEMMIT nem ir at;
//   - a `code_tasks.project` (a kod-hid utvonal-kulcsa) SOSEM irodik at;
//   - az ures projektu kartyakhoz a migracio nem nyul;
//   - ismeretlen / kihagyott ertek nem veszhet el;
//   - ket kulonbozo ertek NEM egyesul magatol: a nem nev-egyezesen alapulo
//     javaslat kulon dontest ker;
//   - az atvetel visszavonhato.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, getKanbanCard, getDb } from '../db.js'
import { resetCodeBridgeTablesForTests, listCodeTasks } from '../web/code-bridge-store.js'
import { createProject, projectForObject, getProject } from '../projects.js'
import {
  planProjectMigration, applyProjectMigration, revertProjectMigration, listProjectMigrations,
  renderMigrationPlanMarkdown,
} from '../project-migration.js'

function addTask(id: string, alias: string, workspace: string, cardRef: string | null, prompt = 'feladat') {
  getDb().prepare(
    `INSERT INTO code_tasks (id, project, prompt, status, origin, workspace_path, card_ref, created_at)
     VALUES (?, ?, ?, 'done', 'dashboard', ?, ?, ?)`,
  ).run(id, alias, prompt, workspace, cardRef, Date.now())
}

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  listCodeTasks() // letrehozza a kod-hid tablait az uj adatbazisban
  // A valos kep kicsiben: egy regi kanban-ertek, ures kartyak, ket alias --
  // az egyik azonos nevu, a masik egy masik mappaban futott.
  createKanbanCard({ id: 'm1', title: 'Marveen kártya 1', project: 'marveen', status: 'done' })
  createKanbanCard({ id: 'm2', title: 'Marveen kártya 2', project: 'marveen', status: 'planned' })
  createKanbanCard({ id: 'n1', title: 'Globális kártya', status: 'planned' })
  addTask('t1', 'marveen', '/repo', 'n1')
  addTask('t2', 'marveen', '/repo/.worktrees/x', null)
  addTask('t3', 'fejlesztes', 'F:/Masik/Mappa', 'm1')
  addTask('t4', 'fejlesztes', 'F:/Masik/Mappa', null, '/clear')
  addTask('t5', 'maganugy', 'F:/Harmadik', null)
})

describe('dry-run', () => {
  it('felmeri az ertekeket, es semmit nem ir', () => {
    const plan = planProjectMigration()
    expect(plan.pending).toBe(true)
    expect(plan.kanban.map((k) => k.value)).toEqual(['marveen'])
    expect(plan.kanban[0]).toMatchObject({ cards: 2, liveCards: 2, proposal: { action: 'create', name: 'marveen', slug: 'marveen' } })
    expect(plan.unassignedCards.total).toBe(1)
    // Semmi nem valtozott.
    expect(getKanbanCard('m1')?.project).toBe('marveen')
    expect(getDb().prepare("SELECT name FROM sqlite_master WHERE name='projects'").get()).toBeUndefined()
  })

  it('az azonos nevu alias ugyanoda kerulne; a masik csak bizonyitekkal, es DONTEST KER', () => {
    const plan = planProjectMigration()
    const byAlias = Object.fromEntries(plan.codeAliases.map((a) => [a.alias, a]))
    expect(byAlias.marveen.proposal).toEqual({ action: 'link', value: 'marveen', evidence: 'same_name' })
    expect(byAlias.marveen.needsDecision).toBe(false)
    expect(byAlias.fejlesztes.proposal).toEqual({ action: 'link', value: 'marveen', evidence: 'card_refs', refs: 1 })
    expect(byAlias.fejlesztes.needsDecision).toBe(true)
    expect(byAlias.fejlesztes.workspaces).toEqual([{ path: 'F:/Masik/Mappa', host: null, tasks: 2 }])
    // Bizonyitek nelkul nincs javaslat -- kotetlen marad.
    expect(byAlias.maganugy.proposal).toEqual({ action: 'skip', evidence: 'no_evidence' })
  })

  it('a jelentes kimondja, hogy a kod-hid mezo nem irodik at, es az ures kartyakhoz nem nyul', () => {
    const md = renderMigrationPlanMarkdown(planProjectMigration(), 'hu', { marveen: 'Marvin fejlesztés' })
    expect(md).toContain('DRY-RUN')
    expect(md).toContain('ÚJ projekt: „Marvin fejlesztés”')
    expect(md).toContain('NEM íródik át')
    expect(md).toContain('ezekhez a migráció NEM nyúl')
    expect(md).toContain('[DÖNTÉS KELL]')
    const en = renderMigrationPlanMarkdown(planProjectMigration(), 'en')
    expect(en).toContain('DRY RUN')
    expect(en).not.toMatch(/[őű]/)
  })
})

describe('alkalmazas', () => {
  it('a jovahagyott hozzarendelest hajtja vegre, a kod-hid mezot nem irja at', () => {
    const out = applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'Marvin fejlesztés' }],
      codeAliases: [
        { alias: 'marveen', action: 'link', value: 'marveen' },
        { alias: 'fejlesztes', action: 'skip' },
        { alias: 'maganugy', action: 'skip' },
      ],
    }, 'teszt')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const [created] = out.result.createdProjects
    expect(created).toMatchObject({ name: 'Marvin fejlesztés', slug: 'marveen', fromValue: 'marveen' })
    expect(getKanbanCard('m1')?.project).toBe(created.id)
    expect(getKanbanCard('m2')?.project).toBe(created.id)
    expect(getKanbanCard('n1')?.project).toBeNull()
    expect(projectForObject('code_alias', 'marveen')).toBe(created.id)
    expect(projectForObject('code_alias', 'fejlesztes')).toBeNull()
    // A kod-hid utvonal-kulcsa erintetlen.
    const aliases = (getDb().prepare('SELECT DISTINCT project FROM code_tasks ORDER BY project').all() as { project: string }[]).map((r) => r.project)
    expect(aliases).toEqual(['fejlesztes', 'maganugy', 'marveen'])
    // Utana nincs mit atvenni a kanbanbol.
    expect(planProjectMigration().kanban).toEqual([])
  })

  it('a kihagyott ertek valtozatlan marad, es kesobb atveheto', () => {
    const out = applyProjectMigration({ kanban: [{ value: 'marveen', action: 'skip' }], codeAliases: [] })
    expect(out.ok).toBe(true)
    expect(getKanbanCard('m1')?.project).toBe('marveen')
    expect(planProjectMigration().kanban.map((k) => k.value)).toEqual(['marveen'])
  })

  it('meglevo projektbe is mehet; a nev-egyezo projektet a terv magatol felajanlja', () => {
    const p = createProject({ name: 'Marvin fejlesztés', slug: 'marveen' })
    if (!p.ok) throw new Error('setup')
    const plan = planProjectMigration()
    expect(plan.kanban[0].proposal).toEqual({ action: 'existing', projectId: p.project.id, name: 'Marvin fejlesztés' })
    const out = applyProjectMigration({ kanban: [{ value: 'marveen', action: 'existing', projectId: p.project.id }], codeAliases: [] })
    expect(out.ok && out.result.createdProjects).toEqual([])
    expect(getKanbanCard('m2')?.project).toBe(p.project.id)
  })

  it('hibas hozzarendelesnel semmi nem irodik', () => {
    expect(applyProjectMigration({ kanban: [{ value: 'nincs-ilyen', action: 'create', name: 'X' }], codeAliases: [] }))
      .toEqual({ ok: false, code: 'unknown_value', detail: 'nincs-ilyen' })
    expect(applyProjectMigration({ kanban: [{ value: 'marveen', action: 'create', name: ' ' }], codeAliases: [] }))
      .toMatchObject({ ok: false, code: 'name_required' })
    expect(applyProjectMigration({ kanban: [{ value: 'marveen', action: 'skip' }], codeAliases: [{ alias: 'marveen', action: 'link', value: 'marveen' }] }))
      .toMatchObject({ ok: false, code: 'alias_target_skipped' })
    expect(getKanbanCard('m1')?.project).toBe('marveen')
  })
})

describe('visszavonas', () => {
  it('a kartyak visszakapjak a regi erteket, a letrehozott ures projekt eltunik', () => {
    const out = applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'Marvin fejlesztés' }],
      codeAliases: [{ alias: 'marveen', action: 'link', value: 'marveen' }],
    })
    if (!out.ok) throw new Error('apply')
    const pid = out.result.createdProjects[0].id
    expect(listProjectMigrations()).toHaveLength(1)
    const rev = revertProjectMigration(out.result.id)
    expect(rev).toEqual({ ok: true, restoredCards: 2, removedProjects: 1, keptProjects: [] })
    expect(getKanbanCard('m1')?.project).toBe('marveen')
    expect(projectForObject('code_alias', 'marveen')).toBeNull()
    expect(getProject(pid)).toBeUndefined()
    expect(revertProjectMigration(out.result.id)).toEqual({ ok: false, code: 'already_reverted' })
  })

  it('amit kozben kezzel mashova tettek, azt nem rantja vissza, es a projekt megmarad', () => {
    const out = applyProjectMigration({ kanban: [{ value: 'marveen', action: 'create', name: 'M' }], codeAliases: [] })
    if (!out.ok) throw new Error('apply')
    const pid = out.result.createdProjects[0].id
    getDb().prepare("UPDATE kanban_cards SET project = 'kezzel' WHERE id = 'm1'").run()
    createKanbanCard({ id: 'uj', title: 'Új kártya a projektben', project: pid })
    const rev = revertProjectMigration(out.result.id)
    expect(rev).toEqual({ ok: true, restoredCards: 1, removedProjects: 0, keptProjects: [pid] })
    expect(getKanbanCard('m1')?.project).toBe('kezzel')
    expect(getKanbanCard('m2')?.project).toBe('marveen')
  })
})
