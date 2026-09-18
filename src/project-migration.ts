/**
 * A MEGLEVO ADATOK ATVETELE A PROJEKTEKBE (kanban #321, terv 1.1).
 *
 * Mielott a `projects` tabla megjelent, ket helyen allt mar "projekt" szoveg:
 *
 *   - `kanban_cards.project` -- szabad szoveg (pl. egy agens rovid neve),
 *   - `code_tasks.project`   -- a KOD-HID ALIASA: ez nem projekt-nev, hanem egy
 *                               VS Code munkamenet kulcsa (`code_sessions.project`).
 *
 * A Boss kikotese: NEM szabad vakon feltetelezni, hogy ket kulonbozo ertek
 * ugyanazt jelenti. Ezert ez a modul ket lepesben dolgozik:
 *
 *   1. `planProjectMigration()` -- CSAK OLVAS. Minden meglevo erteket felsorol,
 *      a tenyleges hasznalataval egyutt (hany kartya, milyen cimkek, hany
 *      kodfeladat, melyik mappaban futott, melyik kartyakra hivatkozik), es
 *      mindegyikhez JAVASLATOT tesz -- a bizonyitekkal egyutt. Semmit nem ir.
 *   2. `applyProjectMigration(mapping)` -- a tulajdonos altal JOVAHAGYOTT,
 *      explicit hozzarendelest hajtja vegre, egy tranzakcioban, es naploz
 *      mindent, amit megvaltoztatott (`project_migrations`), igy visszavonhato.
 *
 * Amit SOHA nem csinal:
 *   - nem nyul a `code_tasks.project` / `code_sessions.project` mezohoz: azok a
 *     kod-hid utvonal-kulcsai, atirasuk a futo kodfeladatok iranyitasat torne
 *     el. A kod-hid alias a projekthez egy `project_links` sorral kotodik.
 *   - nem nyul az ures (`NULL`) projektu kartyakhoz: a globalis kanbanban
 *     letrehozott kartya nem kerul magatol projektbe (spec 2. pont).
 *   - nem dob el ismeretlen erteket: ami "kihagyas" jelolest kap, valtozatlan
 *     marad, es kesobb is atveheto.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import {
  ensureProjectTables, hasTable, getProject, createProject, linkObject, unlinkObject,
  projectForObject, slugify, uniqueSlug,
} from './projects.js'

const nowSec = (): number => Math.floor(Date.now() / 1000)

export interface KanbanValueUsage {
  value: string
  cards: number
  liveCards: number
  archivedCards: number
  /** cimkenev -> kartyaszam (a `(nincs)` kulcs a cimke nelkulieket szamolja). */
  labels: Record<string, number>
  statuses: Record<string, number>
  firstAt: number | null
  lastAt: number | null
  /** Par kartya, hogy lassa, mirol van szo (a legfrissebbek elol). */
  sample: { id: string; title: string; status: string; archived: boolean }[]
  /** Ha mar letezik projekt, ami erre az ertekre illik (slug vagy nev). */
  matchingProject: { id: string; name: string } | null
  proposal:
    | { action: 'create'; name: string; slug: string }
    | { action: 'existing'; projectId: string; name: string }
}

export interface CodeAliasUsage {
  alias: string
  tasks: number
  statuses: Record<string, number>
  firstAt: number | null
  lastAt: number | null
  /** Melyik mappaban futottak a feladatai (a `code_tasks.workspace_path`). */
  workspaces: { path: string; host: string | null; tasks: number }[]
  /** Van-e hozza regisztralt VS Code munkamenet, es hol all. */
  session: { workspacePath: string; pinned: boolean } | null
  /** A feladatok kartya-hivatkozasai: a hivatkozott kartya `project` erteke szerint. */
  cardRefs: { total: number; byValue: Record<string, number> }
  /** Mar most is kotve van egy projekthez. */
  linkedProject: { id: string; name: string } | null
  proposal:
    | { action: 'link'; value: string; evidence: 'same_name' | 'card_refs'; refs?: number }
    | { action: 'link_project'; projectId: string; name: string; evidence: 'same_name' }
    | { action: 'skip'; evidence: 'no_evidence' }
  /** A javaslat nem nev-egyezesen alapul -- a tulajdonosnak kulon kell dontenie. */
  needsDecision: boolean
}

export interface MigrationPlan {
  generatedAt: number
  existingProjects: number
  kanban: KanbanValueUsage[]
  /** Az ures projektu kartyak: ezekhez a migracio NEM nyul. */
  unassignedCards: { total: number; live: number; archived: number; labels: Record<string, number> }
  codeAliases: CodeAliasUsage[]
  /** Van-e egyaltalan mit atvenni (a felulet csak ekkor mutatja a panelt). */
  pending: boolean
}

function labelCounts(where: string, params: unknown[]): Record<string, number> {
  const db = getDb()
  if (!hasTable('kanban_card_labels') || !hasTable('labels')) return {}
  const rows = db.prepare(
    `SELECT COALESCE((SELECT GROUP_CONCAT(name, ', ') FROM (SELECT lb.name FROM kanban_card_labels cl JOIN labels lb ON lb.id = cl.label_id WHERE cl.card_id = k.id ORDER BY lb.name)), '') AS labels
       FROM kanban_cards k WHERE ${where}`,
  ).all(...params) as { labels: string }[]
  const out: Record<string, number> = {}
  for (const r of rows) {
    const key = r.labels || '(nincs)'
    out[key] = (out[key] || 0) + 1
  }
  return out
}

/** Egy regi kanban-ertekhez illo, mar letezo projekt (slug vagy pontos nev). */
function projectMatchingValue(value: string): { id: string; name: string } | null {
  const db = getDb()
  const bySlug = db.prepare('SELECT id, name FROM projects WHERE slug = ? COLLATE NOCASE').get(slugify(value)) as { id: string; name: string } | undefined
  if (bySlug) return bySlug
  const byName = db.prepare('SELECT id, name FROM projects WHERE name = ? COLLATE NOCASE').all(value) as { id: string; name: string }[]
  return byName.length === 1 ? byName[0] : null
}

/**
 * A DRY-RUN: felmeri a meglevo ertekeket, es javaslatot tesz. SEMMIT NEM IR --
 * a `projects` tablat is csak akkor olvassa, ha mar letezik (egy teljesen friss
 * telepitesen sincs itt irasi mellekhatas).
 */
export function planProjectMigration(): MigrationPlan {
  const db = getDb()
  const projectsExist = hasTable('projects')
  const linksExist = hasTable('project_links')
  const knownProjectIds = new Set<string>(
    projectsExist ? (db.prepare('SELECT id FROM projects').all() as { id: string }[]).map((r) => r.id) : [],
  )

  const kanban: KanbanValueUsage[] = []
  let unassigned = { total: 0, live: 0, archived: 0, labels: {} as Record<string, number> }
  if (hasTable('kanban_cards')) {
    const values = db.prepare(
      `SELECT project AS value, COUNT(*) AS cards,
         SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS live,
         MIN(created_at) AS first_at, MAX(updated_at) AS last_at
       FROM kanban_cards WHERE project IS NOT NULL AND TRIM(project) != ''
       GROUP BY project ORDER BY cards DESC`,
    ).all() as { value: string; cards: number; live: number; first_at: number; last_at: number }[]
    for (const v of values) {
      if (knownProjectIds.has(v.value)) continue // mar projekt-id: nincs mit atvenni
      const statuses: Record<string, number> = {}
      for (const s of db.prepare('SELECT status, COUNT(*) n FROM kanban_cards WHERE project = ? GROUP BY status').all(v.value) as { status: string; n: number }[]) {
        statuses[s.status] = s.n
      }
      const sample = (db.prepare(
        'SELECT id, title, status, archived_at FROM kanban_cards WHERE project = ? ORDER BY (archived_at IS NULL) DESC, updated_at DESC LIMIT 5',
      ).all(v.value) as { id: string; title: string; status: string; archived_at: number | null }[])
        .map((c) => ({ id: c.id, title: c.title, status: c.status, archived: c.archived_at != null }))
      const matching = projectsExist ? projectMatchingValue(v.value) : null
      kanban.push({
        value: v.value,
        cards: v.cards,
        liveCards: v.live,
        archivedCards: v.cards - v.live,
        labels: labelCounts('k.project = ?', [v.value]),
        statuses,
        firstAt: v.first_at ?? null,
        lastAt: v.last_at ?? null,
        sample,
        matchingProject: matching,
        proposal: matching
          ? { action: 'existing', projectId: matching.id, name: matching.name }
          : { action: 'create', name: v.value, slug: slugify(v.value) },
      })
    }
    const u = db.prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) live
       FROM kanban_cards WHERE project IS NULL OR TRIM(project) = ''`,
    ).get() as { total: number; live: number | null }
    unassigned = {
      total: u.total,
      live: u.live ?? 0,
      archived: u.total - (u.live ?? 0),
      labels: labelCounts("k.project IS NULL OR TRIM(k.project) = ''", []),
    }
  }

  const codeAliases: CodeAliasUsage[] = []
  if (hasTable('code_tasks')) {
    const aliases = db.prepare(
      `SELECT project AS alias, COUNT(*) AS tasks, MIN(created_at) AS first_at, MAX(created_at) AS last_at
       FROM code_tasks WHERE project IS NOT NULL AND TRIM(project) != '' GROUP BY project ORDER BY tasks DESC`,
    ).all() as { alias: string; tasks: number; first_at: number; last_at: number }[]
    const kanbanValues = new Set(kanban.map((k) => k.value.toLowerCase()))
    for (const a of aliases) {
      const statuses: Record<string, number> = {}
      for (const s of db.prepare('SELECT status, COUNT(*) n FROM code_tasks WHERE project = ? GROUP BY status').all(a.alias) as { status: string; n: number }[]) {
        statuses[s.status] = s.n
      }
      const workspaces = (db.prepare(
        'SELECT workspace_path AS path, host, COUNT(*) AS tasks FROM code_tasks WHERE project = ? GROUP BY workspace_path, host ORDER BY tasks DESC',
      ).all(a.alias) as { path: string | null; host: string | null; tasks: number }[])
        .map((w) => ({ path: w.path ?? '', host: w.host, tasks: w.tasks }))
      let session: CodeAliasUsage['session'] = null
      if (hasTable('code_sessions')) {
        const s = db.prepare('SELECT workspace_path, pinned FROM code_sessions WHERE project = ?').get(a.alias) as { workspace_path: string; pinned: number } | undefined
        if (s) session = { workspacePath: s.workspace_path, pinned: !!s.pinned }
      }
      const byValue: Record<string, number> = {}
      let refTotal = 0
      if (hasTable('kanban_cards')) {
        const refs = db.prepare(
          `SELECT COALESCE(NULLIF(TRIM(k.project), ''), '(nincs)') AS value, COUNT(*) n
             FROM code_tasks t JOIN kanban_cards k ON k.id = t.card_ref
            WHERE t.project = ? AND t.card_ref IS NOT NULL GROUP BY value`,
        ).all(a.alias) as { value: string; n: number }[]
        for (const r of refs) { byValue[r.value] = r.n; refTotal += r.n }
      }
      const linked = linksExist ? (() => {
        const pid = projectForObject('code_alias', a.alias)
        const p = pid ? getProject(pid) : undefined
        return p ? { id: p.id, name: p.name } : null
      })() : null

      // JAVASLAT, bizonyitekkal. Harom fokozat:
      //  1. Az alias ugyanaz a nev, mint egy regi kanban-ertek -> ugyanaz a projekt.
      //  2. Van mar ilyen slug-u projekt -> az.
      //  3. A feladatai kartyakra hivatkoznak, es a hivatkozott kartyak (ahol van
      //     projektjuk) egy ertekre mutatnak -> az a javaslat, DE kulon dontest ker.
      //  Kulonben: kihagyas (a kod-hid alias kotetlen marad, semmi nem vesz el).
      let proposal: CodeAliasUsage['proposal'] = { action: 'skip', evidence: 'no_evidence' }
      let needsDecision = false
      const matchingProject = projectsExist ? projectMatchingValue(a.alias) : null
      if (kanbanValues.has(a.alias.toLowerCase())) {
        const value = kanban.find((k) => k.value.toLowerCase() === a.alias.toLowerCase())!.value
        proposal = { action: 'link', value, evidence: 'same_name' }
      } else if (matchingProject) {
        proposal = { action: 'link_project', projectId: matchingProject.id, name: matchingProject.name, evidence: 'same_name' }
      } else {
        const candidates = Object.entries(byValue).filter(([v]) => v !== '(nincs)').sort((x, y) => y[1] - x[1])
        if (candidates.length && kanbanValues.has(candidates[0][0].toLowerCase())) {
          proposal = { action: 'link', value: candidates[0][0], evidence: 'card_refs', refs: candidates[0][1] }
          needsDecision = true
        } else if (a.tasks > 0) {
          needsDecision = true
        }
      }
      codeAliases.push({
        alias: a.alias,
        tasks: a.tasks,
        statuses,
        firstAt: a.first_at ?? null,
        lastAt: a.last_at ?? null,
        workspaces,
        session,
        cardRefs: { total: refTotal, byValue },
        linkedProject: linked,
        proposal,
        needsDecision,
      })
    }
  }

  const unlinkedAliases = codeAliases.filter((a) => !a.linkedProject)
  return {
    generatedAt: nowSec(),
    existingProjects: projectsExist ? (db.prepare('SELECT COUNT(*) n FROM projects').get() as { n: number }).n : 0,
    kanban,
    unassignedCards: unassigned,
    codeAliases,
    pending: kanban.length > 0 || unlinkedAliases.some((a) => a.proposal.action !== 'skip' || a.tasks > 0),
  }
}

// ---- alkalmazas -------------------------------------------------------------

export interface KanbanMappingEntry {
  value: string
  action: 'create' | 'existing' | 'skip'
  /** `create`-nel: az uj projekt neve (kotelezo), slugja (opcionalis). */
  name?: string
  slug?: string
  description?: string | null
  client?: string | null
  /** `existing`-nel: a cel-projekt. */
  projectId?: string
}

export interface CodeAliasMappingEntry {
  alias: string
  action: 'link' | 'skip'
  /** Ugyanahhoz a projekthez, amelyikbe ez a regi kanban-ertek kerul. */
  value?: string
  /** VAGY egy mar letezo projekt. */
  projectId?: string
}

export interface MigrationMapping {
  kanban: KanbanMappingEntry[]
  codeAliases: CodeAliasMappingEntry[]
}

export interface MigrationResult {
  id: string
  createdProjects: { id: string; name: string; slug: string; fromValue: string }[]
  movedCards: { value: string; projectId: string; cards: number }[]
  linkedAliases: { alias: string; projectId: string; previous: string | null }[]
  skippedValues: string[]
  skippedAliases: string[]
}

export type ApplyOutcome = { ok: true; result: MigrationResult } | { ok: false; code: string; detail?: string }

interface MigrationLog {
  created: { id: string; fromValue: string }[]
  moved: { value: string; projectId: string; cardIds: string[] }[]
  aliases: { alias: string; projectId: string; previous: string | null }[]
}

function ensureMigrationTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS project_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      applied_by TEXT,
      mapping TEXT NOT NULL,
      log TEXT NOT NULL,
      reverted_at INTEGER
    )
  `)
}

/**
 * A JOVAHAGYOTT hozzarendeles vegrehajtasa. Minden bejegyzest a MOSTANI
 * allapothoz mer: egy ertek, aminek kozben elfogytak a kartyai, hibat ad, nem
 * csendben semmit. Egy tranzakcio: vagy minden megtortenik, vagy semmi.
 */
export function applyProjectMigration(mapping: MigrationMapping, actor?: string | null): ApplyOutcome {
  ensureProjectTables()
  ensureMigrationTable()
  const db = getDb()
  if (!mapping || !Array.isArray(mapping.kanban) || !Array.isArray(mapping.codeAliases)) {
    return { ok: false, code: 'bad_mapping' }
  }
  const plan = planProjectMigration()
  const planValues = new Map(plan.kanban.map((k) => [k.value, k]))
  const planAliases = new Map(plan.codeAliases.map((a) => [a.alias, a]))

  // Elore ellenorzes, meg iras elott.
  const seenValues = new Set<string>()
  for (const e of mapping.kanban) {
    if (!e || typeof e.value !== 'string') return { ok: false, code: 'bad_mapping' }
    if (seenValues.has(e.value)) return { ok: false, code: 'duplicate_value', detail: e.value }
    seenValues.add(e.value)
    if (!planValues.has(e.value)) return { ok: false, code: 'unknown_value', detail: e.value }
    if (e.action === 'create') {
      if (!String(e.name ?? '').trim()) return { ok: false, code: 'name_required', detail: e.value }
    } else if (e.action === 'existing') {
      const p = e.projectId ? getProject(e.projectId) : undefined
      if (!p || p.id !== e.projectId) return { ok: false, code: 'unknown_project', detail: e.value }
    } else if (e.action !== 'skip') {
      return { ok: false, code: 'bad_action', detail: e.value }
    }
  }
  for (const a of mapping.codeAliases) {
    if (!a || typeof a.alias !== 'string') return { ok: false, code: 'bad_mapping' }
    if (!planAliases.has(a.alias)) return { ok: false, code: 'unknown_alias', detail: a.alias }
    if (a.action === 'link') {
      if (a.value !== undefined) {
        const target = mapping.kanban.find((k) => k.value === a.value)
        if (!target || target.action === 'skip') return { ok: false, code: 'alias_target_skipped', detail: a.alias }
      } else {
        const p = a.projectId ? getProject(a.projectId) : undefined
        if (!p || p.id !== a.projectId) return { ok: false, code: 'unknown_project', detail: a.alias }
      }
    } else if (a.action !== 'skip') {
      return { ok: false, code: 'bad_action', detail: a.alias }
    }
  }

  const id = randomUUID().slice(0, 8)
  const result: MigrationResult = { id, createdProjects: [], movedCards: [], linkedAliases: [], skippedValues: [], skippedAliases: [] }
  const log: MigrationLog = { created: [], moved: [], aliases: [] }
  const valueToProject = new Map<string, string>()

  try {
    db.transaction(() => {
      for (const e of mapping.kanban) {
        if (e.action === 'skip') { result.skippedValues.push(e.value); continue }
        let projectId: string
        if (e.action === 'create') {
          const made = createProject({
            name: e.name,
            slug: e.slug ? e.slug : uniqueSlug(e.value),
            description: e.description ?? null,
            client: e.client ?? null,
          })
          if (!made.ok) throw new Error(`create_failed:${made.code}`)
          projectId = made.project.id
          result.createdProjects.push({ id: projectId, name: made.project.name, slug: made.project.slug, fromValue: e.value })
          log.created.push({ id: projectId, fromValue: e.value })
        } else {
          projectId = e.projectId!
        }
        valueToProject.set(e.value, projectId)
        const cardIds = (db.prepare('SELECT id FROM kanban_cards WHERE project = ?').all(e.value) as { id: string }[]).map((r) => r.id)
        db.prepare('UPDATE kanban_cards SET project = ? WHERE project = ?').run(projectId, e.value)
        result.movedCards.push({ value: e.value, projectId, cards: cardIds.length })
        log.moved.push({ value: e.value, projectId, cardIds })
      }
      for (const a of mapping.codeAliases) {
        if (a.action === 'skip') { result.skippedAliases.push(a.alias); continue }
        const projectId = a.value !== undefined ? valueToProject.get(a.value)! : a.projectId!
        const previous = projectForObject('code_alias', a.alias)
        linkObject(projectId, 'code_alias', a.alias, actor ?? null)
        result.linkedAliases.push({ alias: a.alias, projectId, previous })
        log.aliases.push({ alias: a.alias, projectId, previous })
      }
      db.prepare('INSERT INTO project_migrations (id, applied_at, applied_by, mapping, log) VALUES (?, ?, ?, ?, ?)')
        .run(id, nowSec(), actor ?? null, JSON.stringify(mapping), JSON.stringify(log))
    })()
  } catch (err) {
    return { ok: false, code: 'apply_failed', detail: String((err as Error)?.message || err) }
  }
  return { ok: true, result }
}

export interface MigrationHistoryEntry {
  id: string
  appliedAt: number
  appliedBy: string | null
  revertedAt: number | null
  createdProjects: number
  movedCards: number
  linkedAliases: number
}

export function listProjectMigrations(): MigrationHistoryEntry[] {
  if (!hasTable('project_migrations')) return []
  const rows = getDb().prepare('SELECT * FROM project_migrations ORDER BY applied_at DESC').all() as
    { id: string; applied_at: number; applied_by: string | null; log: string; reverted_at: number | null }[]
  return rows.map((r) => {
    let log: MigrationLog = { created: [], moved: [], aliases: [] }
    try { log = JSON.parse(r.log) as MigrationLog } catch { /* serult naplo: nullak */ }
    return {
      id: r.id,
      appliedAt: r.applied_at,
      appliedBy: r.applied_by,
      revertedAt: r.reverted_at,
      createdProjects: log.created.length,
      movedCards: log.moved.reduce((n, m) => n + m.cardIds.length, 0),
      linkedAliases: log.aliases.length,
    }
  })
}

/**
 * VISSZAVONAS. A naplozott kartyak visszakapjak a regi szoveges erteket --
 * DE csak azok, amik azota is abban a projektben allnak (amit kozben kezzel
 * mashova tettek, azt nem rantjuk vissza). A kod-hid alias kotese visszaall az
 * elozore. A migracio altal letrehozott projekt csak akkor torlodik, ha mar
 * semmi nem tartozik hozza; kulonben megmarad, es ezt a valasz megmondja.
 */
export function revertProjectMigration(id: string): { ok: true; restoredCards: number; removedProjects: number; keptProjects: string[] } | { ok: false; code: string } {
  ensureProjectTables()
  if (!hasTable('project_migrations')) return { ok: false, code: 'not_found' }
  const db = getDb()
  const row = db.prepare('SELECT * FROM project_migrations WHERE id = ?').get(id) as { log: string; reverted_at: number | null } | undefined
  if (!row) return { ok: false, code: 'not_found' }
  if (row.reverted_at) return { ok: false, code: 'already_reverted' }
  let log: MigrationLog
  try { log = JSON.parse(row.log) as MigrationLog } catch { return { ok: false, code: 'bad_log' } }
  let restoredCards = 0
  let removedProjects = 0
  const keptProjects: string[] = []
  db.transaction(() => {
    for (const m of log.moved) {
      const upd = db.prepare('UPDATE kanban_cards SET project = ? WHERE id = ? AND project = ?')
      for (const cid of m.cardIds) restoredCards += upd.run(m.value, cid, m.projectId).changes
    }
    for (const a of log.aliases) {
      if (projectForObject('code_alias', a.alias) !== a.projectId) continue
      if (a.previous) linkObject(a.previous, 'code_alias', a.alias, null)
      else unlinkObject('code_alias', a.alias)
    }
    for (const c of log.created) {
      const cards = hasTable('kanban_cards') ? (db.prepare('SELECT COUNT(*) n FROM kanban_cards WHERE project = ?').get(c.id) as { n: number }).n : 0
      const links = (db.prepare('SELECT COUNT(*) n FROM project_links WHERE project_id = ?').get(c.id) as { n: number }).n
      if (cards === 0 && links === 0) {
        db.prepare('DELETE FROM projects WHERE id = ?').run(c.id)
        removedProjects++
      } else keptProjects.push(c.id)
    }
    db.prepare('UPDATE project_migrations SET reverted_at = ? WHERE id = ?').run(nowSec(), id)
  })()
  return { ok: true, restoredCards, removedProjects, keptProjects }
}

// ---- emberi jelentes ----------------------------------------------------------

function fmtDate(sec: number | null, lang: string): string {
  if (!sec) return '-'
  // A kanban masodpercben, a kod-hid ezredmasodpercben tarol.
  const ms = sec > 1e12 ? sec : sec * 1000
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + (lang === 'hu' ? ' (UTC)' : ' UTC')
}

function counts(o: Record<string, number>, lang: string): string {
  return Object.entries(o).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k === '(nincs)' && lang !== 'hu' ? '(none)' : k} x${n}`).join(', ') || '-'
}

/**
 * A dry-run jelentes szovegkent (markdown). A tulajdonos ezt kapja meg a
 * kartyan / csatornajan, MIELOTT barmi atirodik. `names`: a tulajdonosnak
 * javasolt projektnevek a regi ertekekhez (a kod NEM talal ki nevet -- ha nincs
 * megadva, a javaslat maga a regi ertek).
 */
export function renderMigrationPlanMarkdown(plan: MigrationPlan, lang: 'hu' | 'en' = 'hu', names: Record<string, string> = {}): string {
  const hu = lang === 'hu'
  const L: string[] = []
  L.push(hu ? '## Projekt-migráció -- DRY-RUN (semmi nem íródott át)' : '## Project migration -- DRY RUN (nothing was changed)')
  L.push(hu ? `Mérve: ${fmtDate(plan.generatedAt, lang)}. Meglévő projektek: ${plan.existingProjects}.` : `Measured: ${fmtDate(plan.generatedAt, lang)}. Existing projects: ${plan.existingProjects}.`)
  L.push('')
  L.push(hu ? '### 1. Kanban-kártyák `project` értékei' : '### 1. Kanban card `project` values')
  if (!plan.kanban.length) L.push(hu ? '- Nincs átveendő érték.' : '- Nothing to migrate.')
  for (const k of plan.kanban) {
    const target = k.proposal.action === 'existing'
      ? (hu ? `meglévő projekt: „${k.proposal.name}”` : `existing project: "${k.proposal.name}"`)
      : (hu ? `ÚJ projekt: „${names[k.value] ?? k.proposal.name}” (rövid név: ${slugify(k.value)})` : `NEW project: "${names[k.value] ?? k.proposal.name}" (short name: ${slugify(k.value)})`)
    L.push(`- \`${k.value}\` -- ${k.cards} ${hu ? 'kártya' : 'cards'} (${hu ? 'élő' : 'live'} ${k.liveCards}, ${hu ? 'archivált' : 'archived'} ${k.archivedCards}) -> ${target}`)
    L.push(`  - ${hu ? 'címkék' : 'labels'}: ${counts(k.labels, lang)}`)
    L.push(`  - ${hu ? 'állapotok' : 'statuses'}: ${counts(k.statuses, lang)}`)
    L.push(`  - ${hu ? 'példák' : 'examples'}: ${k.sample.map((s) => `${s.id} „${s.title.slice(0, 60)}”`).join('; ')}`)
  }
  L.push(hu
    ? `- Üres projektű kártya: ${plan.unassignedCards.total} (élő ${plan.unassignedCards.live}, archivált ${plan.unassignedCards.archived}; címkék: ${counts(plan.unassignedCards.labels, lang)}) -- ezekhez a migráció NEM nyúl.`
    : `- Cards without a project: ${plan.unassignedCards.total} (live ${plan.unassignedCards.live}, archived ${plan.unassignedCards.archived}; labels: ${counts(plan.unassignedCards.labels, lang)}) -- the migration does NOT touch these.`)
  L.push('')
  L.push(hu ? '### 2. Kód-híd feladatok (`code_tasks.project` = VS Code munkamenet-alias)' : '### 2. Code bridge tasks (`code_tasks.project` = VS Code session alias)')
  L.push(hu
    ? '- Ez a mező a kód-híd útvonal-kulcsa, ezért NEM íródik át; a projekthez egy kapcsolat (project_links, code_alias) köti.'
    : '- This field is the code bridge routing key, so it is NOT rewritten; a link (project_links, code_alias) ties it to the project.')
  if (!plan.codeAliases.length) L.push(hu ? '- Nincs kód-híd feladat.' : '- No code bridge tasks.')
  for (const a of plan.codeAliases) {
    let prop: string
    if (a.linkedProject) prop = hu ? `már kötve: „${a.linkedProject.name}”` : `already linked: "${a.linkedProject.name}"`
    else if (a.proposal.action === 'link') {
      const tgt = names[a.proposal.value] ?? a.proposal.value
      prop = a.proposal.evidence === 'same_name'
        ? (hu ? `javaslat: ugyanaz a projekt, mint a \`${a.proposal.value}\` kártyáké („${tgt}”) -- azonos név` : `proposal: same project as the \`${a.proposal.value}\` cards ("${tgt}") -- same name`)
        : (hu ? `javaslat: a \`${a.proposal.value}\` projektje („${tgt}”) -- mert ${a.proposal.refs} feladata ilyen kártyára hivatkozik` : `proposal: the \`${a.proposal.value}\` project ("${tgt}") -- ${a.proposal.refs} of its tasks reference such cards`)
    } else if (a.proposal.action === 'link_project') {
      prop = hu ? `javaslat: „${a.proposal.name}” -- azonos rövid név` : `proposal: "${a.proposal.name}" -- same short name`
    } else prop = hu ? 'javaslat: kötetlen marad (nincs bizonyíték)' : 'proposal: stays unlinked (no evidence)'
    L.push(`- \`${a.alias}\` -- ${a.tasks} ${hu ? 'feladat' : 'tasks'} (${fmtDate(a.firstAt, lang)} .. ${fmtDate(a.lastAt, lang)}) -> ${prop}${a.needsDecision ? (hu ? ' **[DÖNTÉS KELL]**' : ' **[DECISION NEEDED]**') : ''}`)
    L.push(`  - ${hu ? 'mappák' : 'folders'}: ${a.workspaces.slice(0, 3).map((w) => `${w.path} x${w.tasks}`).join('; ')}${a.workspaces.length > 3 ? (hu ? ` (+${a.workspaces.length - 3} további)` : ` (+${a.workspaces.length - 3} more)`) : ''}`)
    L.push(`  - ${hu ? 'kártya-hivatkozások' : 'card references'}: ${a.cardRefs.total} (${counts(a.cardRefs.byValue, lang)})`)
    if (a.session) L.push(`  - ${hu ? 'VS Code munkamenet' : 'VS Code session'}: ${a.session.workspacePath}${a.session.pinned ? (hu ? ' (kitűzve)' : ' (pinned)') : ''}`)
  }
  return L.join('\n')
}
