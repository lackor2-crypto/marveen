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
 *     letrehozott kartya nem kerul magatol projektbe (spec 2. pont). Egyetlen
 *     kivetel a KIFEJEZETT, KARTYANKENTI lista (`mapping.cards`), amit a
 *     tulajdonos a kartyak TARTALMA alapjan hagyott jova (a javaslatot a
 *     `project-card-classify.ts` adja; a cimke csak jelzes, nem dontes).
 *   - egy kod-hid alias regi feladatait nem viszi vakon egy helyre: kerheto,
 *     hogy a regi feladatok FELADATONKENT (`code_task` kotes) keruljenek a
 *     tartalmuk szerinti projektbe, a vezerlo/proba parancsok (`/clear`, `hi`,
 *     ...) kotetlenul maradjanak, az alias pedig CSAK a jovobeli feladatokkal
 *     tartozzon a sajat projektjehez (`since`).
 *   - nem dob el ismeretlen erteket: ami "kihagyas" jelolest kap, valtozatlan
 *     marad, es kesobb is atveheto.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { getDb } from './db.js'
import { explorerRoot, toLifeRel } from './life-explorer.js'
import { toLocalWorkspacePath } from './web/code-bridge-workspace.js'
import {
  ensureProjectTables, hasTable, getProject, createProject, linkObject, unlinkObject,
  projectForObject, getObjectLink, slugify, uniqueSlug, projectIdsByName, projectNameTaken, nameKey,
  cleanFolderRel,
} from './projects.js'

const nowSec = (): number => Math.floor(Date.now() / 1000)

export interface KanbanValueUsage {
  value: string
  cards: number
  liveCards: number
  archivedCards: number
  /** cimkenev -> kartyaszam (a `(nincs)` kulcs a cimke nelkulieket szamolja). */
  labels: Record<string, number>
  /** A cimke-kombinaciok (a cimke-szurt atvetel pontos elonezetehez). */
  labelSets: LabelSet[]
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
  /** Mar most is kotve van egy projekthez (`since`: csak az ota inditott feladatai). */
  linkedProject: { id: string; name: string; since: number | null } | null
  /** A regi feladatai TARTALOM szerint: valodi munka vagy csak vezerles/proba. */
  history: AliasHistory
  /** A munkamenet mappaja a Raktarban (Raktar-relativ, letezo mappa), ha ott
   *  van -- egy uj projekt ezt kaphatja mappanak. NULL = nincs a Raktarban. */
  suggestedFolder: string | null
  proposal:
    | { action: 'link'; value: string; evidence: 'same_name' | 'card_refs'; refs?: number }
    | { action: 'link_project'; projectId: string; name: string; evidence: 'same_name' }
    | { action: 'skip'; evidence: 'no_evidence' }
  /** A javaslat nem nev-egyezesen alapul -- a tulajdonosnak kulon kell dontenie. */
  needsDecision: boolean
}

export interface ControlTask { id: string; prompt: string; createdAt: number; status: string }

export interface AliasHistory {
  total: number
  /** Valodi munka-feladat (a szovege alapjan). */
  work: number
  /** Egyenkent mar valahova kotott feladat -- ezekhez az atvetel nem nyul. */
  alreadyLinked: number
  /** A vezerlo/proba parancsok (`/clear`, `hi`, `proba`, "folytasd"...) --
   *  egyenkent, hogy a tulajdonos lassa, es egyet-egyet visszavehessen. */
  control: ControlTask[]
}

export interface UnassignedCard {
  id: string
  seq: number | null
  title: string
  status: string
  archived: boolean
  /** A cimkek NEVE -- csak jelzes a tulajdonosnak, a besorolas nem ebbol dol el. */
  labels: string[]
}

export interface MigrationPlan {
  generatedAt: number
  existingProjects: number
  kanban: KanbanValueUsage[]
  /** Az ures projektu kartyak: ezekhez a migracio magatol NEM nyul; csak a
   *  tulajdonos altal kartyankent jovahagyott lista mozdul (`mapping.cards`). */
  unassignedCards: { total: number; live: number; archived: number; labels: Record<string, number>; cards: UnassignedCard[] }
  codeAliases: CodeAliasUsage[]
  /** Van-e egyaltalan mit atvenni (a felulet csak ekkor mutatja a panelt). */
  pending: boolean
}

/** A kartyak cimke-KOMBINACIOI darabszammal. Ebbol a felulet PONTOSAN ki tudja
 *  szamolni, hany kartya mozdul egy cimke-szuronel (egy kartyanak tobb cimkeje
 *  is lehet, ezert a cimkenkenti darabszam osszege nem jo). Ures `ids` = a
 *  cimke nelkuli kartyak. */
export interface LabelSet { ids: string[]; names: string[]; cards: number }

function labelSets(where: string, params: unknown[]): LabelSet[] {
  const db = getDb()
  if (!hasTable('kanban_card_labels') || !hasTable('labels')) {
    const n = (db.prepare(`SELECT COUNT(*) n FROM kanban_cards k WHERE ${where}`).get(...params) as { n: number }).n
    return n ? [{ ids: [], names: [], cards: n }] : []
  }
  const rows = db.prepare(
    `SELECT COALESCE((SELECT GROUP_CONCAT(id, char(31)) FROM (SELECT lb.id FROM kanban_card_labels cl JOIN labels lb ON lb.id = cl.label_id WHERE cl.card_id = k.id ORDER BY lb.id)), '') AS ids
       FROM kanban_cards k WHERE ${where}`,
  ).all(...params) as { ids: string }[]
  const names = new Map((db.prepare('SELECT id, name FROM labels').all() as { id: string; name: string }[]).map((l) => [l.id, l.name]))
  const byKey = new Map<string, LabelSet>()
  for (const r of rows) {
    const set = byKey.get(r.ids)
    if (set) { set.cards++; continue }
    const ids = r.ids ? r.ids.split('\u001f') : []
    byKey.set(r.ids, { ids, names: ids.map((id) => names.get(id) ?? id), cards: 1 })
  }
  return [...byKey.values()].sort((a, b) => b.cards - a.cards)
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
  const byName = projectIdsByName(value)
  return byName.length === 1 ? (db.prepare('SELECT id, name FROM projects WHERE id = ?').get(byName[0]) as { id: string; name: string }) : null
}

/** A vezerlo/proba szavak (ekezet nelkul, kisbetuvel). */
const CONTROL_WORDS = new Set(['hi', 'hello', 'helo', 'hey', 'szia', 'sziasztok', 'hallo', 'proba', 'teszt', 'test', 'ping', 'ok', 'oke', 'mehet', 'continue', 'resume'])

/**
 * VEZERLES vagy PROBA, nem valodi munka? A kod-hid feladat szovegebol, gepi
 * szaballyal (nincs AI, nincs tipp -- a tulajdonos a listat latja es felulbiralhatja):
 *   - perjeles parancs (`/clear`, `/compact`, `/model opus`),
 *   - nagyon rovid szoveg (legfeljebb 12 jel: `hi`, `hello`, `ok`),
 *   - rovid (legfeljebb 80 jel) szoveg, amiben koszones / proba / "folytasd"
 *     jellegu szo all (`proba. atmegy e...`, `folytathatod a munkat.`).
 * Egy valodi feladat ennel hosszabb, es a munkat irja le.
 */
export function isControlPrompt(prompt: unknown): boolean {
  const p = String(prompt ?? '').trim()
  if (!p) return true
  // Perjeles parancs (legfeljebb egy rovid argumentummal, egy sorban).
  if (p.startsWith('/') && p.length <= 60 && !p.includes('\n')) return true
  if (p.length <= 12) return true
  if (p.length > 80) return false
  const words = p.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words.some((w) => CONTROL_WORDS.has(w) || w.startsWith('folyta'))
}

/** Egy kod-hid munkamenet mappaja a Raktarban (Raktar-relativ), ha ott van es
 *  letezik. A munkamenet a Windows-oldali utat jelenti (`F:\\...`), ezt a
 *  kod-hid sajat forditojaval visszuk at a helyi utra. */
function depotFolderOf(workspacePath: string | null | undefined): string | null {
  if (!workspacePath || !explorerRoot()) return null
  const local = toLocalWorkspacePath(workspacePath)
  if (!local) return null
  try { if (!existsSync(local) || !statSync(local).isDirectory()) return null } catch { return null }
  const rel = toLifeRel(local)
  return rel ? cleanFolderRel(rel) : null
}

/** Egy alias regi feladatai, a szoveguk szerint szetvalogatva. */
function aliasHistory(alias: string, linksExist: boolean): AliasHistory {
  const rows = getDb().prepare(
    `SELECT t.id, t.prompt, t.created_at, t.status${linksExist
      ? `, EXISTS (SELECT 1 FROM project_links l WHERE l.object_type = 'code_task' AND l.object_id = t.id) AS linked`
      : ', 0 AS linked'}
       FROM code_tasks t WHERE t.project = ? ORDER BY t.created_at ASC`,
  ).all(alias) as { id: string; prompt: string; created_at: number; status: string; linked: number }[]
  const out: AliasHistory = { total: rows.length, work: 0, alreadyLinked: 0, control: [] }
  for (const r of rows) {
    if (r.linked) { out.alreadyLinked++; continue }
    if (isControlPrompt(r.prompt)) {
      out.control.push({ id: r.id, prompt: String(r.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), createdAt: r.created_at, status: r.status })
    } else out.work++
  }
  return out
}

/** A projekt nelkuli kartyak (a legfrissebb elol), cimkeneveikkel. */
function unassignedCardList(): UnassignedCard[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT id, rowid AS seq, title, status, archived_at FROM kanban_cards
      WHERE project IS NULL OR TRIM(project) = '' ORDER BY (archived_at IS NULL) DESC, updated_at DESC`,
  ).all() as { id: string; seq: number | null; title: string; status: string; archived_at: number | null }[]
  const labels = new Map<string, string[]>()
  if (rows.length && hasTable('kanban_card_labels') && hasTable('labels')) {
    for (const r of db.prepare(
      `SELECT cl.card_id, lb.name FROM kanban_card_labels cl JOIN labels lb ON lb.id = cl.label_id
         JOIN kanban_cards k ON k.id = cl.card_id WHERE k.project IS NULL OR TRIM(k.project) = '' ORDER BY lb.name`,
    ).all() as { card_id: string; name: string }[]) {
      const l = labels.get(r.card_id) ?? []
      l.push(r.name)
      labels.set(r.card_id, l)
    }
  }
  return rows.map((r) => ({ id: r.id, seq: r.seq ?? null, title: r.title, status: r.status, archived: r.archived_at != null, labels: labels.get(r.id) ?? [] }))
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
  let unassigned: MigrationPlan['unassignedCards'] = { total: 0, live: 0, archived: 0, labels: {}, cards: [] }
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
        labelSets: labelSets('k.project = ?', [v.value]),
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
      cards: unassignedCardList(),
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
        const link = getObjectLink('code_alias', a.alias)
        const p = link ? getProject(link.project_id) : undefined
        return p ? { id: p.id, name: p.name, since: link!.since ?? null } : null
      })() : null
      const history = aliasHistory(a.alias, linksExist)
      const suggestedFolder = depotFolderOf(session?.workspacePath) ?? depotFolderOf(workspaces[0]?.path)

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
        history,
        suggestedFolder,
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

/**
 * Cimke-szuro egy regi kanban-ERTEK atvetelehez: CSAK azok a kartyak mozdulnak,
 * amiknek van a felsorolt cimkek kozul legalabb egy (`labelIds`), illetve -- ha
 * `unlabeled` -- a cimke nelkuliek. A tobbi kartya VALTOZATLAN marad (a regi
 * szoveggel), es kesobb kulon atveheto. Hianyzo szuro = az ertek minden kartyaja.
 */
export interface LabelFilter { labelIds: string[]; unlabeled?: boolean }

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
  labelFilter?: LabelFilter | null
}

/** Hova: egy regi kanban-ertek projektjebe (`value`) VAGY egy letezo projektbe. */
export interface MappingTarget { value?: string; projectId?: string }

export interface CodeAliasMappingEntry {
  alias: string
  /** Az ALIAS maga hova tartozzon (a `history` nelkul: az osszes feladataval). */
  action: 'link' | 'create' | 'skip'
  /** `link`: ugyanahhoz a projekthez, amelyikbe ez a regi kanban-ertek kerul... */
  value?: string
  /** ...VAGY egy mar letezo projekt. */
  projectId?: string
  /** `create`: kulon, uj projekt ennek az aliasnak (a neve kotelezo)... */
  name?: string
  /** ...es opcionalisan a mappaja a Raktarban (Raktar-relativ). */
  folderPath?: string | null
  /**
   * A regi feladatok KULON, a tartalmuk szerint. Ha meg van adva:
   *   - az alias-kotes CSAK az atvetel utan inditott feladatokra ervenyes,
   *   - a regi, valodi munka-feladatok EGYENKENT kerulnek a `history` celjaba
   *     (`same` = oda, ahova az alias; `link` = a megadott cel; `skip` = sehova),
   *   - a vezerlo/proba parancsok kotetlenul maradnak, kiveve az
   *     `includeTaskIds`-ban kifejezetten visszavetteket.
   */
  history?: (MappingTarget & { action: 'same' | 'link' | 'skip'; includeTaskIds?: string[] }) | null
}

/** Egy projekt nelkuli kartya, amit a tulajdonos a TARTALMA alapjan egy
 *  projektbe sorolt (a javaslat forrasa: `project-card-classify.ts`). */
export interface CardMappingEntry extends MappingTarget { cardId: string }

export interface MigrationMapping {
  kanban: KanbanMappingEntry[]
  codeAliases: CodeAliasMappingEntry[]
  cards?: CardMappingEntry[] | null
}

export interface MigrationResult {
  id: string
  createdProjects: { id: string; name: string; slug: string; fromValue: string }[]
  /** `value` = a regi szoveg, `null` = a projekt nelkuli kartyak. */
  movedCards: { value: string | null; projectId: string; cards: number }[]
  linkedAliases: { alias: string; projectId: string; previous: string | null; since: number | null }[]
  /** Egyenkent kotott regi kodfeladatok, aliasonkent. */
  linkedTasks: { alias: string; projectId: string; tasks: number }[]
  skippedValues: string[]
  skippedAliases: string[]
}

export type ApplyOutcome = { ok: true; result: MigrationResult } | { ok: false; code: string; detail?: string }

interface PrevLink { projectId: string; since: number | null }

interface MigrationLog {
  /** `fromValue`: regi kanban-ertek, vagy `alias:<nev>` az aliasnak letrehozottnal. */
  created: { id: string; fromValue: string }[]
  moved: { value: string | null; projectId: string; cardIds: string[] }[]
  aliases: { alias: string; projectId: string; previous: string | null; previousSince?: number | null; since?: number | null }[]
  /** Az egyenkent kotott kodfeladatok; `previous` = a korabbi egyedi kotes. */
  tasks?: { taskId: string; projectId: string; previous: PrevLink | null }[]
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

function cleanLabelIds(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out = v.map((x) => String(x ?? '').trim()).filter(Boolean)
  return [...new Set(out)]
}

/** A kartyak kivalasztasa: `base` feltetel + opcionalis cimke-szuro. */
function selectCardIds(baseWhere: string, params: unknown[], filter: LabelFilter | null | undefined): string[] {
  const db = getDb()
  if (!filter) {
    return (db.prepare(`SELECT id FROM kanban_cards k WHERE ${baseWhere}`).all(...params) as { id: string }[]).map((r) => r.id)
  }
  const hasLabels = hasTable('kanban_card_labels')
  const conds: string[] = []
  const p: unknown[] = [...params]
  if (filter.labelIds.length && hasLabels) {
    conds.push(`EXISTS (SELECT 1 FROM kanban_card_labels cl WHERE cl.card_id = k.id AND cl.label_id IN (${filter.labelIds.map(() => '?').join(',')}))`)
    p.push(...filter.labelIds)
  }
  if (filter.unlabeled) {
    conds.push(hasLabels ? 'NOT EXISTS (SELECT 1 FROM kanban_card_labels cl WHERE cl.card_id = k.id)' : '1')
  }
  if (!conds.length) return []
  return (db.prepare(`SELECT id FROM kanban_cards k WHERE (${baseWhere}) AND (${conds.join(' OR ')})`).all(...p) as { id: string }[]).map((r) => r.id)
}

function setCardsProject(cardIds: string[], projectId: string): void {
  const upd = getDb().prepare('UPDATE kanban_cards SET project = ? WHERE id = ?')
  for (const id of cardIds) upd.run(projectId, id)
}

/** Egy alias meg egyenkent NEM kotott regi feladatai: a munka-feladatok, es a
 *  kifejezetten visszavett vezerlo/proba parancsok. */
function aliasHistoryTaskIds(alias: string, includeIds: Set<string>): string[] {
  const rows = getDb().prepare(
    `SELECT t.id, t.prompt FROM code_tasks t WHERE t.project = ?
       AND NOT EXISTS (SELECT 1 FROM project_links l WHERE l.object_type = 'code_task' AND l.object_id = t.id)
     ORDER BY t.created_at ASC`,
  ).all(alias) as { id: string; prompt: string }[]
  return rows.filter((r) => !isControlPrompt(r.prompt) || includeIds.has(r.id)).map((r) => r.id)
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
  // A regi, CIMKE szerinti "projekt nelkuli kartyak" lepes megszunt: a
  // besorolas kartyankent, a tartalom alapjan tortenik (`cards`). Egy regi
  // hivo ne kapjon csendes "semmi sem tortent"-et.
  if ((mapping as { unassigned?: unknown }).unassigned) return { ok: false, code: 'bad_mapping', detail: 'unassigned' }
  if (mapping.cards != null && !Array.isArray(mapping.cards)) return { ok: false, code: 'bad_mapping', detail: 'cards' }
  const plan = planProjectMigration()
  const planValues = new Map(plan.kanban.map((k) => [k.value, k]))
  const planAliases = new Map(plan.codeAliases.map((a) => [a.alias, a]))

  // Elore ellenorzes, meg iras elott.
  const seenValues = new Set<string>()
  const newNames = new Set<string>()
  const nameFree = (name: string): boolean => {
    const key = nameKey(name)
    if (newNames.has(key)) return false
    newNames.add(key)
    return !projectNameTaken(name)
  }
  for (const e of mapping.kanban) {
    if (!e || typeof e.value !== 'string') return { ok: false, code: 'bad_mapping' }
    if (seenValues.has(e.value)) return { ok: false, code: 'duplicate_value', detail: e.value }
    seenValues.add(e.value)
    if (!planValues.has(e.value)) return { ok: false, code: 'unknown_value', detail: e.value }
    if (e.action === 'create') {
      if (!String(e.name ?? '').trim()) return { ok: false, code: 'name_required', detail: e.value }
      if (!nameFree(String(e.name))) return { ok: false, code: 'name_taken', detail: String(e.name) }
    } else if (e.action === 'existing') {
      const p = e.projectId ? getProject(e.projectId) : undefined
      if (!p || p.id !== e.projectId) return { ok: false, code: 'unknown_project', detail: e.value }
    } else if (e.action !== 'skip') {
      return { ok: false, code: 'bad_action', detail: e.value }
    }
    if (e.action !== 'skip' && e.labelFilter) {
      const ids = cleanLabelIds(e.labelFilter.labelIds)
      if (!ids || (!ids.length && !e.labelFilter.unlabeled)) return { ok: false, code: 'empty_label_filter', detail: e.value }
      e.labelFilter = { labelIds: ids, unlabeled: !!e.labelFilter.unlabeled }
    }
  }
  const targetOk = (t: MappingTarget, detail: string): ApplyOutcome | null => {
    if (t.value !== undefined) {
      const target = mapping.kanban.find((k) => k.value === t.value)
      if (!target || target.action === 'skip') return { ok: false, code: 'alias_target_skipped', detail }
      return null
    }
    const p = t.projectId ? getProject(t.projectId) : undefined
    if (!p || p.id !== t.projectId) return { ok: false, code: 'unknown_project', detail }
    return null
  }
  const seenAliases = new Set<string>()
  const aliasFolders = new Map<string, string | null>()
  for (const a of mapping.codeAliases) {
    if (!a || typeof a.alias !== 'string') return { ok: false, code: 'bad_mapping' }
    if (seenAliases.has(a.alias)) return { ok: false, code: 'duplicate_value', detail: a.alias }
    seenAliases.add(a.alias)
    if (!planAliases.has(a.alias)) return { ok: false, code: 'unknown_alias', detail: a.alias }
    if (a.action === 'link') {
      const bad = targetOk(a, a.alias)
      if (bad) return bad
    } else if (a.action === 'create') {
      if (!String(a.name ?? '').trim()) return { ok: false, code: 'name_required', detail: a.alias }
      if (!nameFree(String(a.name))) return { ok: false, code: 'name_taken', detail: String(a.name) }
      if (a.folderPath != null && String(a.folderPath).trim() !== '') {
        const rel = cleanFolderRel(a.folderPath)
        if (rel === null) return { ok: false, code: 'bad_folder', detail: a.alias }
        aliasFolders.set(a.alias, rel)
      }
    } else if (a.action !== 'skip') {
      return { ok: false, code: 'bad_action', detail: a.alias }
    }
    const h = a.history
    if (h) {
      if (h.action === 'same') {
        if (a.action === 'skip') return { ok: false, code: 'history_target_skipped', detail: a.alias }
      } else if (h.action === 'link') {
        const bad = targetOk(h, a.alias)
        if (bad) return bad
      } else if (h.action !== 'skip') {
        return { ok: false, code: 'bad_action', detail: a.alias }
      }
      if (h.includeTaskIds != null && !Array.isArray(h.includeTaskIds)) return { ok: false, code: 'bad_mapping', detail: a.alias }
    }
  }
  const cardEntries: CardMappingEntry[] = []
  if (mapping.cards?.length) {
    const seenCards = new Set<string>()
    const isUnassigned = db.prepare("SELECT 1 FROM kanban_cards WHERE id = ? AND (project IS NULL OR TRIM(project) = '')")
    for (const c of mapping.cards) {
      if (!c || typeof c.cardId !== 'string' || !c.cardId) return { ok: false, code: 'bad_mapping', detail: 'cards' }
      if (seenCards.has(c.cardId)) return { ok: false, code: 'duplicate_value', detail: c.cardId }
      seenCards.add(c.cardId)
      // A kartya azota kaphatott projektet (kezzel, a kartyan): akkor nem
      // irjuk felul csendben -- a tulajdonos a friss allapotot lassa.
      if (!isUnassigned.get(c.cardId)) return { ok: false, code: 'card_not_unassigned', detail: c.cardId }
      const bad = targetOk(c, c.cardId)
      if (bad) return bad
      cardEntries.push(c)
    }
  }

  const id = randomUUID().slice(0, 8)
  const result: MigrationResult = { id, createdProjects: [], movedCards: [], linkedAliases: [], linkedTasks: [], skippedValues: [], skippedAliases: [] }
  const log: MigrationLog = { created: [], moved: [], aliases: [], tasks: [] }
  const valueToProject = new Map<string, string>()
  const resolveTarget = (t: MappingTarget): string => (t.value !== undefined ? valueToProject.get(t.value)! : t.projectId!)

  try {
    db.transaction(() => {
      // A `since` az atvetel pillanata: ami ezutan indul az aliason, az az
      // alias projektjehez tartozik; ami elotte, azt egyenkent kotjuk.
      const since = nowSec()
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
        const cardIds = selectCardIds('k.project = ?', [e.value], e.labelFilter)
        setCardsProject(cardIds, projectId)
        result.movedCards.push({ value: e.value, projectId, cards: cardIds.length })
        log.moved.push({ value: e.value, projectId, cardIds })
      }
      for (const a of mapping.codeAliases) {
        let aliasProject: string | null = null
        if (a.action === 'skip') result.skippedAliases.push(a.alias)
        else {
          if (a.action === 'create') {
            const made = createProject({ name: a.name, slug: uniqueSlug(a.name || a.alias), folder_path: aliasFolders.get(a.alias) ?? null })
            if (!made.ok) throw new Error(`create_failed:${made.code}`)
            aliasProject = made.project.id
            result.createdProjects.push({ id: aliasProject, name: made.project.name, slug: made.project.slug, fromValue: `alias:${a.alias}` })
            log.created.push({ id: aliasProject, fromValue: `alias:${a.alias}` })
          } else {
            aliasProject = resolveTarget(a)
          }
          const prev = getObjectLink('code_alias', a.alias)
          const aliasSince = a.history ? since : null
          linkObject(aliasProject, 'code_alias', a.alias, actor ?? null, aliasSince)
          result.linkedAliases.push({ alias: a.alias, projectId: aliasProject, previous: prev?.project_id ?? null, since: aliasSince })
          log.aliases.push({ alias: a.alias, projectId: aliasProject, previous: prev?.project_id ?? null, previousSince: prev?.since ?? null, since: aliasSince })
        }
        const h = a.history
        if (!h || h.action === 'skip') continue
        const histProject = h.action === 'same' ? aliasProject! : resolveTarget(h)
        const taskIds = aliasHistoryTaskIds(a.alias, new Set((h.includeTaskIds ?? []).map(String)))
        for (const taskId of taskIds) {
          linkObject(histProject, 'code_task', taskId, actor ?? null)
          log.tasks!.push({ taskId, projectId: histProject, previous: null })
        }
        result.linkedTasks.push({ alias: a.alias, projectId: histProject, tasks: taskIds.length })
      }
      if (cardEntries.length) {
        const byProject = new Map<string, string[]>()
        for (const c of cardEntries) {
          const pid = resolveTarget(c)
          const l = byProject.get(pid) ?? []
          l.push(c.cardId)
          byProject.set(pid, l)
        }
        for (const [projectId, cardIds] of byProject) {
          setCardsProject(cardIds, projectId)
          result.movedCards.push({ value: null, projectId, cards: cardIds.length })
          log.moved.push({ value: null, projectId, cardIds })
        }
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
  linkedTasks: number
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
      linkedTasks: (log.tasks ?? []).length,
    }
  })
}

/**
 * VISSZAVONAS. A naplozott kartyak visszakapjak a regi szoveges erteket --
 * DE csak azok, amik azota is abban a projektben allnak (amit kozben kezzel
 * mashova tettek, azt nem rantjuk vissza). A kod-hid alias es az egyenkent
 * kotott kodfeladat kotese visszaall az elozore (ha azota sem kotottek at). A
 * migracio altal letrehozott projekt csak akkor torlodik, ha mar semmi nem
 * tartozik hozza; kulonben megmarad, es ezt a valasz megmondja.
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
    // A regi ertek (a projekt nelkuli kartyaknal NULL) CSAK oda kerul vissza,
    // ahol a kartya azota is ebben a projektben all.
    const upd = db.prepare('UPDATE kanban_cards SET project = ? WHERE id = ? AND project = ?')
    for (const m of log.moved) {
      for (const cid of m.cardIds) restoredCards += upd.run(m.value ?? null, cid, m.projectId).changes
    }
    for (const a of log.aliases) {
      if (projectForObject('code_alias', a.alias) !== a.projectId) continue
      if (a.previous) linkObject(a.previous, 'code_alias', a.alias, null, a.previousSince ?? null)
      else unlinkObject('code_alias', a.alias)
    }
    for (const t of log.tasks ?? []) {
      if (projectForObject('code_task', t.taskId) !== t.projectId) continue
      if (t.previous) linkObject(t.previous.projectId, 'code_task', t.taskId, null)
      else unlinkObject('code_task', t.taskId)
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
    ? `- Üres projektű kártya: ${plan.unassignedCards.total} (élő ${plan.unassignedCards.live}, archivált ${plan.unassignedCards.archived}; címkék: ${counts(plan.unassignedCards.labels, lang)}) -- ezekhez a migráció magától NEM nyúl; besorolni csak kártyánként, a tartalmuk alapján jóváhagyva lehet.`
    : `- Cards without a project: ${plan.unassignedCards.total} (live ${plan.unassignedCards.live}, archived ${plan.unassignedCards.archived}; labels: ${counts(plan.unassignedCards.labels, lang)}) -- the migration does NOT touch these on its own; they can only be sorted card by card, approved by their content.`)
  L.push('')
  L.push(hu ? '### 2. Kód-híd feladatok (`code_tasks.project` = VS Code munkamenet-alias)' : '### 2. Code bridge tasks (`code_tasks.project` = VS Code session alias)')
  L.push(hu
    ? '- Ez a mező a kód-híd útvonal-kulcsa, ezért NEM íródik át; a projekthez egy kapcsolat (project_links, code_alias) köti.'
    : '- This field is the code bridge routing key, so it is NOT rewritten; a link (project_links, code_alias) ties it to the project.')
  if (!plan.codeAliases.length) L.push(hu ? '- Nincs kód-híd feladat.' : '- No code bridge tasks.')
  for (const a of plan.codeAliases) {
    let prop: string
    if (a.linkedProject) {
      prop = hu ? `már kötve: „${a.linkedProject.name}”` : `already linked: "${a.linkedProject.name}"`
      if (a.linkedProject.since) prop += hu ? ` (${fmtDate(a.linkedProject.since, lang)} óta)` : ` (since ${fmtDate(a.linkedProject.since, lang)})`
    }
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
    const h = a.history
    if (h.total) {
      const ctl = h.control.map((c) => c.prompt)
      const byText = counts(Object.fromEntries([...new Set(ctl)].map((x) => [`"${x}"`, ctl.filter((y) => y === x).length])), lang)
      L.push(hu
        ? `  - tartalom szerint: ${h.work} munka-feladat, ${h.control.length} vezérlés/próba${h.control.length ? ` (${byText})` : ''}${h.alreadyLinked ? `, ${h.alreadyLinked} már egyenként kötve` : ''}`
        : `  - by content: ${h.work} work tasks, ${h.control.length} control/probe${h.control.length ? ` (${byText})` : ''}${h.alreadyLinked ? `, ${h.alreadyLinked} already linked one by one` : ''}`)
    }
    if (a.suggestedFolder) L.push(`  - ${hu ? 'mappája a Raktárban' : 'its folder in the Depot'}: ${a.suggestedFolder}`)
  }
  return L.join('\n')
}
