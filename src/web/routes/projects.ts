// Iroda -> Projektek (kanban #321, c17e3a2d).
//
//   GET    /api/projects                     -- lista (+ archivaltak ?archived=1), statisztikaval
//   POST   /api/projects                     -- uj projekt (+ mappa letrehozasa vagy kivalasztasa)
//   GET    /api/projects/names               -- id -> nev (a kanban ezt irja ki az id helyett)
//   GET    /api/projects/folder-options      -- hova kerulhet a projektmappa (a Raktar alapjan)
//   GET    /api/projects/folder-preview      -- LETREHOZAS ELOTT: pontosan mi jonne letre
//   GET    /api/projects/migration           -- a regi adatok atvetelenek DRY-RUN terve + naplo
//   POST   /api/projects/migration/apply     -- a jovahagyott hozzarendeles vegrehajtasa
//   POST   /api/projects/migration/:id/revert -- egy atvetel visszavonasa
//   POST   /api/projects/migration/classify  -- a projekt nelkuli kartyak besorolasi JAVASLATA a tartalmuk alapjan (hatterben)
//   GET    /api/projects/:id                 -- egy projekt
//   PUT    /api/projects/:id                 -- szerkesztes (+ mappa-csere)
//   POST   /api/projects/:id/archive         -- archivalas / visszahozas
//   GET    /api/projects/:id/delete-preview  -- mit erint a torles
//   DELETE /api/projects/:id?confirm=1       -- torles = CSAK a kapcsolat bontasa
//   GET    /api/projects/:id/overview        -- az Attekintes (csak mert forrasbol)
//   POST   /api/projects/:id/summary         -- AI-osszefoglalo, CSAK kezi keresre (mentve, idoponttal)
//   GET    /api/projects/:id/ideas           -- a projekt otletei + a meg sehova nem tartozok
//   POST   /api/projects/:id/ideas           -- uj otlet, a projekthez kotve
//   POST   /api/projects/:id/links           -- meglevo objektum (otlet) kotese a projekthez
//   DELETE /api/projects/:id/links/:type/:objectId -- a kotes bontasa (az objektum marad)
//   GET    /api/projects/:id/folders         -- a projektmappa almappai (hova keruljon az uj fajl)
//   POST   /api/projects/:id/upload?name=&sub= -- fajl feltoltese a projektmappaba (nyers bajtok)
//   POST   /api/projects/:id/note            -- uj szoveges jegyzet a projektmappaba
//
// Minden hiba `{ error: <kod>, message: <emberi mondat> }` alaku. A felulet a
// kodhoz tartozo, forditott mondatot mutatja (`projects.err.<kod>`), a
// `message` csak tartalek.
import { existsSync, statSync } from 'node:fs'
import { json, readBody, RequestBodyTooLargeError } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { APP_LANG, MAIN_AGENT_ID } from '../../config.js'
import { explorerRoot, resolveLifePath, mkdirLife, mkdirLifePath, toLifeRel } from '../../life-explorer.js'
import { loadLifeConfig, lifeName, safeLifeName } from '../../life-tree.js'
import { writeBlockReason } from '../../git-guard.js'
import {
  ensureProjectTables, listProjects, getProject, createProject, updateProject, setProjectArchived,
  projectDeletePreview, deleteProject, projectNameMap, cleanFolderRel, validateProjectInput, projectNameTaken,
  listProjectIdeas, projectIdeaCandidates, linkObject, unlinkObject, projectForObject, isLinkType, hasTable,
} from '../../projects.js'
import { buildProjectOverview } from '../../project-overview.js'
import { summarizeProject } from '../../project-summary.js'
import {
  projectSubfolders, writeProjectFile, writeProjectNote, projectFileTarget, PROJECT_UPLOAD_MAX_BYTES,
} from '../../project-files.js'
import { createIdea, getDb } from '../../db.js'
import { randomUUID } from 'node:crypto'
import {
  planProjectMigration, applyProjectMigration, listProjectMigrations, revertProjectMigration,
  type MigrationMapping,
} from '../../project-migration.js'
import { classificationStatus, listCardSuggestions, startCardClassification, CONFIDENT } from '../../project-card-classify.js'
import type { RouteContext } from './types.js'
import { resolveCardLabels, applyCardLabels } from '../kanban-labels.js'
import { createAgentMessage } from '../../db.js'
import {
  createStarterCard, isRequestKind, projectRequestMessage, researchObjectId,
} from '../../project-scope.js'
import { agentConfigRoot, listAgentNames } from '../agent-config.js'
import { join as joinPath } from 'node:path'
import { listDebateSessions } from '../../project-context.js'

function uiLang(url: URL): 'hu' | 'en' {
  const v = url.searchParams.get('lang')
  return v === 'en' || v === 'hu' ? v : (APP_LANG === 'en' ? 'en' : 'hu')
}

// Tartalek-mondatok (a felulet a sajat forditasat mutatja, ha ismeri a kodot).
const MESSAGES: Record<string, { hu: string; en: string }> = {
  name_required: { hu: 'Adj nevet a projektnek.', en: 'Give the project a name.' },
  name_taken: { hu: 'Már van ilyen nevű projekt. Adj neki más nevet.', en: 'A project with this name already exists. Pick another name.' },
  empty_label_filter: { hu: 'Legalább egy címkét jelölj be, vagy válaszd a „mind” lehetőséget.', en: 'Tick at least one label, or choose "all".' },
  bad_status: { hu: 'Ismeretlen projekt-állapot.', en: 'Unknown project status.' },
  bad_folder: { hu: 'A mappa útvonala nem érvényes.', en: 'The folder path is not valid.' },
  bad_label: { hu: 'Ez a címke nem létezik (lehet, hogy közben törölték).', en: 'This label does not exist (it may have been deleted).' },
  not_found: { hu: 'Ez a projekt nem található (lehet, hogy közben törölték).', en: 'This project was not found (it may have been deleted).' },
  no_depot: { hu: 'Még nincs beállítva a Raktár (hol tárolja a Marveen a fájljaidat). Iroda -> Beállítások -> Raktár beállítások.', en: 'The Depot (where Marveen keeps your files) is not set up yet. Office -> Settings -> Depot settings.' },
  folder_outside: { hu: 'Ez a hely nincs a Raktár mappáján belül.', en: 'This place is not inside the Depot folder.' },
  folder_missing: { hu: 'Ez a mappa nem létezik. Válaszd az „Új mappa létrehozása” lehetőséget.', en: 'This folder does not exist. Choose "Create a new folder".' },
  folder_exists: { hu: 'Ilyen nevű mappa már van ott. Válaszd a „Meglévő mappa” lehetőséget, vagy adj más nevet.', en: 'A folder with that name already exists there. Choose "Existing folder", or pick another name.' },
  folder_not_dir: { hu: 'Ez nem mappa, hanem fájl.', en: 'This is a file, not a folder.' },
  folder_failed: { hu: 'Nem sikerült létrehozni a mappát.', en: 'Could not create the folder.' },
  confirm_required: { hu: 'A törléshez meg kell erősíteni.', en: 'Deletion needs confirmation.' },
  bad_json: { hu: 'A kérés nem értelmezhető.', en: 'The request could not be read.' },
  bad_mapping: { hu: 'Az átvételi hozzárendelés hiányos.', en: 'The migration mapping is incomplete.' },
  unknown_value: { hu: 'Egy régi érték közben eltűnt -- frissítsd az előnézetet.', en: 'An old value disappeared meanwhile -- refresh the preview.' },
  unknown_alias: { hu: 'Egy kód-híd alias közben eltűnt -- frissítsd az előnézetet.', en: 'A code bridge alias disappeared meanwhile -- refresh the preview.' },
  unknown_project: { hu: 'A kiválasztott projekt nem található.', en: 'The selected project was not found.' },
  alias_target_skipped: { hu: 'Egy kód-híd aliast olyan régi értékhez kötöttél, amit kihagysz.', en: 'A code bridge alias points to an old value you are skipping.' },
  duplicate_value: { hu: 'Egy régi érték kétszer szerepel.', en: 'An old value appears twice.' },
  bad_action: { hu: 'Ismeretlen művelet a hozzárendelésben.', en: 'Unknown action in the mapping.' },
  apply_failed: { hu: 'Az átvétel nem sikerült, semmi nem változott.', en: 'The migration failed; nothing was changed.' },
  already_reverted: { hu: 'Ezt az átvételt már visszavonták.', en: 'This migration was already reverted.' },
  bad_log: { hu: 'Az átvétel naplója sérült, nem vonható vissza automatikusan.', en: 'The migration log is damaged; it cannot be reverted automatically.' },
  history_target_skipped: { hu: 'Egy alias régi feladatait „ugyanoda” küldted, de magát az aliast kihagyod. Válassz nekik célt.', en: 'You sent the old tasks of an alias to "the same place", but you skip the alias itself. Pick a target for them.' },
  card_not_unassigned: { hu: 'Egy kártya közben projektet kapott -- frissítsd a listát.', en: 'A card got a project meanwhile -- refresh the list.' },
  no_projects: { hu: 'Még nincs projekt, amibe a kártyákat sorolni lehetne. Előbb hozz létre egyet (vagy vedd át a régi adatokat).', en: 'There is no project yet to sort the cards into. Create one first (or take over the old data).' },
  nothing_to_do: { hu: 'Nincs projekt nélküli kártya, amit be lehetne sorolni.', en: 'There is no card without a project to sort.' },
  classify_busy: { hu: 'A besorolási javaslat már készül. Várd meg, amíg elkészül.', en: 'The sorting suggestion is already being made. Wait until it is done.' },
  no_ai: { hu: 'Ezen a gépen most nincs elérhető AI: se bejelentkezett Claude-fiók, se helyi modell.', en: 'No AI is available on this machine right now: no signed-in Claude account and no local model.' },
  no_answer: { hu: 'Az AI most nem adott használható választ. Próbáld újra pár perc múlva.', en: 'The AI gave no usable answer now. Try again in a few minutes.' },
  busy: { hu: 'Ehhez a projekthez már készül egy összefoglaló. Várd meg, amíg elkészül.', en: 'A summary for this project is already being made. Wait until it is done.' },
  title_required: { hu: 'Adj címet az ötletnek.', en: 'Give the idea a title.' },
  bad_link: { hu: 'Ez a kapcsolat nem értelmezhető.', en: 'This link could not be read.' },
  idea_missing: { hu: 'Ez az ötlet nem található (lehet, hogy közben törölték).', en: 'This idea was not found (it may have been deleted).' },
  not_linked: { hu: 'Ez az elem nincs ehhez a projekthez kötve.', en: 'This item is not linked to this project.' },
  no_folder: { hu: 'A projektnek még nincs mappája. Szerkesztés -> Mappa.', en: 'The project has no folder yet. Edit -> Folder.' },
  missing: { hu: 'A projekt mappája nem található a Raktárban (lehet, hogy átnevezték vagy áthelyezték).', en: 'The project folder was not found in the Depot (it may have been renamed or moved).' },
  unreachable: { hu: 'A projekt mappáját most nem érem el (a Raktár nem elérhető).', en: 'The project folder cannot be reached now (the Depot is not available).' },
  bad_name: { hu: 'Adj meg egy érvényes fájlnevet.', en: 'Give a valid file name.' },
  repo_inside: { hu: 'Ez a hely egy git-repó belseje, ide nem teszek fájlt.', en: 'This place is inside a git repository; no file is put here.' },
  write_failed: { hu: 'Nem sikerült menteni a fájlt.', en: 'Could not save the file.' },
  starter_label_required: { hu: 'A kezdő kártyához címke kell: válassz alapértelmezett címkét, vagy vedd ki a pipát a „Kezdő kártya” elől.', en: 'The starter card needs a label: pick a default label, or untick "Starter card".' },
  request_text_required: { hu: 'Írd le, miről szóljon.', en: 'Write down what it should be about.' },
  bad_request_kind: { hu: 'Ismeretlen kérés-fajta.', en: 'Unknown request kind.' },
  debate_missing: { hu: 'Ez a vitáztatás nem található.', en: 'This debate was not found.' },
  research_missing: { hu: 'Ez a háttéranyag nem található.', en: 'This background material was not found.' },
  too_large: { hu: 'A fájl túl nagy a feltöltéshez (legfeljebb 50 MB). A nagyobbat húzd be közvetlenül a mappába a Windows Intézőben.', en: 'The file is too large to upload (50 MB at most). Drag a bigger one straight into the folder in Windows Explorer.' },
}

function fail(res: RouteContext['res'], status: number, code: string, lang: 'hu' | 'en', extra: Record<string, unknown> = {}): true {
  const m = MESSAGES[code]
  json(res, { error: code, message: m ? m[lang] : code, ...extra }, status)
  return true
}

async function readJson(req: RouteContext['req']): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(req)).toString('utf-8').trim()
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** A projektmappa lehetseges szulo-helyei: minden felvett szemely `Projektek`
 *  mappaja, minden ceg mappaja, es a Raktar gyokereben egy kozos `Projektek`.
 *  Semmi nincs beegetve: a nevek a sajat eletfa-beallitasbol jonnek. */
function folderParents(lang: 'hu' | 'en'): { rel: string; label: string; kind: 'person' | 'company' | 'shared'; exists: boolean }[] {
  const out: { rel: string; label: string; kind: 'person' | 'company' | 'shared'; exists: boolean }[] = []
  const projectsDir = lifeName('projects')
  const exists = (rel: string): boolean => {
    const abs = resolveLifePath(rel)
    return !!abs && existsSync(abs)
  }
  let cfg: ReturnType<typeof loadLifeConfig> | null = null
  try { cfg = loadLifeConfig() } catch { cfg = null }
  for (const p of cfg?.persons ?? []) {
    const rel = `${safeLifeName(p.name)}/${projectsDir}`
    out.push({ rel, label: `${p.name} / ${projectsDir}`, kind: 'person', exists: exists(rel) })
  }
  for (const c of cfg?.companies ?? []) {
    const rel = `${lifeName('companies')}/${safeLifeName(c.name)}`
    out.push({ rel, label: `${lifeName('companies', lang)} / ${c.name}`, kind: 'company', exists: exists(rel) })
  }
  out.push({ rel: projectsDir, label: projectsDir, kind: 'shared', exists: exists(projectsDir) })
  return out
}

type FolderRequest =
  | { mode: 'none' }
  | { mode: 'existing'; path: string }
  | { mode: 'create'; parent: string; name: string; subfolders: boolean }

function parseFolderRequest(v: unknown): FolderRequest | null {
  if (v === undefined || v === null) return { mode: 'none' }
  if (typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.mode === 'none') return { mode: 'none' }
  if (o.mode === 'existing') return { mode: 'existing', path: String(o.path ?? '') }
  if (o.mode === 'create') return { mode: 'create', parent: String(o.parent ?? ''), name: String(o.name ?? ''), subfolders: o.subfolders !== false }
  return null
}

/** A projekt alapertelmezett almappai -- ugyanaz a ket ag, amit az eletfa a
 *  szemelyes projektek ala tesz (Tudasbazis, Tovabbi anyagok). */
function defaultSubfolders(): string[] {
  return [lifeName('knowledgeBase'), lifeName('moreMaterial')]
}

/** Mit jelent a kert mappa -- IRAS NELKUL. A letrehozas elotti elonezet ez. */
function previewFolder(req: FolderRequest): { ok: true; rel: string | null; exists: boolean; willCreate: string[] } | { ok: false; code: string } {
  if (req.mode === 'none') return { ok: true, rel: null, exists: false, willCreate: [] }
  if (!explorerRoot()) return { ok: false, code: 'no_depot' }
  if (req.mode === 'existing') {
    const rel = cleanFolderRel(req.path)
    if (!rel) return { ok: false, code: 'bad_folder' }
    const abs = resolveLifePath(rel)
    if (!abs) return { ok: false, code: 'folder_outside' }
    if (!existsSync(abs)) return { ok: false, code: 'folder_missing' }
    try { if (!statSync(abs).isDirectory()) return { ok: false, code: 'folder_not_dir' } } catch { return { ok: false, code: 'folder_missing' } }
    return { ok: true, rel, exists: true, willCreate: [] }
  }
  const name = safeLifeName(req.name)
  if (!name || name === '_') return { ok: false, code: 'name_required' }
  const parent = cleanFolderRel(req.parent) ?? ''
  if (req.parent && !parent) return { ok: false, code: 'bad_folder' }
  const rel = parent ? `${parent}/${name}` : name
  const abs = resolveLifePath(rel)
  if (!abs) return { ok: false, code: 'folder_outside' }
  if (existsSync(abs)) return { ok: false, code: 'folder_exists' }
  const willCreate: string[] = []
  // A hianyzo koztes szintek is letrejonnek (pl. a szemely `Projektek` mappaja).
  const parts = rel.split('/')
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    const a = resolveLifePath(acc)
    if (a && !existsSync(a)) willCreate.push(acc)
  }
  if (req.subfolders) for (const s of defaultSubfolders()) willCreate.push(`${rel}/${s}`)
  return { ok: true, rel, exists: false, willCreate }
}

/** A kert mappa letrehozasa / ellenorzese. `rel` = a projektbe irando ut. */
function realizeFolder(req: FolderRequest, lang: 'hu' | 'en'): { ok: true; rel: string | null } | { ok: false; code: string; message?: string } {
  const pre = previewFolder(req)
  if (!pre.ok) return pre
  if (req.mode !== 'create' || !pre.rel) return { ok: true, rel: pre.rel }
  // Git-repo munkapeldanyaba nem teszunk kezzel mappat (git-guard).
  const blocked = writeBlockReason(cleanFolderRel(req.parent) ?? '')
  if (blocked) return { ok: false, code: 'folder_failed', message: blocked }
  const made = mkdirLifePath(pre.rel, lang)
  if (!made.ok) return { ok: false, code: 'folder_failed', message: made.message }
  if (req.subfolders) {
    for (const s of defaultSubfolders()) {
      const sub = mkdirLife(made.rel, s, lang)
      if (!sub.ok && sub.code !== 'exists') logger.warn({ rel: made.rel, sub: s, msg: sub.message }, '[projects] almappa nem jott letre')
    }
  }
  const abs = resolveLifePath(made.rel)
  return { ok: true, rel: abs ? toLifeRel(abs) || made.rel : made.rel }
}

export async function tryHandleProjects(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (path !== '/api/projects' && !path.startsWith('/api/projects/')) return false
  const lang = uiLang(url)
  ensureProjectTables()

  if (path === '/api/projects' && method === 'GET') {
    const includeArchived = url.searchParams.get('archived') === '1'
    // A regi adatok atvetelenek terve kulon vegponton jon (/migration): az
    // minden kartyat bejar, a lista betoltese ne fizesse meg.
    json(res, {
      projects: listProjects({ includeArchived }),
      depot: { configured: !!explorerRoot() },
    })
    return true
  }

  if (path === '/api/projects/names' && method === 'GET') {
    json(res, projectNameMap())
    return true
  }

  if (path === '/api/projects/folder-options' && method === 'GET') {
    const configured = !!explorerRoot()
    json(res, {
      depot: { configured },
      parents: configured ? folderParents(lang) : [],
      subfolders: defaultSubfolders(),
    })
    return true
  }

  if (path === '/api/projects/folder-preview' && method === 'GET') {
    const mode = url.searchParams.get('mode') || 'create'
    const fr = parseFolderRequest(mode === 'existing'
      ? { mode, path: url.searchParams.get('path') ?? '' }
      : mode === 'none' ? { mode } : { mode: 'create', parent: url.searchParams.get('parent') ?? '', name: url.searchParams.get('name') ?? '', subfolders: url.searchParams.get('subfolders') !== '0' })
    if (!fr) return fail(res, 400, 'bad_folder', lang)
    const pre = previewFolder(fr)
    if (!pre.ok) return fail(res, 400, pre.code, lang)
    json(res, pre)
    return true
  }

  // --- regi adatok atvetele ---------------------------------------------------
  if (path === '/api/projects/migration' && method === 'GET') {
    json(res, {
      plan: planProjectMigration(),
      history: listProjectMigrations(),
      classification: { status: classificationStatus(), suggestions: listCardSuggestions(), confident: CONFIDENT },
    })
    return true
  }

  // Egy projekt nelkuli kartya besorolasi javaslata (a kartya-ablak mutatja,
  // egy kattintassal elfogadhato). Nincs javaslat -> suggestion: null.
  if (path === '/api/projects/card-suggestion' && method === 'GET') {
    const cardId = url.searchParams.get('card') || ''
    const hit = listCardSuggestions().find((x) => x.cardId === cardId) ?? null
    json(res, { suggestion: hit, confident: CONFIDENT, status: classificationStatus() })
    return true
  }

  if (path === '/api/projects/migration/classify' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const ids = Array.isArray(body.cardIds) ? body.cardIds.map(String) : null
    const out = startCardClassification(lang, ids)
    if (!out.ok) return fail(res, out.code === 'busy' ? 409 : 400, out.code === 'busy' ? 'classify_busy' : out.code, lang, { status: out.status })
    logger.info({ total: out.status.total }, '[projects] projekt nelkuli kartyak besorolasi javaslata indul')
    json(res, { ok: true, status: out.status }, 202)
    return true
  }

  if (path === '/api/projects/migration/apply' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    if (body.confirm !== true) return fail(res, 400, 'confirm_required', lang)
    const out = applyProjectMigration(body.mapping as MigrationMapping, typeof body.actor === 'string' ? body.actor : 'dashboard')
    if (!out.ok) return fail(res, 400, out.code, lang, { detail: out.detail ?? null })
    logger.info({ id: out.result.id, created: out.result.createdProjects.length, moved: out.result.movedCards }, '[projects] regi adatok atveve')
    json(res, { ok: true, result: out.result })
    return true
  }

  const revertMatch = path.match(/^\/api\/projects\/migration\/([^/]+)\/revert$/)
  if (revertMatch && method === 'POST') {
    const body = await readJson(req)
    if (!body || body.confirm !== true) return fail(res, 400, 'confirm_required', lang)
    const out = revertProjectMigration(decodeURIComponent(revertMatch[1]))
    if (!out.ok) return fail(res, 400, out.code, lang)
    json(res, out)
    return true
  }

  // --- letrehozas ------------------------------------------------------------
  if (path === '/api/projects' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const fr = parseFolderRequest(body.folder)
    if (!fr) return fail(res, 400, 'bad_folder', lang)
    // Eloszor a mezok (mappa nelkul), hogy egy rossz nev ne hagyjon maga utan
    // egy felesleges mappat a lemezen.
    const probe = createProjectDryCheck(body)
    if (probe) return fail(res, 400, probe, lang)
    // Uj projekt = egy kezdo kartya is (Boss 2026-09-19), hacsak a hivo kifejezetten
    // nem keri, hogy ne. A cimke a projekt alapertelmezett cimkeje: ha a tablan
    // kotelezo a cimke es nincs megadva, meg a mappa elott szolunk.
    const wantStarter = body.starter_card !== false
    let starterLabels: string[] = []
    if (wantStarter) {
      const lab = resolveCardLabels(body.default_label_id ? [String(body.default_label_id)] : [])
      if (!lab.ok) return fail(res, 400, 'starter_label_required', lang)
      starterLabels = lab.labelIds
    }
    const folder = realizeFolder(fr, lang)
    if (!folder.ok) return fail(res, 400, folder.code, lang, folder.message ? { message: folder.message } : {})
    const made = createProject({ ...body, folder_path: folder.rel })
    if (!made.ok) return fail(res, 400, made.code, lang)
    let starterCardId: string | null = null
    if (wantStarter) {
      starterCardId = createStarterCard(made.project, lang)
      applyCardLabels(starterCardId, starterLabels)
    }
    json(res, { ok: true, project: made.project, starterCardId })
    return true
  }

  if (tryUnlink(ctx, lang)) return true

  const idMatch = path.match(/^\/api\/projects\/([^/]+)(\/[a-z-]+)?$/)
  if (!idMatch) return false
  const id = decodeURIComponent(idMatch[1])
  const sub = idMatch[2] || ''
  const project = getProject(id)
  if (!project || project.id !== id) return fail(res, 404, 'not_found', lang)

  if (sub === '' && method === 'GET') {
    json(res, { project })
    return true
  }

  if (sub === '' && method === 'PUT') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const patch: Record<string, unknown> = { ...body }
    delete patch.folder
    // A mezok ellenorzese a mappa letrehozasa ELOTT (lasd a POST-ot).
    const probe = validateProjectInput({ ...patch, folder_path: undefined }, true)
    if (!probe.ok) return fail(res, 400, probe.code, lang)
    if (probe.fields.name && projectNameTaken(probe.fields.name, id)) return fail(res, 400, 'name_taken', lang)
    if (body.folder !== undefined) {
      const fr = parseFolderRequest(body.folder)
      if (!fr) return fail(res, 400, 'bad_folder', lang)
      const folder = realizeFolder(fr, lang)
      if (!folder.ok) return fail(res, 400, folder.code, lang, folder.message ? { message: folder.message } : {})
      patch.folder_path = folder.rel
    }
    const out = updateProject(id, patch)
    if (!out.ok) return fail(res, out.code === 'not_found' ? 404 : 400, out.code, lang)
    json(res, { ok: true, project: out.project })
    return true
  }

  if (sub === '/archive' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    setProjectArchived(id, body.archived !== false)
    json(res, { ok: true, project: getProject(id) })
    return true
  }

  if (sub === '/delete-preview' && method === 'GET') {
    json(res, projectDeletePreview(id))
    return true
  }

  if (sub === '' && method === 'DELETE') {
    if (url.searchParams.get('confirm') !== '1') return fail(res, 400, 'confirm_required', lang)
    const out = deleteProject(id)
    logger.info({ id, name: project.name, ...out, by: MAIN_AGENT_ID }, '[projects] projekt torolve (csak a kapcsolat)')
    json(res, out)
    return true
  }

  if (sub === '/overview' && method === 'GET') {
    json(res, buildProjectOverview(id))
    return true
  }

  // --- 2. fazis: osszefoglalo, otletek, fajlok --------------------------------
  if (sub === '/summary' && method === 'POST') {
    const out = await summarizeProject(id, lang)
    if (!out.ok) return fail(res, out.code === 'not_found' ? 404 : out.code === 'busy' ? 409 : 503, out.code, lang)
    logger.info({ id, engine: out.engine, model: out.model }, '[projects] osszefoglalo elkeszult')
    json(res, { ok: true, project: out.project, engine: out.engine, model: out.model })
    return true
  }

  if (sub === '/ideas' && method === 'GET') {
    json(res, { ideas: listProjectIdeas(id), candidates: projectIdeaCandidates() })
    return true
  }

  if (sub === '/ideas' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const title = String(body.title ?? '').trim().slice(0, 300)
    if (!title) return fail(res, 400, 'title_required', lang)
    const description = String(body.description ?? '').trim().slice(0, 20000) || null
    const category = String(body.category ?? '').trim().slice(0, 80) || 'Egyéb'
    const ideaId = randomUUID().slice(0, 8)
    // Egy lepesben: az otlet es a kotese -- ne maradhasson projekt nelkuli otlet
    // egy felbeszakadt keres utan.
    getDb().transaction(() => {
      createIdea({ id: ideaId, title, description, category, status: 'new', source: 'manual', kanban_id: null, impact: null, effort: null })
      linkObject(id, 'idea', ideaId, 'dashboard')
    })()
    json(res, { ok: true, id: ideaId })
    return true
  }

  if (sub === '/links' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const type = body.type
    const objectId = String(body.id ?? '').trim()
    // Kezzel kotheto: otlet, vitaztatas, hatteranyag (`<agens>/<fajl>.md`).
    if (!objectId || !isLinkType(type) || !['idea', 'debate', 'research'].includes(type)) return fail(res, 400, 'bad_link', lang)
    if (type === 'idea' && (!hasTable('idea_box') || !getDb().prepare('SELECT 1 FROM idea_box WHERE id = ?').get(objectId))) return fail(res, 404, 'idea_missing', lang)
    if (type === 'debate' && !debateExists(objectId)) return fail(res, 404, 'debate_missing', lang)
    if (type === 'research' && !researchExists(objectId)) return fail(res, 404, 'research_missing', lang)
    const before = projectForObject(type, objectId)
    linkObject(id, type, objectId, 'dashboard')
    json(res, { ok: true, movedFrom: before && before !== id ? before : null })
    return true
  }

  // Projektbol inditott vitaztatas / hatteranyag-gyujtes: a fo agens vegzi, az
  // uzenet megmondja, hogyan jelolje meg az eredmenyt (src/project-scope.ts).
  if (sub === '/requests' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    if (!isRequestKind(body.kind)) return fail(res, 400, 'bad_request_kind', lang)
    const text = String(body.text ?? '').trim().slice(0, 8000)
    if (!text) return fail(res, 400, 'request_text_required', lang)
    const msg = createAgentMessage('system', MAIN_AGENT_ID, projectRequestMessage(project, body.kind, text, lang))
    logger.info({ id, kind: body.kind, messageId: msg.id }, '[projects] keres a fo agensnek a projektbol')
    json(res, { ok: true, messageId: msg.id, agent: MAIN_AGENT_ID })
    return true
  }

  if (sub === '/folders' && method === 'GET') {
    const t = projectFileTarget(project, '')
    json(res, t.ok
      ? { state: 'ok', path: project.folder_path, subfolders: projectSubfolders(project), maxBytes: PROJECT_UPLOAD_MAX_BYTES }
      : { state: t.code, path: project.folder_path, subfolders: [], maxBytes: PROJECT_UPLOAD_MAX_BYTES })
    return true
  }

  if (sub === '/upload' && method === 'POST') {
    // A tul nagy fajlt meg olvasas elott visszautasitjuk -- igy a bongeszo
    // valaszt kap, nem egy megszakadt kapcsolatot.
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > PROJECT_UPLOAD_MAX_BYTES) return fail(res, 413, 'too_large', lang)
    let data: Buffer
    try {
      data = await readBody(req, { maxBytes: PROJECT_UPLOAD_MAX_BYTES })
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return fail(res, 413, 'too_large', lang)
      throw e
    }
    const out = writeProjectFile(project, url.searchParams.get('sub'), url.searchParams.get('name'), data)
    if (!out.ok) return fail(res, out.code === 'write_failed' ? 500 : 400, out.code, lang, out.message ? { detail: out.message } : {})
    logger.info({ id, rel: out.rel, bytes: out.bytes }, '[projects] fajl feltoltve a projektmappaba')
    json(res, out)
    return true
  }

  if (sub === '/note' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const out = writeProjectNote(project, body.sub, body.name, body.text, body.ext)
    if (!out.ok) return fail(res, out.code === 'write_failed' ? 500 : 400, out.code, lang, out.message ? { detail: out.message } : {})
    json(res, out)
    return true
  }

  return false
}

/** DELETE /api/projects/:id/links/:type/:objectId -- a kotes bontasa. Az objektum
 *  (pl. az otlet) megmarad, csak a projekthez tartozasa szunik meg. */
function tryUnlink(ctx: RouteContext, lang: 'hu' | 'en'): boolean {
  const { res, path, method } = ctx
  const m = path.match(/^\/api\/projects\/([^/]+)\/links\/([a-z_]+)\/([^/]+)$/)
  if (!m || method !== 'DELETE') return false
  const id = decodeURIComponent(m[1])
  const type = m[2]
  const objectId = decodeURIComponent(m[3])
  if (!isLinkType(type)) return fail(res, 400, 'bad_link', lang)
  if (projectForObject(type, objectId) !== id) return fail(res, 404, 'not_linked', lang)
  unlinkObject(type, objectId)
  json(res, { ok: true })
  return true
}

/** Van-e ilyen vitaztatas a naplóban (a kezi koteshez). */
function debateExists(sessionId: string): boolean {
  return listDebateSessions().some((d) => d.id === sessionId)
}

/** Van-e ilyen hatteranyag-fajl (`<agens>/<fajl>.md`) valamelyik agens research/ mappajaban. */
function researchExists(objectId: string): boolean {
  const m = objectId.match(/^([^/]+)\/([A-Za-z0-9._-]+\.md)$/)
  if (!m) return false
  if (![MAIN_AGENT_ID, ...listAgentNames()].includes(m[1])) return false
  if (researchObjectId(m[1], m[2]) !== objectId) return false
  const file = joinPath(agentConfigRoot(m[1]), 'research', m[2])
  return existsSync(file) && statSync(file).isFile()
}

/** A mezok ellenorzese mappa-letrehozas ELOTT (nev kotelezo, allapot, cimke),
 *  hogy egy rossz mezo ne hagyjon maga utan felesleges mappat a lemezen. */
function createProjectDryCheck(body: Record<string, unknown>): string | null {
  const v = validateProjectInput({ ...body, folder_path: undefined }, false)
  if (!v.ok) return v.code
  if (v.fields.name && projectNameTaken(v.fields.name)) return 'name_taken'
  return null
}
