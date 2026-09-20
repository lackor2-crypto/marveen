// AI Munkapad (kanban #336, 740b432a) -- 1. fazis: vaz + adatmodell.
//
//   GET  /api/workbench/items?project=<id>  -- egy projekt munkadarabjai
//   POST /api/workbench/items               -- uj munkadarab (+ magatol egy v1 verzio)
//   GET  /api/workbench/items/:id           -- egy munkadarab + a verzioi
//
// A Munkapad NEM uj projekt-fogalom: minden vegpont egy LETEZO projekthez
// kotott (`/api/projects`, #321). Ismeretlen projektre 404 jon, nem ures lista.
//
// Minden hiba `{ error: <kod>, message: <emberi mondat> }` alaku, a `message`
// a keres nyelven (HU/EN) -- gepi kod sosem kerul a kepernyore onmagaban.
import { json, readBody } from '../http-helpers.js'
import { APP_LANG } from '../../config.js'
import { getProject } from '../../projects.js'
import {
  ensureWorkbenchTables, createWorkItem, getWorkItem, listWorkItems, listWorkItemVersions,
  WORK_ITEM_TYPES, WORK_ITEM_STATUSES, TITLE_MAX,
} from '../../workbench.js'
import type { RouteContext } from './types.js'

function uiLang(url: URL): 'hu' | 'en' {
  const v = url.searchParams.get('lang')
  return v === 'en' || v === 'hu' ? v : (APP_LANG === 'en' ? 'en' : 'hu')
}

const MESSAGES: Record<string, { hu: string; en: string }> = {
  project_required: {
    hu: 'Nincs megadva, melyik projekt Munkapadját nyitod meg.',
    en: 'It is not given which project\'s Workbench you are opening.',
  },
  project_not_found: {
    hu: 'Ez a projekt nem található (lehet, hogy közben törölték).',
    en: 'This project was not found (it may have been deleted).',
  },
  not_found: {
    hu: 'Ez a munkadarab nem található (lehet, hogy közben törölték).',
    en: 'This work item was not found (it may have been deleted).',
  },
  bad_json: {
    hu: 'A kérés nem értelmezhető.',
    en: 'The request could not be read.',
  },
  title_required: {
    hu: 'Adj nevet a munkadarabnak (például: „Ajánlat Kovács úrnak”).',
    en: 'Give the work item a name (for example: "Offer for Mr Smith").',
  },
  title_too_long: {
    hu: `A munkadarab neve túl hosszú (legfeljebb ${TITLE_MAX} karakter). A részleteket írd majd a munkadarabba.`,
    en: `The work item name is too long (${TITLE_MAX} characters at most). Put the details inside the work item.`,
  },
  bad_type: {
    hu: 'Ismeretlen munkadarab-fajta. Válassz a felkínált fajták közül.',
    en: 'Unknown work item kind. Pick one of the offered kinds.',
  },
  bad_status: {
    hu: 'Ismeretlen munkadarab-állapot.',
    en: 'Unknown work item state.',
  },
}

function fail(res: RouteContext['res'], status: number, code: string, lang: 'hu' | 'en'): true {
  const m = MESSAGES[code]
  json(res, { error: code, message: m ? m[lang] : code }, status)
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

/** Ki hozta letre. A felulet mogott mindig egy bejelentkezett munkamenet all;
 *  token/federacios hivonal marad a nyers fajta -- semmi beegetett nev. */
function actor(ctx: RouteContext): string | null {
  const a = ctx.auth
  if (!a) return null
  if (a.kind === 'session' && a.user) return a.user
  if (a.kind === 'federation' && a.peer) return a.peer
  if (a.kind === 'device' && a.device) return a.device
  return a.kind
}

export async function tryHandleWorkbench(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (path !== '/api/workbench/items' && !path.startsWith('/api/workbench/items/')) return false
  const lang = uiLang(url)
  ensureWorkbenchTables()

  if (path === '/api/workbench/items' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    json(res, {
      project: { id: project.id, name: project.name, archived: project.archived_at != null },
      items: listWorkItems(project.id),
      types: WORK_ITEM_TYPES,
      statuses: WORK_ITEM_STATUSES,
    })
    return true
  }

  if (path === '/api/workbench/items' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const pid = String(body.project_id ?? '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const r = createWorkItem({
      project_id: project.id,
      type: body.type,
      title: body.title,
      status: body.status,
      source_path: body.source_path,
      prompt: body.prompt,
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 400, r.code, lang)
    json(res, { ok: true, item: r.item, versions: [r.version] }, 201)
    return true
  }

  if (path.startsWith('/api/workbench/items/') && method === 'GET') {
    const raw = path.slice('/api/workbench/items/'.length)
    // Rosszul kodolt url nem dobhat 500-at: ilyenkor egyszeruen nincs ilyen darab.
    let id = raw
    try { id = decodeURIComponent(raw) } catch { id = raw }
    const item = getWorkItem(id)
    if (!item) return fail(res, 404, 'not_found', lang)
    const project = getProject(item.project_id)
    json(res, {
      item,
      versions: listWorkItemVersions(item.id),
      project: project ? { id: project.id, name: project.name, archived: project.archived_at != null } : null,
    })
    return true
  }

  return false
}
