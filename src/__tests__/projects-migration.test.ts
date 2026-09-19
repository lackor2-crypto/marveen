// A regi adatok atvetele a projektekbe (kanban #321, terv 1.1).
//
// A tulajdonos kikotesei, amiket ez a teszt orzi:
//   - a dry-run SEMMIT nem ir at;
//   - a `code_tasks.project` (a kod-hid utvonal-kulcsa) SOSEM irodik at;
//   - az ures projektu kartyakhoz a migracio magatol nem nyul; csak a
//     KARTYANKENT jovahagyott lista mozdul (a tartalom szerinti javaslatbol --
//     a cimke csak jelzes, nem dontes);
//   - egy alias regi feladatai FELADATONKENT, a tartalmuk szerint sorolhatok:
//     a vezerlo/proba parancsok kotetlenul maradnak, az alias pedig csak a
//     jovobeli feladataival tartozik a sajat projektjehez;
//   - ismeretlen / kihagyott ertek nem veszhet el;
//   - ket kulonbozo ertek NEM egyesul magatol: a nem nev-egyezesen alapulo
//     javaslat kulon dontest ker;
//   - az atvetel visszavonhato.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, getKanbanCard, getDb, createLabel, addLabelToCard } from '../db.js'
import { resetCodeBridgeTablesForTests, listCodeTasks } from '../web/code-bridge-store.js'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, projectForObject, getProject, getObjectLink, linkObject } from '../projects.js'
import { buildProjectOverview } from '../project-overview.js'
import {
  planProjectMigration, applyProjectMigration, revertProjectMigration, listProjectMigrations,
  renderMigrationPlanMarkdown, isControlPrompt,
} from '../project-migration.js'

const WORK = 'Javitsd ki a bejelentkezo oldalt: a jelszo-mezo ures bekuldesnel hibat dob, es a hibauzenet angolul jelenik meg a magyar feluleten.'

function addTask(id: string, alias: string, workspace: string, cardRef: string | null, prompt = WORK, createdAt = Date.now() - 60_000) {
  getDb().prepare(
    `INSERT INTO code_tasks (id, project, prompt, status, origin, workspace_path, card_ref, created_at)
     VALUES (?, ?, ?, 'done', 'dashboard', ?, ?, ?)`,
  ).run(id, alias, prompt, workspace, cardRef, createdAt)
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
    expect(md).toContain('ezekhez a migráció magától NEM nyúl')
    // Az alias regi feladatai tartalom szerint: 1 munka, 1 vezerlo parancs.
    expect(md).toContain('tartalom szerint: 1 munka-feladat, 1 vezérlés/próba ("/clear" x1)')
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

// A tulajdonos nyitott dontesei (kartya-komment 1115) -- barmelyik valaszt
// valasztja, a feluletrol vegrehajthato kell legyen.
describe('a dontesi valtozatok', () => {
  beforeEach(() => {
    createLabel({ id: 'lf', name: 'fejlesztes', color: '#000' })
    createLabel({ id: 'li', name: 'iroda', color: '#000' })
    addLabelToCard('m1', 'lf')
    addLabelToCard('m2', 'li')
    addLabelToCard('n1', 'lf')
    createKanbanCard({ id: 'n2', title: 'Címke nélküli globális', status: 'planned' })
  })

  it('a terv cimke-kombinaciokat ad, hogy a felulet pontosan szamolhasson', () => {
    const plan = planProjectMigration()
    const sets = plan.kanban[0].labelSets.map((x) => ({ ids: x.ids, n: x.cards })).sort((a, b) => a.ids.join().localeCompare(b.ids.join()))
    expect(sets).toEqual([{ ids: ['lf'], n: 1 }, { ids: ['li'], n: 1 }])
    // A projekt nelkuli kartyak KARTYANKENT jonnek (cimkeik csak jelzeskent).
    expect(plan.unassignedCards.cards.map((c) => [c.id, c.labels]).sort()).toEqual([['n1', ['fejlesztes']], ['n2', []]])
  })

  it('1B: csak a kivalasztott cimkeju kartyak mennek at, a tobbi a regi szoveggel marad', () => {
    const out = applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'Marvin fejlesztés', labelFilter: { labelIds: ['lf'] } }],
      codeAliases: [],
    })
    if (!out.ok) throw new Error(out.code)
    const pid = out.result.createdProjects[0].id
    expect(getKanbanCard('m1')?.project).toBe(pid)
    expect(getKanbanCard('m2')?.project).toBe('marveen')
    expect(out.result.movedCards).toEqual([{ value: 'marveen', projectId: pid, cards: 1 }])
    // A maradek kesobb is atveheto.
    expect(planProjectMigration().kanban.map((k) => [k.value, k.cards])).toEqual([['marveen', 1]])
  })

  it('ures cimke-szuro hiba, nem csendes semmi', () => {
    expect(applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'X', labelFilter: { labelIds: [] } }], codeAliases: [],
    })).toMatchObject({ ok: false, code: 'empty_label_filter' })
    expect(getKanbanCard('m1')?.project).toBe('marveen')
  })

  it('2B: egy alias kulon, uj projektet kaphat', () => {
    const out = applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'Marvin fejlesztés' }],
      codeAliases: [{ alias: 'fejlesztes', action: 'create', name: 'Tőzsde fejlesztés' }],
    })
    if (!out.ok) throw new Error(out.code)
    const alias = out.result.createdProjects.find((c) => c.fromValue === 'alias:fejlesztes')!
    expect(alias.name).toBe('Tőzsde fejlesztés')
    expect(projectForObject('code_alias', 'fejlesztes')).toBe(alias.id)
    // Visszavonaskor az aliasnak letrehozott, ures projekt is eltunik.
    const rev = revertProjectMigration(out.result.id)
    expect(rev).toMatchObject({ ok: true, removedProjects: 2 })
    expect(projectForObject('code_alias', 'fejlesztes')).toBeNull()
  })

  it('azonos nevu projekt nem johet letre ketszer', () => {
    createProject({ name: 'Marvin fejlesztés' })
    expect(applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'marvin FEJLESZTÉS' }], codeAliases: [],
    })).toMatchObject({ ok: false, code: 'name_taken' })
    expect(applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'Új' }],
      codeAliases: [{ alias: 'fejlesztes', action: 'create', name: 'új' }],
    })).toMatchObject({ ok: false, code: 'name_taken' })
    expect(getKanbanCard('m1')?.project).toBe('marveen')
  })

  it('4: a projekt nelkuli kartyak KARTYANKENT (a tartalom szerinti, jovahagyott lista); visszavonhato', () => {
    const out = applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'Marvin fejlesztés' }],
      codeAliases: [],
      cards: [{ cardId: 'n2', value: 'marveen' }],
    })
    if (!out.ok) throw new Error(out.code)
    const pid = out.result.createdProjects[0].id
    // A cimke nem szamit: a CIMKE NELKULI n2 megy, a "fejlesztes" cimkeju n1 marad.
    expect(getKanbanCard('n2')?.project).toBe(pid)
    expect(getKanbanCard('n1')?.project).toBeNull()
    expect(out.result.movedCards).toContainEqual({ value: null, projectId: pid, cards: 1 })
    const rev = revertProjectMigration(out.result.id)
    expect(rev).toMatchObject({ ok: true, restoredCards: 3 })
    expect(getKanbanCard('n2')?.project).toBeNull()
    expect(getKanbanCard('m1')?.project).toBe('marveen')
  })

  it('4: kihagyott celra, projektet kozben kapott kartyara, vagy a regi cimke-szerinti alakkal nem mehet', () => {
    expect(applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'skip' }], codeAliases: [],
      cards: [{ cardId: 'n1', value: 'marveen' }],
    })).toMatchObject({ ok: false, code: 'alias_target_skipped' })
    expect(applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'M' }], codeAliases: [],
      cards: [{ cardId: 'm1', value: 'marveen' }],
    })).toMatchObject({ ok: false, code: 'card_not_unassigned', detail: 'm1' })
    expect(applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'M' }], codeAliases: [],
      unassigned: { labelIds: ['lf'], value: 'marveen' },
    } as never)).toMatchObject({ ok: false, code: 'bad_mapping', detail: 'unassigned' })
    expect(getKanbanCard('n1')?.project).toBeNull()
    expect(getKanbanCard('m1')?.project).toBe('marveen')
  })
})

// Boss dontese (kartya-komment 1118, 2. pont): a `fejlesztes` alias regi
// feladatai FELADATONKENT, a tartalmuk szerint; a vezerles/proba kotetlen; az
// alias maga egy uj projektbe (a sajat mappajaval), a JOVOBELI munkaval.
describe('alias regi feladatai tartalom szerint', () => {
  it('a vezerlo/proba parancsot a szovegebol ismeri fel', () => {
    for (const p of ['/clear', '/compact', 'hi', 'hello', 'proba. ellenorzes. atmegy e a iras a vscode ra.', 'folytathatod a munkat.', 'folytasd a felbehagyott munkadat!', '']) {
      expect(isControlPrompt(p), p).toBe(true)
    }
    for (const p of [WORK, 'Folytasd: kanban #321 (c17e3a2d). Az előző futásod session-limitbe futott, a saját worktree-dből folytasd a 2. fázist.']) {
      expect(isControlPrompt(p), p).toBe(false)
    }
  })

  it('a regi munka egyenkent a tartalma szerinti projektbe, a vezerles kotetlen, az alias csak a jovoben', () => {
    const plan = planProjectMigration()
    const fej = plan.codeAliases.find((a) => a.alias === 'fejlesztes')!
    expect(fej.history).toMatchObject({ total: 2, work: 1, alreadyLinked: 0 })
    expect(fej.history.control.map((c) => c.id)).toEqual(['t4'])

    const out = applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'Marvin fejlesztés' }],
      codeAliases: [
        { alias: 'marveen', action: 'link', value: 'marveen' },
        { alias: 'fejlesztes', action: 'create', name: 'Tőzsde fejlesztés', history: { action: 'link', value: 'marveen' } },
      ],
    })
    if (!out.ok) throw new Error(out.code + ' ' + out.detail)
    const marvin = out.result.createdProjects.find((c) => c.fromValue === 'marveen')!.id
    const tozsde = out.result.createdProjects.find((c) => c.fromValue === 'alias:fejlesztes')!.id
    expect(projectForObject('code_task', 't3')).toBe(marvin)
    expect(projectForObject('code_task', 't4')).toBeNull()
    expect(getObjectLink('code_alias', 'fejlesztes')).toMatchObject({ project_id: tozsde })
    expect(getObjectLink('code_alias', 'fejlesztes')!.since).toBeGreaterThan(0)
    // A `marveen` alias egyszeru kotes: minden feladataval.
    expect(getObjectLink('code_alias', 'marveen')).toMatchObject({ project_id: marvin, since: null })
    expect(out.result.linkedTasks).toEqual([{ alias: 'fejlesztes', projectId: marvin, tasks: 1 }])

    // Az Attekintes ugyanezt latja: a regi munka a Marvinnal, a proba sehol,
    // az alias uj feladata mar a Tozsdenel.
    addTask('t6', 'fejlesztes', 'F:/Masik/Mappa', null, WORK, Date.now() + 5_000)
    const codeOf = (pid: string) => buildProjectOverview(pid)!.activity.filter((a) => a.kind === 'code').map((a) => a.text)
    const marvinCode = buildProjectOverview(marvin)!.activity.filter((a) => a.kind === 'code')
    expect(marvinCode.map((a) => a.actor).sort()).toEqual(['fejlesztes', 'marveen', 'marveen'])
    expect(codeOf(tozsde)).toHaveLength(1)
    expect(buildProjectOverview(tozsde)!.hasDevWork).toBe(true)
    expect([...codeOf(marvin), ...codeOf(tozsde)]).not.toContain('/clear')

    // Visszavonas: a feladat-kotesek es az alias-kotesek is eltunnek.
    const rev = revertProjectMigration(out.result.id)
    expect(rev).toMatchObject({ ok: true, removedProjects: 2 })
    expect(projectForObject('code_task', 't3')).toBeNull()
    expect(projectForObject('code_alias', 'fejlesztes')).toBeNull()
  })

  it('a kifejezetten visszavett vezerlo parancs is atkerul; a mar egyenkent kotott feladathoz nem nyul', () => {
    const other = createProject({ name: 'Masik' })
    if (!other.ok) throw new Error(other.code)
    linkObject(other.project.id, 'code_task', 't3')
    const out = applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'Marvin fejlesztés' }],
      codeAliases: [{ alias: 'fejlesztes', action: 'link', value: 'marveen', history: { action: 'same', includeTaskIds: ['t4'] } }],
    })
    if (!out.ok) throw new Error(out.code)
    const marvin = out.result.createdProjects[0].id
    expect(projectForObject('code_task', 't4')).toBe(marvin)
    expect(projectForObject('code_task', 't3')).toBe(other.project.id)
  })

  it('"ugyanoda" nem mehet, ha maga az alias kimarad', () => {
    expect(applyProjectMigration({
      kanban: [{ value: 'marveen', action: 'create', name: 'M' }],
      codeAliases: [{ alias: 'fejlesztes', action: 'skip', history: { action: 'same' } }],
    })).toMatchObject({ ok: false, code: 'history_target_skipped' })
  })

  it('az aliasnak letrehozott projekt a munkamenet Raktar-beli mappajat kaphatja', () => {
    const depot = mkdtempSync(join(tmpdir(), 'prj-mig-depot-'))
    const saved = process.env.MARVEEN_DEPOT
    process.env.MARVEEN_DEPOT = depot
    try {
      mkdirSync(join(depot, 'Projektek', 'Tozsde', 'Fejlesztes'), { recursive: true })
      addTask('t7', 'tozsde', join(depot, 'Projektek', 'Tozsde', 'Fejlesztes'), null)
      const a = planProjectMigration().codeAliases.find((x) => x.alias === 'tozsde')!
      expect(a.suggestedFolder).toBe('Projektek/Tozsde/Fejlesztes')
      // A Raktaron kivuli mappa nem javaslat.
      expect(planProjectMigration().codeAliases.find((x) => x.alias === 'fejlesztes')!.suggestedFolder).toBeNull()
      const out = applyProjectMigration({
        kanban: [], codeAliases: [{ alias: 'tozsde', action: 'create', name: 'Tőzsde fejlesztés', folderPath: a.suggestedFolder }],
      })
      if (!out.ok) throw new Error(out.code)
      expect(getProject(out.result.createdProjects[0].id)!.folder_path).toBe('Projektek/Tozsde/Fejlesztes')
    } finally {
      if (saved === undefined) delete process.env.MARVEEN_DEPOT
      else process.env.MARVEEN_DEPOT = saved
      rmSync(depot, { recursive: true, force: true })
    }
  })
})
