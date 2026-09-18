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
//   GET    /api/projects/:id                 -- egy projekt
//   PUT    /api/projects/:id                 -- szerkesztes (+ mappa-csere)
//   POST   /api/projects/:id/archive         -- archivalas / visszahozas
//   GET    /api/projects/:id/delete-preview  -- mit erint a torles
//   DELETE /api/projects/:id?confirm=1       -- torles = CSAK a kapcsolat bontasa
//   GET    /api/projects/:id/overview        -- az Attekintes (csak mert forrasbol)
//
// Minden hiba `{ error: <kod>, message: <emberi mondat> }` alaku. A felulet a
// kodhoz tartozo, forditott mondatot mutatja (`projects.err.<kod>`), a
// `message` csak tartalek.
import { existsSync, statSync } from 'node:fs'
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { APP_LANG, MAIN_AGENT_ID } from '../../config.js'
import { explorerRoot, resolveLifePath, mkdirLife, mkdirLifePath, toLifeRel } from '../../life-explorer.js'
import { loadLifeConfig, lifeName, safeLifeName } from '../../life-tree.js'
import { writeBlockReason } from '../../git-guard.js'
import {
  ensureProjectTables, listProjects, getProject, createProject, updateProject, setProjectArchived,
  projectDeletePreview, deleteProject, projectNameMap, cleanFolderRel, validateProjectInput, projectNameTaken,
} from '../../projects.js'
import { buildProjectOverview } from '../../project-overview.js'
import {
  planProjectMigration, applyProjectMigration, listProjectMigrations, revertProjectMigration,
  type MigrationMapping,
} from '../../project-migration.js'
import type { RouteContext } from './types.js'

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
    let migrationPending = false
    try { migrationPending = planProjectMigration().pending } catch (err) {
      logger.warn({ err }, '[projects] migracio-terv nem keszult el')
    }
    json(res, {
      projects: listProjects({ includeArchived }),
      depot: { configured: !!explorerRoot() },
      migrationPending,
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
    json(res, { plan: planProjectMigration(), history: listProjectMigrations() })
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
    const folder = realizeFolder(fr, lang)
    if (!folder.ok) return fail(res, 400, folder.code, lang, folder.message ? { message: folder.message } : {})
    const made = createProject({ ...body, folder_path: folder.rel })
    if (!made.ok) return fail(res, 400, made.code, lang)
    json(res, { ok: true, project: made.project })
    return true
  }

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

  return false
}

/** A mezok ellenorzese mappa-letrehozas ELOTT (nev kotelezo, allapot, cimke),
 *  hogy egy rossz mezo ne hagyjon maga utan felesleges mappat a lemezen. */
function createProjectDryCheck(body: Record<string, unknown>): string | null {
  const v = validateProjectInput({ ...body, folder_path: undefined }, false)
  if (!v.ok) return v.code
  if (v.fields.name && projectNameTaken(v.fields.name)) return 'name_taken'
  return null
}
