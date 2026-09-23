// AI Munkapad (kanban #336, 740b432a) -- 1. fazis: vaz + adatmodell.
//
//   GET  /api/workbench/items?project=<id>  -- egy projekt munkadarabjai
//   POST /api/workbench/items               -- uj munkadarab (+ magatol egy v1 verzio)
//   GET  /api/workbench/items/:id           -- egy munkadarab + a verzioi + a reszei
//
// 3. fazis -- VEGYES (kompozit) munkadarab: egy munkadarab tobb RESZBOL allhat
// (szoveg-blokk es kep egyszerre, pl. Facebook-poszt).
//
//   POST   /api/workbench/items/:id/parts            -- uj resz (szoveg vagy mar
//                                                      meglevo kep utja)
//   POST   /api/workbench/items/:id/parts/image?name= -- kep FELTOLTESE a projekt
//                                                      mappajaba + kep-resz (nyers bajtok)
//   PATCH  /api/workbench/items/:id/parts/:partId    -- szoveg/felirat javitasa
//   POST   /api/workbench/items/:id/parts/:partId/move -- fel/le mozgatas
//   DELETE /api/workbench/items/:id/parts/:partId    -- a resz kivetele (a KEP
//                                                      FAJLJA a mappaban marad)
//
// 7. fazis -- IRODAI DOKUMENTUM (DOCX) elonezete. A bongeszo a .docx-et nem
// mutatja meg; a spec (8., 24.) szerinti konnyu ut a LibreOffice headless
// konverzio EGY PDF-fe, amit utana ugyanaz az elonezet mutat.
//
//   GET  /api/workbench/capabilities        -- mi all rendelkezesre a gepen
//   POST /api/workbench/items/:id/convert   -- PDF keszitese (gyorsitotarazva)
//   GET  /api/workbench/items/:id/converted -- a kesz PDF bajtjai (+ letoltes)
//
// A LibreOffice NEM kotelezo: ha nincs, a Munkapad tovabbra is mukodik (a fajl
// letoltheto, a munkadarab szerkesztheto), csak a beagyazott elonezet marad el
// -- es a felhasznalo megkapja, MI hianyzik es HOGYAN szerezheto be. Magatol
// SEMMIT nem telepitunk: a csomagtelepites a tulajdonos dontese.
//
// A Munkapad NEM uj projekt-fogalom: minden vegpont egy LETEZO projekthez
// kotott (`/api/projects`, #321). Ismeretlen projektre 404 jon, nem ures lista.
//
// Minden hiba `{ error: <kod>, message: <emberi mondat> }` alaku, a `message`
// a keres nyelven (HU/EN) -- gepi kod sosem kerul a kepernyore onmagaban.
import { json, readBody, RequestBodyTooLargeError } from '../http-helpers.js'
import { APP_LANG } from '../../config.js'
import { getProject } from '../../projects.js'
import {
  ensureWorkbenchTables, createWorkItem, getWorkItem, listWorkItems,
  listWorkItemParts, addWorkItemPart, updateWorkItemPart, moveWorkItemPart, removeWorkItemPart,
  createWorkItemVersion, restoreWorkItemVersion, listWorkItemVersionsView,
  WORK_ITEM_TYPES, WORK_ITEM_STATUSES, WORK_ITEM_PART_KINDS, TITLE_MAX, PART_TEXT_MAX, PART_CAPTION_MAX,
} from '../../workbench.js'
import { writeProjectFile, PROJECT_UPLOAD_MAX_BYTES } from '../../project-files.js'
import { buildPreview } from '../../workbench-preview.js'
import {
  convertOfficeToPdf, probeLibreOffice, cachedPdfFor, OFFICE_CONVERTIBLE, officeExt,
} from '../../office-convert.js'
import {
  describeAllCapabilities, describeCapability, getCapability,
} from '../../workbench-capabilities.js'
import { setOverride } from '../../settings-store.js'
import { getSettingDefinition } from '../../config-registry.js'
import { resolveLifePath } from '../../life-explorer.js'
import { createReadStream, statSync } from 'node:fs'
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
  version_not_found: {
    hu: 'Ez a verzió nincs meg. Lehet, hogy közben törölted a munkadarabot, vagy egy régi lapot néztél -- frissítsd az oldalt.',
    en: 'That version does not exist. The work item may have been deleted, or you are looking at a stale page -- reload it.',
  },
  version_mismatch: {
    hu: 'Ez a verzió nem ehhez a munkadarabhoz tartozik, ezért nem állítom vissza.',
    en: 'That version belongs to a different work item, so it will not be restored.',
  },
  preview_no_source: {
    hu: 'Ehhez a munkadarabhoz még nincs megjeleníthető tartalom. Írj bele egy szöveg-részt, vagy tölts fel egy képet -- és itt azonnal látni fogod.',
    en: 'There is nothing to show for this work item yet. Add a text part or upload an image, and it will appear here right away.',
  },
  preview_no_depot: {
    hu: 'Nincs még beállítva, hol tárolja a Marveen a fájlokat, ezért az előnézetet sem tudom megmutatni. Nyisd meg a Raktár oldalt, és válaszd ki a mappát.',
    en: 'There is no storage folder set up for Marveen yet, so the preview cannot be shown. Open the Depot page and pick the folder.',
  },
  preview_no_folder: {
    hu: 'Ehhez a projekthez még nincs mappa kiválasztva, ezért a fájlt nem találom. Válaszd ki a projekt mappáját a projekt adatlapján.',
    en: 'This project has no folder selected yet, so the file cannot be found. Choose the project folder on the project page.',
  },
  preview_missing: {
    hu: 'A fájl neve ismert, de a lemezen nincs ott. Lehet, hogy átnevezték vagy áthelyezték.',
    en: 'The file name is known, but the file is not on disk. It may have been renamed or moved.',
  },
  preview_unreachable: {
    hu: 'Ezt a helyet most nem érem el (lecsatolt meghajtó vagy hálózati mappa). Ez NEM azt jelenti, hogy nincs ott a fájl.',
    en: 'This location cannot be reached right now (an unmounted drive or a network folder). This does NOT mean the file is gone.',
  },
  preview_unsupported: {
    hu: 'Ezt a formátumot a böngésző magától nem mutatja meg. Töltsd le, vagy nyisd meg a saját programoddal.',
    en: 'The browser cannot show this format on its own. Download it, or open it with your own program.',
  },
  preview_too_large: {
    hu: 'Ez a fájl túl nagy ahhoz, hogy itt megmutassam. Töltsd le, és nyisd meg a gépeden.',
    en: 'This file is too large to show here. Download it and open it on your computer.',
  },
  preview_unreadable: {
    hu: 'A fájl ott van, de nem tudtam elolvasni. A pontos hibát a részletek mutatják.',
    en: 'The file is there, but it could not be read. The details show the exact error.',
  },
  project_archived: {
    hu: 'Ez a projekt archiválva van, ezért csak olvasható. Ha dolgozni akarsz benne, előbb állítsd vissza a Projektek oldalon.',
    en: 'This project is archived, so it is read-only. To work in it, restore it first on the Projects page.',
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
  bad_kind: {
    hu: 'Ismeretlen résztípus. Egy rész vagy szöveg, vagy kép.',
    en: 'Unknown part kind. A part is either text or an image.',
  },
  text_required: {
    hu: 'Írj valamit a szöveges részbe (üresen nem tudom hozzáadni).',
    en: 'Write something into the text part (an empty one cannot be added).',
  },
  text_too_long: {
    hu: `Ez a szöveg túl hosszú (legfeljebb ${PART_TEXT_MAX} karakter). Bontsd több szöveges részre.`,
    en: `This text is too long (${PART_TEXT_MAX} characters at most). Split it into several text parts.`,
  },
  asset_required: {
    hu: 'Nincs megadva, melyik kép kerüljön a munkadarabba.',
    en: 'It is not given which image should go into the work item.',
  },
  caption_too_long: {
    hu: `A felirat túl hosszú (legfeljebb ${PART_CAPTION_MAX} karakter).`,
    en: `The caption is too long (${PART_CAPTION_MAX} characters at most).`,
  },
  part_not_found: {
    hu: 'Ez a rész már nincs meg (lehet, hogy közben törölték).',
    en: 'This part is gone (it may have been deleted meanwhile).',
  },
  bad_move: {
    hu: 'Nem értem, merre mozgassam a részt (fel vagy le).',
    en: 'It is unclear which way to move the part (up or down).',
  },
  too_large: {
    hu: `Ez a kép túl nagy (legfeljebb ${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB). Másold be a projekt mappájába, és onnan vedd fel.`,
    en: `This image is too large (${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB at most). Copy it into the project folder and add it from there.`,
  },
  bad_name: {
    hu: 'Ez a fájlnév nem használható. Adj neki egyszerű nevet (például: kep.jpg).',
    en: 'This file name cannot be used. Give it a simple name (for example: photo.jpg).',
  },
  empty_file: {
    hu: 'A feltöltött kép üres volt (nulla bájt). Próbáld újra.',
    en: 'The uploaded image was empty (zero bytes). Try again.',
  },
  no_depot: {
    hu: 'Nincs beállítva Raktár, ezért a kép nem tud hova kerülni. Beállítások → Raktár.',
    en: 'No Depot is configured, so the image has nowhere to go. Settings → Depot.',
  },
  no_folder: {
    hu: 'Ehhez a projekthez nincs mappa, ezért a kép nem tud hova kerülni. Nyisd meg a projektet, és adj neki mappát.',
    en: 'This project has no folder, so the image has nowhere to go. Open the project and give it a folder.',
  },
  missing: {
    hu: 'A projekt mappája nincs meg a lemezen. Nyisd meg a projektet, és nézd meg a mappáját.',
    en: 'The project folder is missing from the disk. Open the project and check its folder.',
  },
  unreachable: {
    hu: 'A projekt mappáját most nem érem el (lehet, hogy a meghajtó nincs csatlakoztatva).',
    en: 'The project folder cannot be reached right now (the drive may be disconnected).',
  },
  bad_folder: {
    hu: 'A megadott almappa nem használható.',
    en: 'The given subfolder cannot be used.',
  },
  repo_inside: {
    hu: 'Ide nem írhatok: a mappa egy git tároló belseje.',
    en: 'I cannot write here: this folder is inside a git repository.',
  },
  write_failed: {
    hu: 'A képet nem sikerült kiírni a projekt mappájába.',
    en: 'The image could not be written into the project folder.',
  },

  // --- 7. fazis: irodai dokumentum -> PDF ---
  preview_needs_conversion: {
    hu: 'Ezt a dokumentumot a böngésző magától nem tudja megmutatni, de tudok belőle PDF-előnézetet készíteni. Kattints az „Előnézet készítése” gombra -- a fájlhoz nem nyúlok hozzá, az eredeti marad.',
    en: 'The browser cannot show this document on its own, but a PDF preview can be made from it. Click "Create preview" -- the file itself is left untouched.',
  },
  convert_unsupported: {
    hu: 'Ebből a fájlból nem tudok PDF-előnézetet készíteni. Töltsd le, és nyisd meg a saját gépeden.',
    en: 'A PDF preview cannot be made from this file. Download it and open it on your own computer.',
  },
  convert_missing_source: {
    hu: 'A dokumentum fájlja nincs meg a lemezen, ezért nincs miből előnézetet készíteni. Nézd meg a projekt mappáját.',
    en: 'The document file is missing from the disk, so there is nothing to build a preview from. Check the project folder.',
  },
  convert_not_installed: {
    hu: 'Az előnézethez a LibreOffice kellene, és az ezen a gépen nincs telepítve. Enélkül minden más működik: a dokumentum letölthető és szerkeszthető, csak itt, beágyazva nem látszik. Ha szeretnéd: Linuxon „sudo apt install libreoffice-writer”, Windowson/macOS-en a libreoffice.org oldaláról telepíthető -- utána nyomj a „Mégegyszer” gombra. Ha máshova telepítetted, add meg az útvonalát a MARVEEN_SOFFICE beállításban.',
    en: 'The preview needs LibreOffice, and it is not installed on this machine. Everything else still works: the document can be downloaded and edited, it just cannot be shown embedded here. If you want it: on Linux "sudo apt install libreoffice-writer", on Windows/macOS from libreoffice.org -- then press "Try again". If you installed it elsewhere, give its path in the MARVEEN_SOFFICE setting.',
  },
  convert_check_failed: {
    hu: 'Nem tudtam megállapítani, van-e LibreOffice ezen a gépen -- tehát ez NEM azt jelenti, hogy nincs. A pontos hibaüzenet a részleteknél olvasható; ha a MARVEEN_SOFFICE beállításban adtál meg útvonalat, ellenőrizd, hogy jó-e.',
    en: 'It could not be determined whether LibreOffice is on this machine -- so this does NOT mean it is missing. The exact error is in the details; if you set a path in MARVEEN_SOFFICE, check that it is correct.',
  },
  convert_timeout: {
    hu: 'Az átalakítás túl sokáig tartott, ezért leállítottam. Nagy vagy sérült dokumentumnál fordul elő. Próbáld újra, vagy nyisd meg a fájlt a saját gépeden.',
    en: 'The conversion took too long, so it was stopped. This happens with very large or damaged documents. Try again, or open the file on your own computer.',
  },
  convert_failed: {
    hu: 'Az átalakítás nem sikerült. A pontos hibaüzenet a részleteknél olvasható -- nem találgatok helyette okot.',
    en: 'The conversion failed. The exact error is in the details -- no cause is guessed in its place.',
  },
  convert_no_output: {
    hu: 'Az átalakító lefutott, de nem keletkezett PDF. Ez általában sérült vagy jelszóval védett dokumentumnál fordul elő.',
    en: 'The converter ran but produced no PDF. This usually happens with a damaged or password-protected document.',
  },
  document_too_large: {
    hu: `Ez a dokumentum túl nagy (legfeljebb ${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB). Másold be a projekt mappájába, és onnan vedd fel.`,
    en: `This document is too large (${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB at most). Copy it into the project folder and add it from there.`,
  },
  convert_not_ready: {
    hu: 'Ennek a dokumentumnak még nincs kész PDF-előnézete. Nyomj az „Előnézet készítése” gombra.',
    en: 'This document has no PDF preview yet. Press "Create preview".',
  },
  capability_unknown: {
    hu: 'Nincs ilyen képesség. A lista a Munkapad „Mi működik ezen a gépen?” paneljén látható.',
    en: 'There is no such capability. The list is on the Workbench "What works on this machine?" panel.',
  },
  capability_no_setting: {
    hu: 'Ehhez a képességhez nem tartozik beállítható érték, így nincs mit menteni.',
    en: 'This capability has no value to set, so there is nothing to save.',
  },
  capability_saved: {
    hu: 'Elmentve, és azonnal újra megmértem.',
    en: 'Saved, and measured again right away.',
  },
}

/** Gepi kod -> EMBERI mondat. Ismeretlen kodnal a kodot adjuk vissza, hogy
 *  soha ne legyen ures a mondat (az ures uzenet rosszabb a nyers kodnal). */
function msg(code: string, lang: 'hu' | 'en'): string {
  const m = MESSAGES[code]
  return m ? m[lang] : code
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
  if (!path.startsWith('/api/workbench/')) return false
  const lang = uiLang(url)
  ensureWorkbenchTables()

  // MI ALL RENDELKEZESRE EZEN A GEPEN (spec 1-2), es ami nem, azzal MI A
  // TEENDO. Friss telepitesen a valasz tobbnyire "nincs meg" -- es az NEM
  // hiba: minden sor megmondja, mire hat, es hogyan szerezheto be. A "nem
  // tudtam megkerdezni" KULON allapot: azt sosem mondjuk "nincs"-nek.
  //
  //   GET  /api/workbench/capabilities            -- a teljes lista (?force=1: ujramer)
  //   POST /api/workbench/capabilities/:key/test  -- EGY kepesseg ujramerese
  //   POST /api/workbench/capabilities/:key/setting -- a hozza tartozo beallitas
  //
  // A beallitas-iras SZUK: csak az a kulcs irhato, amit a kepesseg leirasa
  // megnevez (`writableSettingKeys`) -- ez a vegpont nem altalanos config-iro.
  if (path === '/api/workbench/capabilities' && method === 'GET') {
    const force = url.searchParams.get('force') === '1'
    json(res, { capabilities: await describeAllCapabilities(lang, force) })
    return true
  }

  if (path.startsWith('/api/workbench/capabilities/') && method === 'POST') {
    const rest = path.slice('/api/workbench/capabilities/'.length).split('/')
    const cap = getCapability(decodeURIComponent(rest[0] || ''))
    if (!cap) return fail(res, 404, 'capability_unknown', lang)
    const action = rest[1] || ''

    if (action === 'test') {
      // Az "Ellenorzes most" MINDIG ujramer: telepites vagy beallitas utan a
      // regi meresbol valaszolni pont azt a hibat okozna, amit javitani akart.
      json(res, { capability: await describeCapability(cap, lang, true) })
      return true
    }

    if (action === 'setting') {
      if (!cap.setting_key) return fail(res, 400, 'capability_no_setting', lang)
      const body = await readJson(req)
      if (!body) return fail(res, 400, 'bad_json', lang)
      const def = getSettingDefinition(cap.setting_key)
      const secret = def?.secret === true
      const raw = body['value']
      // TITOKNAL: az ures mezo azt jelenti, hogy NEM nyulunk hozza (kulonben
      // a mentes torolne a kulcsot, amit a bongeszo sosem latott). A `null`
      // a kimondott torles. Nem titoknal az ures ertek ervenyes ertek: "keresd
      // meg magadtol".
      const skip = secret && typeof raw === 'string' && raw.trim() === ''
      if (!skip) {
        const value = raw === null ? '' : String(raw ?? '').trim()
        const r = setOverride(cap.setting_key, value)
        // A VALODI hibauzenetet adjuk vissza (a registry validalasa mondja ki),
        // nem egy talalgatott okot.
        if (!r.ok) {
          json(res, { error: 'setting_invalid', message: r.error || msg('capability_no_setting', lang) }, 400)
          return true
        }
      }
      json(res, {
        capability: await describeCapability(cap, lang, true),
        saved: !skip,
        message: msg('capability_saved', lang),
      })
      return true
    }

    return fail(res, 404, 'not_found', lang)
  }

  if (path !== '/api/workbench/items' && !path.startsWith('/api/workbench/items/')) return false

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
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
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

  if (!path.startsWith('/api/workbench/items/')) return false

  // .../items/<id>[/parts[/<partId>[/move]]]
  const segs = path.slice('/api/workbench/items/'.length).split('/').map((sg) => {
    // Rosszul kodolt url nem dobhat 500-at: ilyenkor egyszeruen nincs ilyen darab.
    try { return decodeURIComponent(sg) } catch { return sg }
  })
  const item = getWorkItem(segs[0] || '')
  if (!item) return fail(res, 404, 'not_found', lang)

  if (segs.length === 1 && method === 'GET') {
    const project = getProject(item.project_id)
    json(res, {
      item,
      versions: listWorkItemVersionsView(item.id),
      parts: listWorkItemParts(item.id),
      part_kinds: WORK_ITEM_PART_KINDS,
      project: project ? { id: project.id, name: project.name, archived: project.archived_at != null } : null,
    })
    return true
  }

  // VERZIOZAS (5. fazis; spec 12): minden jelentos modositas UJ verzio, es a
  // regi SOHA nem irodik felul. A visszaallitas sem ir felul semmit: a regi
  // allapotbol UJ verzio lesz, a kozben keletkezettek megmaradnak.
  if (segs.length === 2 && segs[1] === 'versions' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const r = createWorkItemVersion(item.id, {
      prompt: body['prompt'],
      // A `source_path` csak akkor valtozik, ha a hivo KIMONDJA -- kulonben marad.
      ...('source_path' in body ? { source_path: body['source_path'] } : {}),
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 404, r.code, lang)
    json(res, { ok: true, item: r.item, version: r.version, versions: listWorkItemVersionsView(item.id) }, 201)
    return true
  }

  if (segs.length === 4 && segs[1] === 'versions' && segs[3] === 'restore' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = restoreWorkItemVersion(segs[2] || '', { created_by: actor(ctx), work_item_id: item.id })
    if (!r.ok) return fail(res, r.code === 'version_mismatch' ? 409 : 404, r.code, lang)
    json(res, { ok: true, item: r.item, version: r.version, versions: listWorkItemVersionsView(item.id), parts: listWorkItemParts(item.id) }, 201)
    return true
  }

  // ELONEZET (4. fazis): mit lehet megmutatni a kozepso panelen, es ha semmit,
  // MIERT nem. A bajtokat a MEGLEVO fajl-kiszolgalo adja (`/api/life/file?rel=`),
  // ez a vegpont csak megmondja, MIT kell kerni -- nincs masodik fajl-ut.
  if (segs.length === 2 && segs[1] === 'preview' && method === 'GET') {
    const p = buildPreview(item.id, url.searchParams.get('version'))
    const message = p.reason ? msg('preview_' + p.reason, lang) : null
    // GYORSITOTAR (spec: "verziohoz kotve, cache"): a jelzes a VERZIOHOZ es a
    // fajl allapotahoz kotodik, tehat valtozasra magatol elavul. `no-cache` =
    // eltarolhato, de MINDIG vissza kell kerdezni -- igy a nagy szoveges
    // elonezet nem megy at ujra a droton, de elavult tartalmat sem latni.
    // A nyelv is beleszamit: mas nyelven MAS mondat jon.
    const tag = p.etag ? `W/"${p.etag}-${lang}"` : null
    const cacheHeaders = tag ? { ETag: tag, 'Cache-Control': 'private, no-cache' } : undefined
    if (tag && req.headers['if-none-match'] === tag) {
      res.writeHead(304, cacheHeaders)
      res.end()
      return true
    }
    json(res, {
      ...p,
      message,
      // Keszre epitett cim -- a felulet ne rakjon ossze sajat utvonalat.
      // Keszre epitett cim. A sajat fajlt a MEGLEVO fajl-kiszolgalo adja; az
      // ATALAKITOTT PDF viszont nem a Raktarban all (szarmaztatott adat), ezert
      // annak sajat, szuk vegpontja van -- de ugyanugy egyetlen ut, nem harom.
      url: p.available && p.kind === 'office'
        ? `/api/workbench/items/${encodeURIComponent(item.id)}/converted?lang=${lang}`
          + (p.version_id ? `&version=${encodeURIComponent(p.version_id)}` : '')
        : p.available && p.rel && p.kind !== 'parts' && p.kind !== 'text'
          ? `/api/life/file?rel=${encodeURIComponent(p.rel)}&lang=${lang}`
          : null,
      versions: listWorkItemVersionsView(item.id),
    }, 200, cacheHeaders)
    return true
  }

  // PDF KESZITESE irodai dokumentumbol (7. fazis). Nem ir felul semmit: az
  // eredeti fajlhoz hozza sem nyulunk, a PDF a `store/` alatti gyorsitotarba
  // kerul, es a forras valtozasara magatol elavul (a kulcs a forras allapota).
  //
  // SZANDEKOSAN az "archivalt projekt = csak olvashato" sor ELOTT all: az
  // elonezet keszitese OLVASAS a felhasznalo adatain (a sajat fajljabol semmi
  // nem valtozik), ezert egy archivalt projekt dokumentumat is meg lehet nezni.
  if (segs.length === 2 && segs[1] === 'convert' && method === 'POST') {
    const p = buildPreview(item.id, url.searchParams.get('version'))
    if (p.kind !== 'office' || !p.rel) return fail(res, 400, 'convert_unsupported', lang)
    const abs = resolveLifePath(p.rel)
    if (!abs) return fail(res, 404, 'convert_missing_source', lang)
    const r = await convertOfficeToPdf(abs)
    if (!r.ok) {
      // A kodot az ATALAKITO mondja meg (nincs telepitve / nem tudtam
      // megkerdezni / idotullepes / hibauzenet), nem mi talaljuk ki. A `detail`
      // a VALODI hibauzenet, hogy a felhasznalo tovabb tudjon lepni.
      const status = r.code === 'not_installed' || r.code === 'check_failed' ? 501
        : r.code === 'timeout' ? 504
        : r.code === 'missing_source' ? 404
        : r.code === 'unsupported' ? 400 : 500
      const code = 'convert_' + r.code
      json(res, {
        error: code, message: msg(code, lang), detail: r.detail,
        capability: r.probe ? { key: 'office_to_pdf', state: r.probe.reason, checked_at: r.probe.checked_at } : null,
      }, status)
      return true
    }
    json(res, {
      ok: true, ready: true, cached: r.cached,
      ext: officeExt(p.name) || null,
      url: `/api/workbench/items/${encodeURIComponent(item.id)}/converted?lang=${lang}`
        + (p.version_id ? `&version=${encodeURIComponent(p.version_id)}` : ''),
    })
    return true
  }

  // A KESZ PDF bajtjai. Kulon vegpont, mert ez a fajl NEM a Raktarban all --
  // barmikor eldobhato, ujra eloallithato szarmaztatott adat.
  if (segs.length === 2 && segs[1] === 'converted' && method === 'GET') {
    const p = buildPreview(item.id, url.searchParams.get('version'))
    if (p.kind !== 'office' || !p.rel) return fail(res, 400, 'convert_unsupported', lang)
    const abs = resolveLifePath(p.rel)
    if (!abs) return fail(res, 404, 'convert_missing_source', lang)
    const pdf = cachedPdfFor(abs)
    if (!pdf) return fail(res, 409, 'convert_not_ready', lang)
    let size = 0
    try { size = statSync(pdf).size } catch {
      // A gyorsitotar-fajl a ket lepes kozott eltunhetett (takaritas). Ez nem
      // 500: ugyanaz a teendo, mint ha meg nem lett volna kesz.
      return fail(res, 409, 'convert_not_ready', lang)
    }
    const name = String(p.name || 'dokumentum').replace(/\.[^.]+$/, '') + '.pdf'
    const download = url.searchParams.get('download') === '1'
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String(size),
      // Szarmaztatott, de szemelyes tartalom: a bongeszo ne tarolja el.
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    })
    createReadStream(pdf).pipe(res)
    return true
  }

  // Archivalt projekt = CSAK OLVASHATO. Az olvasas (GET) marad, minden iras
  // ugyanazt az EMBERI mondatot kapja -- a felulet el is rejti a gombokat, de a
  // szabalyt a szerver tartja be, nem a kepernyo.
  if (method !== 'GET') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
  }

  // DOKUMENTUM FELTOLTESE (7. fazis, spec 8: "letoltes / modositas /
  // ujrafeltoltes; verziozas"). Ez zarja be a kort: a felhasznalo letolti a
  // .docx-et, megszerkeszti a sajat gepen, visszatolti -- es UJ VERZIO lesz
  // belole. A regi SOHA nem irodik felul: sem a verzio (uj sor keletkezik),
  // sem a fajl (a `writeProjectFile` atnevez, ha a nev foglalt).
  if (segs.length === 2 && segs[1] === 'document' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > PROJECT_UPLOAD_MAX_BYTES) return fail(res, 413, 'document_too_large', lang)
    let data: Buffer
    try {
      data = await readBody(req, { maxBytes: PROJECT_UPLOAD_MAX_BYTES })
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return fail(res, 413, 'document_too_large', lang)
      throw e
    }
    if (!data.length) return fail(res, 400, 'empty_file', lang)
    const out = writeProjectFile(project, url.searchParams.get('sub'), url.searchParams.get('name'), data)
    if (!out.ok) return fail(res, out.code === 'write_failed' ? 500 : 400, out.code, lang)
    const r = createWorkItemVersion(item.id, {
      source_path: out.rel,
      prompt: url.searchParams.get('prompt'),
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 404, r.code, lang)
    json(res, {
      ok: true, item: r.item, version: r.version,
      versions: listWorkItemVersionsView(item.id),
      file: out,
      // Ha a nev foglalt volt, a felulet MONDJA MEG, mi lett a fajl neve --
      // ne csak csendben mas neven alljon ott.
      renamed: out.renamed, name: out.name,
    }, 201)
    return true
  }

  if (segs[1] !== 'parts') return false

  // Uj resz: szoveg-blokk, vagy egy MAR meglevo kep utja a Raktarban.
  if (segs.length === 2 && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const r = addWorkItemPart({
      work_item_id: item.id,
      kind: body.kind,
      text: body.text,
      asset_path: body.asset_path,
      mime_type: body.mime_type,
      size: body.size,
      caption: body.caption,
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 400, r.code, lang)
    json(res, { ok: true, part: r.part, parts: listWorkItemParts(item.id) }, 201)
    return true
  }

  // Kep feltoltese a feluletrol: a fajl a PROJEKT mappajaba kerul (ott keresi a
  // felhasznalo, es a mentes is viszi), a munkadarab csak az utjat orzi.
  if (segs.length === 3 && segs[2] === 'image' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > PROJECT_UPLOAD_MAX_BYTES) return fail(res, 413, 'too_large', lang)
    let data: Buffer
    try {
      data = await readBody(req, { maxBytes: PROJECT_UPLOAD_MAX_BYTES })
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return fail(res, 413, 'too_large', lang)
      throw e
    }
    if (!data.length) return fail(res, 400, 'empty_file', lang)
    const out = writeProjectFile(project, url.searchParams.get('sub'), url.searchParams.get('name'), data)
    // A hibakodot a FAJLRENDSZER mondja meg (nincs Raktar / nincs mappa / nem
    // erem el / git-tarolo) -- nem talalgatjuk, mindegyiknek sajat mondata van.
    if (!out.ok) return fail(res, out.code === 'write_failed' ? 500 : 400, out.code, lang)
    const r = addWorkItemPart({
      work_item_id: item.id,
      kind: 'image',
      asset_path: out.rel,
      mime_type: url.searchParams.get('type') || null,
      size: out.bytes,
      caption: url.searchParams.get('caption'),
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 400, r.code, lang)
    json(res, { ok: true, part: r.part, parts: listWorkItemParts(item.id), file: out }, 201)
    return true
  }

  const partId = segs[2] || ''

  if (segs.length === 3 && (method === 'PATCH' || method === 'PUT')) {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const r = updateWorkItemPart(partId, { text: body.text, caption: body.caption })
    if (!r.ok) return fail(res, r.code === 'part_not_found' ? 404 : 400, r.code, lang)
    json(res, { ok: true, part: r.part, parts: listWorkItemParts(item.id) })
    return true
  }

  if (segs.length === 3 && method === 'DELETE') {
    const r = removeWorkItemPart(partId)
    if (!r.ok) return fail(res, 404, r.code, lang)
    json(res, { ok: true, removed: r.part, parts: listWorkItemParts(item.id) })
    return true
  }

  if (segs.length === 4 && segs[3] === 'move' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const dir = String(body.dir ?? '')
    if (dir !== 'up' && dir !== 'down') return fail(res, 400, 'bad_move', lang)
    const r = moveWorkItemPart(partId, dir)
    if (!r.ok) return fail(res, 404, r.code, lang)
    json(res, { ok: true, parts: r.parts })
    return true
  }

  return false
}
