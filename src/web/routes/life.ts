// AZ EGYSEGES ELETFA es a Marvin INTEZO vegpontjai.
//
//   GET  /api/life/status     -- all-e mar a fa, mi hianyzik beloele
//   POST /api/life/ensure     -- a hianyzo mappak letrehozasa (SOSE torol)
//   GET  /api/life/config     -- kik/mely cegek szerepelnek a faban
//   POST /api/life/config     -- ezek szerkesztese
//   GET  /api/life/list       -- egy mappa tartalma, forrasjelvenyekkel
//   GET  /api/life/info       -- a reszletes informacios panel egy tetelrol
//   GET  /api/life/file       -- egy fajl BAJTJAI (elonezet/letoltes, kartya #164)
//   GET  /api/life/thumb      -- kep/video belyegkepe az ikon-nezethez (kartya #373)
//   POST /api/life/send-info  -- mit vinne egy kijeloles csatolmanykent (#389)
//   GET  /api/life/zip        -- egy mappa zip-kent, a megosztas-ablaknak (#389)
//   GET  /api/life/search     -- nev szerinti kereses a fan belul
//   GET  /api/life/name-check -- LETREHOZAS ELOTT: rendben van-e ez a nev
//   POST /api/life/mkdir      -- uj mappa
//   POST /api/life/move       -- athelyezes a fan belul
//   GET  /api/life/repo-status -- egy git-repo allapota emberi mondatban
//   POST /api/life/repo-delete -- egy git-repo mappa torlese (meressel)
//   GET  /api/life/physical   -- papir peldanyok listaja ("papir-terkep")
//   POST /api/life/physical   -- egy tetel papir-adatanak rogzitese
//   GET  /api/life/mounts     -- mely fa-pontok mutatnak masik helyre
//   POST /api/life/mounts     -- uj bekotes (Drive-mappa / Fotok / git repo)
//   POST /api/life/mounts/remove -- bekotes megszuntetese (a fajlok maradnak)
//   POST /api/life/mounts/note   -- miert van itt / ideiglenes-e (a mutato marad)
//   GET  /api/life/mount-options -- mit lehet bekotni (magatol osszeszedve)
//   GET  /api/life/sources    -- a jelvenyek jelmagyarazata (forrasfajtak)
//   GET  /api/life/inbox      -- hany irat var a BEERKEZO-ben
//   POST /api/life/inbox/analyze -- AI-javaslat (tipus/tulajdonos/datum/nev) tetelenkent
//   POST /api/life/inbox/place   -- egy tetel elhelyezese a javaslat (vagy szerkesztett ertek) alapjan
//   POST /api/life/inbox/enroll-face -- egy BEERKEZO fenykep hozzaadasa a helyi arcfelismero galeriahoz
//   POST /api/life/inbox/create-target-folder -- a "hova kerulne" celmappa helyben letrehozasa (kartya #246)
//
// Minden hibauzenet MAGYAR MONDAT, es azt mondja meg, mit tegyen a
// felhasznalo -- nem azt, hogy melyik fuggveny hasalt el.
import { fileKind } from '../../file-kind.js'
import { lifeThumb } from '../../life-thumbs.js'
import { lifeSendInfo, prepareLifeAttachments, SHARE_LIMIT } from '../../life-send.js'
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  ensureLifeTree, lifeTreeStatus, restoreLifeFolders, loadLifeConfig, saveLifeConfig, mediaTargets,
  inboxCount, safeLifeName, newLifeId, lifeName, lifeConfigExists, inboxDir,
  PERSON_CATEGORIES, COMPANY_CATEGORIES, MEDIA_COUNTRY_KEY, MEDIA_KINDS,
  defaultCountrySplit, defaultCompanyCountrySplit, defaultMediaKinds, defaultMediaGroups,
  sanitizeCustodianIds, personRel,
  type LifeConfig, type LifePerson, type LifeCompany, type LifeProject,
} from '../../life-tree.js'
import { inboxStatus, inboxChainStep, inboxPreview, inboxFile } from '../../life-inbox.js'
import { classifyWithAi, mergeAiIntoSuggestion } from '../../life-inbox-ai.js'
import { analyzeInboxAsync, getOcrAdapter, getFaceAdapter, T } from '../../life-inbox-analyze.js'
import { enrollFace } from '../../life-vision-adapter.js'
import { listLifeTemplates, findLifeTemplate } from '../../life-templates.js'
import { lifeHints } from '../../life-hints.js'
import { setDisplayLabel } from '../../life-labels.js'
import { setArchived } from '../../life-archived.js'
import { checkNameForPath, MACHINE_ZONE_DIR } from '../../naming-conventions.js'
import {
  lockRepoReadOnly, unlockRepoReadOnly, isRepoReadOnly, setReadOnlyException,
} from '../../git-accounts.js'
import { depotRoot } from '../../depot.js'
import { storageKindRoot } from '../../storages.js'
import { join as pathJoin, extname as pathExtname, basename as pathBasename } from 'node:path'
import { existsSync, statSync, createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { APP_LANG } from '../../config.js'
import {
  listLife, lifeInfo, moveLife, copyLife, pasteLife, mkdirLife, mkdirLifePath, renameLife, trashLife, purgeLife, searchLife, explorerRoot,
  clearContentCache,
  resolveLifePath,
  type PasteOptions, type ItemResolution,
} from '../../life-explorer.js'
import { contentDispositionHeader } from './drive-browser.js'
import { listSourceKinds } from '../../life-sources.js'
import { listMounts, addMount, removeMount, mountsOverview, updateMountNote } from '../../life-mounts.js'
import { repoAt, reposInside, repoStatus, deleteRepo, writeBlockReason } from '../../git-guard.js'
import { mountCandidates } from '../../life-mount-candidates.js'
import { getPhysical, setPhysical, listPhysical } from '../../life-documents.js'
import { planPersonsGroupMove, applyPersonsGroupMove, isLockError } from '../../life-persons-group.js'
import type { RouteContext } from './types.js'

// A valasz nyelve a FELULETET koveti (`?lang=`), nem a telepitest. A lemezen
// levo mappak NEVE marad APP_LANG szerinti -- azt atnevezni adatvesztes volna.
function uiLang(url: URL): string {
  const v = url.searchParams.get('lang')
  return v === 'en' || v === 'hu' ? v : APP_LANG
}

/**
 * Valasz kuldese ALLAPOTKODDAL ELOL.
 *
 * A kozos `json()` a torzset varja masodiknak, a kodot harmadiknak. Itt
 * viszont minden valasz egy statuszrol szol (200 / 400 / 404), es ha a kod
 * hatul all, egy elfelejtett harmadik parameter csendben 200-at kuld egy
 * hibara -- amit a felulet sikernek olvasna. Ezert itt a kod az elso.
 */
/**
 * A keres torzse OBJEKTUMKENT.
 *
 * A `readBody()` BUFFERT ad vissza, nem elemzett JSON-t. Enelkul a
 * `body?.persons` mindig `undefined` volt -- vagyis MINDEN POST-vegpont
 * csendben ugy viselkedett, mintha ures keres erkezett volna, es a
 * felhasznalo egy teljesen felrevezeto uzenetet kapott ("Legalabb egy
 * szemelynek szerepelnie kell"), miutan kitoltotte az urlapot.
 *
 * Romlott JSON eseten `null`-t adunk: a hivo oldalon a `body?.x` agak
 * ugyanugy lefutnak, es a felhasznalo a vegpont sajat, emberi hibauzenetet
 * kapja -- nem egy nyers elemzesi kivetelt.
 */
async function readJson(req: RouteContext['req']): Promise<any> {
  try {
    const raw = await readBody(req)
    const text = raw.toString('utf-8').trim()
    if (!text) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function send(res: RouteContext['res'], status: number, data: unknown): void {
  json(res, data, status)
}

// A bongeszoben KOZVETLENUL megjelenithetp fajltipusok (kartya #164, 1. fazis).
// A TABLA a `src/file-kind.ts`-ben all: a Munkapad elonezete (#336, 4. fazis)
// ugyanazt a kerdest teszi fel, es ket masolat elobb-utobb szetcsuszna.
// Ami nincs benne (docx/xlsx/exe/stb.), az CSAK letoltheto.

// Meret-korlat, amin tul mar NEM ajanlunk elonezetet (csak letoltest) egy
// nem-video fajlnal -- lasd a hasznalati helyen levo magyarazatot.
const MAX_LIFE_PREVIEW_BYTES = 200 * 1024 * 1024 // 200 MB

function lifeFileKind(name: string): { mime: string | null; previewable: boolean } {
  return fileKind(name)
}

export async function tryHandleLife(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (!path.startsWith('/api/life/')) return false

  // MINDEN iras eldobja a mappa-darabszamok gyorsitotarat (#341). Egy helyen,
  // a bejaratnal: igy egy kesobb hozzaadott iro vegpont sem felejtheti el, es
  // a felulet nem mutathat a MUVELET ELOTTI darabszamot. Olvasasra nem nyulunk
  // hozza -- ott eppen a gyorsitotar a lenyeg.
  if (method !== 'GET' && method !== 'HEAD') clearContentCache()

  // Depo nelkul egyetlen vegpontnak sincs ertelme -- es ez nem hiba, hanem egy
  // meg el nem vegzett beallitas. Ezert mondjuk meg, HOVA menjen erte.
  if (!explorerRoot() && path !== '/api/life/sources') {
    send(res, 400, {
      error: 'no_depot',
      message: T(uiLang(url),
        'Még nincs beállítva, hol tárolja a Marveen a fájljaidat. Nyisd meg a Raktár oldalt, és válaszd ki a mappát (például D:\\Marveen).',
        'There is no storage folder set up for Marveen yet. Open the Depot page and pick the folder (for example D:\\Marveen).'),
    })
    return true
  }

  if (path === '/api/life/status' && method === 'GET') {
    send(res, 200, lifeTreeStatus())
    return true
  }

  if (path === '/api/life/ensure' && method === 'POST') {
    try {
      // A MAPPANEV a telepites nyelven keszul (APP_LANG -- a nev a lemezen all),
      // az UZENET viszont a feluletet koveti. Most, hogy a route nem irja felul
      // a motor mondatat, ez az EGYETLEN szoveg, amit a felhasznalo lat: angol
      // feluletre nem mehet ki magyar toast.
      const result = ensureLifeTree(loadLifeConfig(), APP_LANG, uiLang(url))
      logger.info(
        { created: result.created.length, failed: result.failed.length, abandoned: result.abandoned.length },
        '[eletfa] fa letrehozva/kiegeszitve',
      )
      // Es az `ok` sem lehet fix `true`: ha egy mappa jogosultsag miatt nem jott
      // letre, azt nem nevezzuk sikernek -- a motor mar kiszamolta
      // (`failed.length === 0`), csak at kell engedni.
      send(res, 200, result)
    } catch (err: any) {
      send(res, 500, {
        error: 'failed',
        message: T(uiLang(url),
          `Nem sikerült létrehozni a mappákat: ${String(err?.message || err)}`,
          `The folders could not be created: ${String(err?.message || err)}`),
      })
    }
    return true
  }

  // AMIT A FELHASZNALO KITOROLT, AZT O KERI VISSZA.
  //
  // Az `ensure` szandekosan NEM hozza vissza az eldobott mappat (Boss,
  // 2026-09-20: "Mi az, hogy ellent mondunk a usernek?"). Ezert kell egy
  // KULON, a felhasznalo altal inditott ut visszafele -- kulonben egy elutes
  // veglegesen elvenne a sablon egy agat. Ures `rels` = mindet vissza.
  if (path === '/api/life/restore-abandoned' && method === 'POST') {
    const body = await readJson(req)
    const rels = Array.isArray(body?.rels)
      ? body.rels.filter((r: unknown): r is string => typeof r === 'string')
      : []
    try {
      // A terv nyelve (a letrejovo mappak NEVE) MINDIG a telepites nyelve
      // (APP_LANG), mert a nev a lemezen all; a VALASZ szovege viszont a
      // feluletet koveti -- ezert kap kulon `uiLang(url)` msgLang-ot.
      const result = restoreLifeFolders(rels, loadLifeConfig(), APP_LANG, uiLang(url))
      logger.info({ created: result.created.length, failed: result.failed.length }, '[eletfa] eldobott mappak visszahozva')
      send(res, 200, { ...result, status: lifeTreeStatus() })
    } catch (err: any) {
      send(res, 500, {
        error: 'failed',
        message: T(uiLang(url),
          `Nem sikerült visszahozni a mappákat: ${String(err?.message || err)}`,
          `They could not be restored: ${String(err?.message || err)}`),
      })
    }
    return true
  }

  if (path === '/api/life/config' && method === 'GET') {
    // A VALASZTHATO KULCSOK IS ITT JONNEK. A felulet igy nem tartalmaz sajat
    // masolatot a kategorialistabol: ha a fa bovul (uj kategoria, uj
    // media-tipus), a jelolonegyzetek maguktol megjelennek. Egy lemasolt lista
    // eloszor csak "hianyzik egy pipa", aztan a felhasznalo azt hiszi, nincs
    // is olyan ag.
    const label = (k: string) => lifeName(k, APP_LANG)
    send(res, 200, {
      ...loadLifeConfig(),
      options: {
        personCategories: PERSON_CATEGORIES.map((k) => ({ key: k, label: label(k) })),
        companyCategories: COMPANY_CATEGORIES.map((k) => ({ key: k, label: label(k) })),
        mediaKinds: MEDIA_KINDS.map((k) => ({ key: k, label: label(k) })),
        mediaCountryKey: MEDIA_COUNTRY_KEY,
        mediaLabel: label('media'),
        defaults: {
          countrySplit: defaultCountrySplit(),
          companyCountrySplit: defaultCompanyCountrySplit(),
          mediaKinds: defaultMediaKinds(),
          mediaGroups: defaultMediaGroups(APP_LANG),
        },
      },
    })
    return true
  }

  if (path === '/api/life/config' && method === 'POST') {
    const body = await readJson(req)
    const lang = uiLang(url)
    const parsed = parseConfig(body, lang)
    if (typeof parsed === 'string') {
      send(res, 400, { error: 'bad_config', message: parsed })
      return true
    }
    // THE PERSONS' COMMON FOLDER CHANGED: the existing person folders must move
    // with it, or the next build makes a second, empty tree beside them. Never
    // silently: first the list (what moves where), and only an explicit
    // `confirmGroupMove` from the user moves anything.
    const current = loadLifeConfig()
    const groupPlan = planPersonsGroupMove(current, parsed)
    if (groupPlan.moves.length) {
      const conflicts = groupPlan.moves.filter((m) => m.conflict)
      if (conflicts.length) {
        send(res, 409, {
          error: 'group_move_conflict',
          moves: groupPlan.moves,
          message: T(lang,
            `Nem költöztetek, mert a célhelyen már van ilyen nevű mappa: ${conflicts.map((m) => m.to).join(', ')}. Nézd meg, mi van benne, és nevezd át vagy tedd át kézzel -- nem írok felül semmit.`,
            `I will not move anything: a folder with that name already exists at the target: ${conflicts.map((m) => m.to).join(', ')}. Check what is inside and rename or move it by hand -- I never overwrite.`),
        })
        return true
      }
      if (body?.confirmGroupMove !== true) {
        send(res, 200, {
          ok: false,
          needsConfirm: 'personsGroup',
          moves: groupPlan.moves,
          message: T(lang,
            `Ehhez ${groupPlan.moves.length} mappát kell átköltöztetnem, a tartalmukkal együtt. Semmi nem törlődik, csak a helyük változik.`,
            `This needs ${groupPlan.moves.length} folders moved, with their contents. Nothing is deleted, only their place changes.`),
        })
        return true
      }
      const moved = applyPersonsGroupMove(groupPlan)
      if (!moved.ok) {
        const f = moved.failed[0]
        const lock = isLockError(String(f?.error || ''))
        send(res, 500, {
          error: 'group_move_failed',
          failed: moved.failed,
          message: T(lang,
            `Nem sikerült átköltöztetni: ${f?.from} -> ${f?.to} (${f?.error}). ${lock ? 'A gép nem engedte: valamelyik program nyitva tart egy fájlt vagy mappát ebben a mappában (például egy szerkesztő, a VS Code, egy Intéző-ablak vagy egy futó program). Zárd be, és próbáld újra. ' : ''}${moved.rolledBack ? 'A már áthelyezett mappákat visszatettem, minden a régi helyén van.' : 'Semmi nem mozdult.'} A beállítást nem mentettem el.`,
            `Could not move ${f?.from} -> ${f?.to} (${f?.error}). ${lock ? 'The computer refused: a program keeps a file or folder open inside it (an editor, VS Code, an Explorer window or a running program). Close it and try again. ' : ''}${moved.rolledBack ? 'The folders already moved were put back, everything is where it was.' : 'Nothing moved.'} The setting was not saved.`),
        })
        return true
      }
    }
    saveLifeConfig(parsed)
    // Szandekosan NEM hozzuk letre automatikusan az uj mappakat: a felhasznalo
    // eloszor lassa, mit fog kapni, es o nyomja meg a gombot. Egy elgepelt nev
    // igy nem hagy maga utan egy felesleges mappat a lemezen.
    send(res, 200, { ok: true, config: parsed, status: lifeTreeStatus(parsed) })
    return true
  }

  if (path === '/api/life/list' && method === 'GET') {
    const rel = url.searchParams.get('path') || ''
    const deep = url.searchParams.get('deep') !== '0'
    // `lang`: a felulet nyelve. Csak a sugokat valtja, a mappaneveket nem --
    // azok a lemezen allnak.
    send(res, 200, listLife(rel, { deep, lang: uiLang(url) }))
    return true
  }

  // HOVA MEHET AZ "ATHELYEZES SZEMELYHEZ" (#381): szemelyek es cegek a
  // tervezett media-mappaikkal, es hogy azok a lemezen mar leteznek-e. Egy
  // friss telepitesen, ahol a Konyvtarszerkezet letrehozasa meg nem futott,
  // `exists: false` jon -- az athelyezes ilyenkor maga hozza letre a mappat.
  if (path === '/api/life/media-targets' && method === 'GET') {
    let targets: ReturnType<typeof mediaTargets> = []
    try {
      targets = mediaTargets(loadLifeConfig(), APP_LANG)
    } catch (err) {
      const lang = uiLang(url)
      send(res, 500, { ok: false, code: 'plan_failed', message: T(lang,
        `Nem sikerült beolvasni, kik szerepelnek a fában: ${String((err as Error)?.message || err)}`,
        `Could not read who is in the tree: ${String((err as Error)?.message || err)}`) })
      return true
    }
    const exists = (rel: string) => { const abs = resolveLifePath(rel); return !!abs && existsSync(abs) }
    send(res, 200, {
      ok: true,
      targets: targets.map((t) => ({
        ...t,
        exists: Object.fromEntries(Object.entries(t.media).map(([k, rel]) => [k, exists(rel as string)])),
      })),
    })
    return true
  }

  if (path === '/api/life/info' && method === 'GET') {
    const rel = url.searchParams.get('path') || ''
    const info: any = lifeInfo(rel, uiLang(url))
    if (info) {
      // Csak a TENY kerul ide (repo-e, a gyokere-e). A `git status` lassabb --
      // azt a felulet kulon keri le, amikor tenyleg kell.
      const at = repoAt(rel)
      info.git = at ? { repo: at.rel, isRoot: at.isRoot } : null
    }
    if (!info) {
      send(res, 404, { error: 'outside', message: 'Ez a hely nincs a Marveen mappáján belül.' })
      return true
    }
    const kind = lifeFileKind(info.name || '')
    info.mimeType = kind.mime
    info.previewable = kind.previewable
    send(res, 200, info)
    return true
  }

  // A FAJL TARTALMANAK kiszolgalasa elonezethez/letoltesehez (kartya #164).
  // A BIZTONSAGI HATART szandekosan a MAR MEGLEVO resolveLifePath() adja: ez
  // a vegpont nem ir sajat utvonal-ellenorzest, csak arra ereszt bajtot, amit
  // az mar (realpath-szinten, szimlinket is kovetve) a fa BELSEJENEK itelt.
  if (path === '/api/life/file' && method === 'GET') {
    const rel = url.searchParams.get('rel') || ''
    const abs = resolveLifePath(rel)
    if (!abs) {
      send(res, 404, { error: 'outside', message: T(uiLang(url),
        'Ez a hely nincs a Marveen mappáján belül.',
        'This location is outside the Marveen folder.') })
      return true
    }
    let st: ReturnType<typeof statSync> | null = null
    try { st = statSync(abs) } catch { st = null }
    if (!st || st.isDirectory()) {
      send(res, 404, { error: 'not_a_file', message: T(uiLang(url),
        'Ez a fájl nem található a lemezen, vagy egy mappa.',
        'This file was not found on disk, or it is a folder.') })
      return true
    }

    const name = pathBasename(abs)
    const kind = lifeFileKind(name)
    const forceDownload = url.searchParams.get('download') === '1'
    // Kepnel/PDF-nel/szovegnel a meret-korlat felett MAR CSAK letoltest
    // ajanlunk -- egy tobb szaz MB-os fajl egyben a bongeszo memoriajaba
    // folyatva rosszabb, mint egy egyszeru letoltes-gomb. Videonal ez nem
    // gond: a Range-tamogatas darabokban adja at, sose egyben.
    const isVideo = Boolean(kind.mime && kind.mime.startsWith('video/'))
    const previewable = kind.previewable && (isVideo || st.size <= MAX_LIFE_PREVIEW_BYTES)
    const disposition = !forceDownload && previewable ? 'inline' : 'attachment'

    const range = req.headers.range
    if (range && isVideo) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range))
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
        res.end()
        return true
      }
      let startPos = match[1] ? parseInt(match[1], 10) : st.size - parseInt(match[2], 10)
      let endPos = match[1] && match[2] ? parseInt(match[2], 10) : st.size - 1
      if (Number.isNaN(startPos) || startPos < 0) startPos = 0
      if (Number.isNaN(endPos) || endPos > st.size - 1) endPos = st.size - 1
      if (startPos > endPos || startPos >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
        res.end()
        return true
      }
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Type': kind.mime || 'application/octet-stream',
        'Content-Disposition': contentDispositionHeader(name, disposition),
        'Content-Range': `bytes ${startPos}-${endPos}/${st.size}`,
        'Content-Length': endPos - startPos + 1,
        'Cache-Control': 'private, no-store',
      })
      try {
        await pipeline(createReadStream(abs, { start: startPos, end: endPos }), res)
      } catch (err: any) {
        logger.debug({ err: err?.message }, '[eletfa] a videoreszlet kuldese felbeszakadt')
        res.destroy()
      }
      return true
    }

    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Type': kind.mime || 'application/octet-stream',
      'Content-Disposition': contentDispositionHeader(name, disposition),
      'Content-Length': st.size,
      'Cache-Control': 'private, no-store',
    })
    try {
      await pipeline(createReadStream(abs), res)
    } catch (err: any) {
      // A bongeszo elnavigalt/megszakitotta a letoltest -- ez a leggyakoribb
      // eset, es NEM hiba. A valasz feje mar elment, uzenetet mar nem kuldhetunk.
      logger.debug({ err: err?.message }, '[eletfa] a fajl kuldese felbeszakadt')
      res.destroy()
    }
    return true
  }

  // KULDES (#389): mit vinne egy kijeloles csatolmanykent -- darab, meret,
  // a mappak zip-neve --, MIELOTT barmi elkeszulne. A levelirot ez tolti ki.
  if (path === '/api/life/send-info' && method === 'POST') {
    let data: { rels?: unknown } = {}
    try { data = JSON.parse((await readBody(req)).toString() || '{}') } catch { data = {} }
    const info = lifeSendInfo(data.rels, uiLang(url) === 'en' ? 'en' : 'hu')
    send(res, info.ok ? 200 : 400, info)
    return true
  }

  // EGY MAPPA ZIP-KENT (#389) -- a bongeszo megosztas-ablakanak (WhatsApp,
  // Messenger...), ami csak fajlt tud atadni, mappat nem. Ugyanaz a hatar,
  // mint a /api/life/file-nal: resolveLifePath().
  if (path === '/api/life/zip' && method === 'GET') {
    const lang = uiLang(url) === 'en' ? 'en' : 'hu'
    const rel = url.searchParams.get('rel') || ''
    const prep = prepareLifeAttachments([rel], lang, SHARE_LIMIT)
    if (!prep.ok) { send(res, 400, { error: prep.code, message: prep.message }); return true }
    const zipPath = prep.paths[0]
    if (!zipPath || !zipPath.endsWith('.zip')) {
      prep.cleanup()
      send(res, 400, { error: 'not_a_folder', message: T(lang, 'Ez nem mappa -- a fájlt közvetlenül lehet küldeni.', 'This is not a folder -- the file can be sent as it is.') })
      return true
    }
    try {
      const st = statSync(zipPath)
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDispositionHeader(pathBasename(zipPath), 'attachment'),
        'Content-Length': st.size,
        'Cache-Control': 'private, no-store',
      })
      await pipeline(createReadStream(zipPath), res)
    } catch (err: any) {
      logger.debug({ err: err?.message }, '[eletfa] a zip kuldese felbeszakadt')
      res.destroy()
    } finally {
      prep.cleanup()
    }
    return true
  }

  // BELYEGKEP az ikon-nezethez (kartya #373). Ugyanaz a hatar, mint a
  // /api/life/file-nal: csak arra ad bajtot, amit a resolveLifePath() a fa
  // belsejenek itel. Ha nincs kep, a valasz KIMONDJA, miert (nem ures kep).
  if (path === '/api/life/thumb' && method === 'GET') {
    const lang = uiLang(url)
    const rel = url.searchParams.get('rel') || ''
    const abs = resolveLifePath(rel)
    if (!abs) {
      send(res, 404, { error: 'outside', message: T(lang,
        'Ez a hely nincs a Marveen mappáján belül.',
        'This location is outside the Marveen folder.') })
      return true
    }
    const r = await lifeThumb(abs, pathBasename(abs))
    if (!r.ok) {
      const messages: Record<string, [string, string]> = {
        not_media: ['Ehhez a fájlhoz nincs előnézeti kép: nem kép és nem videó.', 'There is no preview picture for this file: it is not a photo or a video.'],
        // The installer puts FFmpeg on every machine (install-linux.sh core
        // package list, install-macos.sh brew). This is the case where it went
        // missing -- the self-check row (system-deps, tier recommended) gives
        // the install command, so the sentence points THERE.
        no_ffmpeg: ['Ehhez az előnézethez az FFmpeg nevű ingyenes program kell. A telepítő alapból felteszi; ha nálad hiányzik, az Áttekintés önellenőrzése jelzi, és ad hozzá bemásolható telepítő parancsot. Addig a fájl ikonja látszik.', 'This preview needs the free FFmpeg program. The installer sets it up by default; if it is missing here, the self-check on the Overview shows it and gives you a command to paste. Until then the file icon is shown.'],
        too_big: ['A kép túl nagy ahhoz, hogy FFmpeg nélkül előnézetet készítsünk belőle.', 'The photo is too large to preview without FFmpeg.'],
        failed: ['Ebből a fájlból nem sikerült előnézeti képet készíteni (lehet, hogy sérült, vagy ismeretlen a formátuma).', 'Could not make a preview picture from this file (it may be damaged, or its format is unknown).'],
      }
      const [hu, en] = messages[r.reason] || messages.failed
      send(res, 404, { error: 'no_thumb', reason: r.reason, message: T(lang, hu, en) })
      return true
    }
    const etag = `"${r.etag}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=86400' })
      res.end()
      return true
    }
    let size = 0
    try { size = statSync(r.path).size } catch { size = 0 }
    res.writeHead(200, {
      'Content-Type': r.kind === 'thumb' ? 'image/jpeg' : r.mime,
      'Content-Length': size,
      ETag: etag,
      'Cache-Control': 'private, max-age=86400',
    })
    try {
      await pipeline(createReadStream(r.path), res)
    } catch (err: any) {
      logger.debug({ err: err?.message }, '[eletfa] a belyegkep kuldese felbeszakadt')
      res.destroy()
    }
    return true
  }

  if (path === '/api/life/search' && method === 'GET') {
    const rel = url.searchParams.get('path') || ''
    const q = url.searchParams.get('q') || ''
    send(res, 200, searchLife(rel, q, 200, uiLang(url)))
    return true
  }

  // LETREHOZAS ELOTTI ellenorzo (kanban #167). A felulet gepeles kozben hivja,
  // igy a figyelmeztetes AKKOR latszik, amikor meg olcso valtoztatni -- nem
  // utolag. Sosem tilt es sosem ir: csak megmondja, mi lesz ebbol baj, es mi a
  // javasolt nev helyette.
  if (path === '/api/life/name-check' && method === 'GET') {
    const parent = url.searchParams.get('parent') ?? ''
    const name = url.searchParams.get('name') ?? ''
    const advice = checkNameForPath(parent, name, uiLang(url))
    send(res, 200, {
      ok: advice.ok,
      zone: advice.zone,
      machineZoneDir: MACHINE_ZONE_DIR,
      suggestion: advice.suggestion,
      message: advice.message,
      code: advice.code,
    })
    return true
  }

  if (path === '/api/life/mkdir' && method === 'POST') {
    const body = await readJson(req)
    // Egy git-repo munkapeldanyaba kezzel uj mappat tenni: a git kovetkezo
    // muvelete vagy panaszkodik ra, vagy eltakaritja. Nem tiltunk neman --
    // az uzenet megmondja, mit tegyen helyette.
    const blocked = writeBlockReason(String(body?.parent ?? ''))
    if (blocked) {
      send(res, 400, { ok: false, rel: '', code: 'git_repo', message: blocked })
      return true
    }
    const result = mkdirLife(String(body?.parent ?? ''), String(body?.name ?? ''), uiLang(url))
    send(res, result.ok ? 200 : 400, result)
    return true
  }

  // Ket dolog, ami egy mappa ALATT vagy egy mappa MIATT romlik el, ha
  // elmozditjuk. Mert lattuk elromlani (2026-08-22-i hatasvizsgalat):
  //
  //   - a mappa alatti BEKOTESEK bejegyzese ottmaradt egy nem letezo
  //     utvonalon, a fan meg csak egy ures mappa latszott;
  //   - a mappa alatti CELPONTOK (`Tárolók/Git/...`) elmozdultak, es a
  //     bekotesek a semmibe mutattak -- a repo eltunt a fabol, pedig megvolt.
  //
  // Nem tiltas: megmondjuk, mit kell elotte elintezni.
  const bekotesOrzo = (rel: string, lang: string): { code: string; message: string } | null => {
    // A gyoker (ures rel) mindenre "alatta" lenne -- azt a moveLife/trashLife
    // sajat hatarellenorzese intezi, nem ez.
    if (!rel) return null
    const alatta = listMounts().filter((m) => m.rel === rel || m.rel.startsWith(rel + '/'))
    if (alatta.length) {
      const n = alatta.length
      return {
        code: 'has_mounts',
        message: T(lang,
          `Ebben a mappában ${n === 1 ? 'egy bekötés van' : n + ' bekötés van'}`
            + ` (pl. ${alatta[0].rel}). Előbb szüntesd meg őket a „Mit mutasson ez a mappa?" résznél — `
            + 'különben a bekötés egy nem létező helyre mutatna tovább.',
          `This folder has ${n === 1 ? 'a link' : n + ' links'} inside it`
            + ` (e.g. ${alatta[0].rel}). Remove ${n === 1 ? 'it' : 'them'} first under "What should this folder show?" — `
            + 'otherwise the link would keep pointing to a place that no longer exists.'),
      }
    }
    const celok = listMounts().filter((m) => m.target === rel || m.target.startsWith(rel + '/'))
    if (celok.length) {
      const n = celok.length
      return {
        code: 'is_target',
        message: T(lang,
          `Erre a mappára ${n === 1 ? 'egy bekötés mutat' : n + ' bekötés mutat'}`
            + ` (innen látszik: ${celok[0].rel}). Ha elmozdítom, ott üres hely maradna. `
            + 'Előbb szüntesd meg a bekötést, aztán mozdítsd el.',
          `${n === 1 ? 'A link points' : n + ' links point'} to this folder`
            + ` (it shows up at: ${celok[0].rel}). If I move it, that place would be left empty. `
            + 'Remove the link first, then move it.'),
      }
    }
    return null
  }
  const mountedMsg = (lang: string): string => T(lang,
    'Ez a mappa be van kötve máshova, csak MUTAT egy másik helyre. Előbb szüntesd meg a bekötést a „Mit mutasson ez a mappa?" résznél, '
      + 'aztán mozgasd vagy nevezd át — a bekötés az útvonalra szól, új helyen nem találna rá.',
    'This folder is a link: it only POINTS to another place. Remove the link first under "What should this folder show?", '
      + 'then move or rename it — the link belongs to the path and would not find it in a new place.')

  // Az ATHELYEZES ugyanazt orzi, mint az Atnevezes es a Kuka (#376): a
  // resolveLifePath egy bekotott utvonalat a bekotes CELJARA fordit, igy egy
  // bekotott mappa "athelyezese" a mogotte allo valodi tarolot (pl. a teljes
  // Drive- vagy Git-mappat) vitte el, a bekotes pedig a semmibe mutatott.
  // BEILLESZTES CELJA (#383): egy git-repo BARMELYIK pontjara -- a gyokeret is
  // beleertve -- kezzel semmi nem kerulhet. A `writeBlockReason` a repo
  // gyokeret szabadnak veszi (azt magat szabad mozgatni), ezert a CEL-oldalon
  // kulon kerdezzuk meg: a gyokerbe tett fajl ugyanugy a repoba kerul.
  const intoRepoReason = (to: string, lang: string): string => {
    const at = repoAt(to)
    if (!at) return ''
    return T(lang,
      `Ez a mappa egy git-repó (${at.rel}), ezért ide kézzel nem teszek semmit. `
        + 'A repóba a szerkesztőből kerül a munka, commit + push után -- kézzel betéve a következő letöltés vagy visszasírja, vagy csendben eldobja.',
      `This folder is a git repository (${at.rel}), so I will not put anything in it by hand. `
        + 'Work gets into a repository from the editor, with commit + push -- dropped in by hand, the next download either complains or silently drops it.')
  }

  // NEVUTKOZES (#383): 409 + `name_exists`, a javasolt nevvel. Nem hiba, hanem
  // kerdes -- a hivo `keepBoth: true`-val ismetli meg, ha mindkettot megtartja.
  const isNameClash = (r: { ok: boolean; code?: string; suggested?: string }) => !r.ok && r.code === 'exists' && !!r.suggested
  const pasteStatus = (r: { ok: boolean; code?: string; suggested?: string }) => (r.ok ? 200 : isNameClash(r) ? 409 : 400)
  const pasteBody = <R extends { ok: boolean; code?: string; suggested?: string }>(r: R) => (isNameClash(r) ? { ...r, code: 'name_exists' } : r)

  // UTKOZES FELOLDASA (#383, Boss TG 6346: "minden kell ami a Windows
  // intezojeben is van"). Csak az engedett szavakat vesszuk at; a `keepBoth:
  // true` a regi (1. lepes) alak, ugyanazt jelenti.
  const RES = ['keepBoth', 'replace', 'skip', 'merge'] as const
  const ITEM = ['replace', 'skip', 'keepBoth'] as const
  const pasteOpts = (body: any): PasteOptions => {
    const resolution = (RES as readonly string[]).includes(body?.resolution) ? body.resolution
      : body?.keepBoth === true ? 'keepBoth' : undefined
    const fileResolution = (ITEM as readonly string[]).includes(body?.fileResolution) ? body.fileResolution : undefined
    let perFile: Record<string, ItemResolution> | undefined
    if (body?.perFile && typeof body.perFile === 'object' && !Array.isArray(body.perFile)) {
      perFile = {}
      for (const [k, v] of Object.entries(body.perFile)) {
        if (typeof k === 'string' && k.length < 4096 && (ITEM as readonly string[]).includes(v as string)) perFile[k] = v as ItemResolution
      }
    }
    return { resolution, fileResolution, perFile }
  }
  // A CSERE a celban allo regit a Kukaba viszi, az EGYESITES a cel-mappaba ir:
  // a CEL-oldali elemre ugyanazok az orok allnak, mint a sajat Kukaba
  // tetelere / athelyezesere -- kulonben a Csere gomb megkerulne oket.
  const targetGuard = (from: string, to: string, opts: PasteOptions, lang: string): { code: string; message: string } | null => {
    if (opts.resolution !== 'replace' && opts.resolution !== 'merge') return null
    const name = from.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || ''
    const toKey = to.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const targetRel = toKey ? toKey + '/' + name : name
    const blocked = writeBlockReason(targetRel)
    if (blocked) return { code: 'git_repo', message: blocked }
    if (listMounts().some((m) => m.rel === targetRel)) return { code: 'mounted', message: mountedMsg(lang) }
    const baj = bekotesOrzo(targetRel, lang)
    if (baj) return baj
    const repok = reposInside(targetRel)
    if (repok.length) {
      return { code: 'has_repos', message: T(lang,
        `A cél-mappában git-repó van (${repok[0]}). Oda nem egyesítek és nem cserélek kézzel.`,
        `The target folder has a git repository inside it (${repok[0]}). I will not merge or replace into it by hand.`) }
    }
    return null
  }

  if (path === '/api/life/move' && method === 'POST') {
    const lang = uiLang(url)
    const body = await readJson(req)
    const from = String(body?.from ?? '')
    // MINDKET veget nezzuk: a repobol kimozgatni ugyanugy elrontja a
    // verziokovetest, mint belerakni egy oda nem tartozo fajlt.
    const blocked = writeBlockReason(from) || intoRepoReason(String(body?.to ?? ''), lang)
    if (blocked) {
      send(res, 400, { ok: false, rel: '', code: 'git_repo', message: blocked })
      return true
    }
    const fromKey = from.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (listMounts().some((m) => m.rel === fromKey)) {
      send(res, 400, { ok: false, rel: '', code: 'mounted', message: mountedMsg(lang) })
      return true
    }
    const baj = bekotesOrzo(fromKey, lang)
    if (baj) { send(res, 400, { ok: false, rel: '', ...baj }); return true }
    const opts = pasteOpts(body)
    const celBaj = targetGuard(from, String(body?.to ?? ''), opts, lang)
    if (celBaj) { send(res, 400, { ok: false, rel: '', ...celBaj }); return true }
    const result = await pasteLife('move', from, String(body?.to ?? ''), lang, opts)
    send(res, pasteStatus(result), pasteBody(result))
    return true
  }

  // MASOLAS (#383): a jobbklikkes Masolas + Beillesztes. Az eredeti a helyen
  // marad, ezert a forras-oldali orok enyhebbek, mint az Athelyezesnel: egy
  // bekotes CELJAT nyugodtan le lehet masolni, hiszen onnan semmi nem mozdul.
  if (path === '/api/life/copy' && method === 'POST') {
    const lang = uiLang(url)
    const body = await readJson(req)
    const from = String(body?.from ?? '')
    const to = String(body?.to ?? '')
    const blocked = intoRepoReason(to, lang)
    if (blocked) {
      send(res, 400, { ok: false, rel: '', code: 'git_repo', message: blocked })
      return true
    }
    const fromKey = from.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    // Egy BEKOTES masolata a mogotte allo teljes tarolot (pl. egy egesz
    // Drive-mappat) masolna be a faba -- nem ezt varja, aki egy mutatot lat.
    if (listMounts().some((m) => m.rel === fromKey)) {
      send(res, 400, { ok: false, rel: '', code: 'mounted', message: T(lang,
        'Ez a mappa csak MUTAT egy másik helyre, saját tartalma nincs. A benne lévő fájlokat egyenként le tudod másolni.',
        'This folder only POINTS to another place, it has no content of its own. You can copy the files inside it one by one.') })
      return true
    }
    // Bekotest tartalmazo mappa masolata a bekotest NEM vinne magaval: a
    // masolatban az a resz csendben ures maradna.
    const alatta = fromKey ? listMounts().filter((m) => m.rel.startsWith(fromKey + '/')) : []
    if (alatta.length) {
      send(res, 400, { ok: false, rel: '', code: 'has_mounts', message: T(lang,
        `Ebben a mappában bekötés van (pl. ${alatta[0].rel}). A másolatba a bekötés nem kerülne át, az a rész üres maradna -- ezért így nem másolom. Másold a benne lévő mappákat külön.`,
        `This folder has a link inside it (e.g. ${alatta[0].rel}). The link would not come along into the copy and that part would stay empty -- so I will not copy it like this. Copy the folders inside it separately.`) })
      return true
    }
    // Git-repot nem sokszorozunk: a masolat egy masodik, gazdatlan klon lenne.
    const repok = reposInside(from)
    if (repok.length) {
      send(res, 400, { ok: false, rel: '', code: 'has_repos', message: T(lang,
        `Ez egy git-repó, vagy van benne egy (${repok[0]}). Azt nem másolom: a másolat egy második, gazdátlan példány lenne. Ha kell még egy, töltsd le újra a repót.`,
        `This is a git repository, or has one inside it (${repok[0]}). I will not copy it: the copy would be a second, ownerless clone. If you need another one, download the repository again.`) })
      return true
    }
    const opts = pasteOpts(body)
    const celBaj = targetGuard(from, to, opts, lang)
    if (celBaj) { send(res, 400, { ok: false, rel: '', ...celBaj }); return true }
    const result = await pasteLife('copy', from, to, lang, opts)
    send(res, pasteStatus(result), pasteBody(result))
    return true
  }

  if (path === '/api/life/rename' && method === 'POST') {
    const lang = uiLang(url)
    const body = await readJson(req)
    const rel = String(body?.rel ?? '')
    const blocked = writeBlockReason(rel)
    if (blocked) {
      send(res, 400, { ok: false, rel: '', code: 'git_repo', message: blocked })
      return true
    }
    // Egy BEKOTOTT mappa atnevezese elszakitana a bekotestol: a bekotes az
    // UTVONALRA szol, az uj neven mar nem talalna meg. Inkabb megmondjuk.
    if (listMounts().some((m) => m.rel === rel)) {
      send(res, 400, { ok: false, rel: '', code: 'mounted', message: mountedMsg(lang) })
      return true
    }
    const baj = bekotesOrzo(rel, lang)
    if (baj) { send(res, 400, { ok: false, rel: '', ...baj }); return true }
    send(res, 200, renameLife(rel, String(body?.name ?? ''), lang))
    return true
  }

  // MEGJELENITETT nev: a lemez-nevet NEM bantja, ezert git-repora es bekotott
  // mappara is szabad (epp az a lenyeg, hogy pl. a GIT_REPOS "Marveen Repos"-kent
  // latsszon, miközben az ut es a szinkron valtozatlan). Ures nev = torles ->
  // visszaall a valodi mappanev. Csak azt kotjuk ki, hogy a mappa a fan BELUL
  // legyen -- a resolveLifePath dönti el (szimlinket is kovetve).
  if (path === '/api/life/display-name' && method === 'POST') {
    const body = await readJson(req)
    const rel = String(body?.rel ?? '')
    if (!resolveLifePath(rel)) {
      send(res, 400, { ok: false, code: 'outside', message: 'Ez a hely nincs a Marveen mappáján belül.' })
      return true
    }
    const result = setDisplayLabel(rel, String(body?.name ?? ''))
    send(res, result.ok ? 200 : 400, result)
    return true
  }

  // ARCHIVED MARK (in place): the toggle next to every row in the explorer.
  // Nothing moves on disk; the list shows the item grey and last.
  if (path === '/api/life/archived' && method === 'POST') {
    const lang = uiLang(url)
    const body = await readJson(req)
    const rel = String(body?.rel ?? '')
    const abs = resolveLifePath(rel)
    if (!abs || !rel.replace(/^\/+|\/+$/g, '')) {
      send(res, 400, { ok: false, code: 'outside', message: T(lang, 'Ez a hely nincs a Marveen mappáján belül.', 'This place is not inside the Marveen folder.') })
      return true
    }
    if (!existsSync(abs)) {
      send(res, 404, { ok: false, code: 'missing', message: T(lang, 'Ez már nincs itt. Frissítsd a listát.', 'This is not here any more. Refresh the list.') })
      return true
    }
    const on = body?.archived === true
    const r = setArchived(rel, on)
    if (!r.ok) {
      send(res, 500, { ok: false, code: r.code, message: T(lang,
        'Nem tudtam elmenteni a jelölést: a Marveen archív-nyilvántartása (store/life-archived.json) megsérült. Szólj Marvinnak.',
        'Could not save the mark: the Marveen archive register (store/life-archived.json) is damaged. Tell Marvin.') })
      return true
    }
    send(res, 200, { ok: true, archived: r.archived, message: on
      ? T(lang, 'Archiválva: a helyén marad, szürkén, a lista végén.', 'Archived: it stays in its place, grey, at the end of the list.')
      : T(lang, 'Visszakerült a helyére.', 'Back in its usual place.') })
    return true
  }

  if (path === '/api/life/trash' && method === 'POST') {
    const lang = uiLang(url)
    const body = await readJson(req)
    const rel = String(body?.rel ?? '')
    const blocked = writeBlockReason(rel)
    if (blocked) {
      send(res, 400, { ok: false, rel: '', code: 'git_repo', message: blocked })
      return true
    }
    // BEKOTES: itt semmilyen sajat tartalom nincs, csak egy mutato. Kukazni
    // ertelmetlen (a fajlok maradnak, ahol vannak), es meg is teveszto lenne
    // -- „toroltem, megis ott van".
    if (listMounts().some((m) => m.rel === rel)) {
      send(res, 400, {
        ok: false, rel: '', code: 'mounted',
        message: T(lang,
          'Ez a mappa csak MUTAT egy másik helyre, saját tartalma nincs. Ha nem kell itt, '
            + 'a „Mit mutasson ez a mappa?" résznél szüntesd meg a bekötést — a fájlok a helyükön maradnak.',
          'This folder only POINTS to another place, it has no content of its own. If you do not need it here, '
            + 'remove the link under "What should this folder show?" — the files stay where they are.'),
      })
      return true
    }
    // GIT-REPO: a klon eldobhato, a benne levo, fel nem toltott munka nem. Erre
    // van sajat, MERO vegpont -- oda kuldjuk, nem kukazunk vaktaban.
    const at = repoAt(rel)
    if (at && at.isRoot) {
      send(res, 400, {
        ok: false, rel: '', code: 'repo',
        message: T(lang,
          'Ez egy git-repó. A törléséhez a repó saját gombját használd — az előbb megnézi, '
            + 'van-e benne fel nem töltött munka.',
          'This is a git repository. Use the repository\'s own delete button — it first checks '
            + 'whether it holds work that has not been uploaded.'),
      })
      return true
    }
    const baj = bekotesOrzo(rel, lang)
    if (baj) { send(res, 400, { ok: false, rel: '', ...baj }); return true }
    // Egy mappa a BENNE levo repokat is magaval vinne. A repoknak sajat, MERO
    // torlesuk van (megnezi a fel nem toltott munkat) -- oda kuldjuk.
    const benne = reposInside(rel)
    if (benne.length) {
      send(res, 400, {
        ok: false, rel: '', code: 'has_repos',
        message: T(lang,
          `Ebben a mappában ${benne.length === 1 ? 'egy git-repó van' : benne.length + ' git-repó van'}`
            + ` (pl. ${benne[0]}). Ezeket a saját törlő gombjukkal szüntesd meg — az előbb megnézi, `
            + 'van-e bennük fel nem töltött munka. Utána ez a mappa is mehet a Kukába.',
          `This folder has ${benne.length === 1 ? 'a git repository' : benne.length + ' git repositories'} inside it`
            + ` (e.g. ${benne[0]}). Remove ${benne.length === 1 ? 'it' : 'them'} with ${benne.length === 1 ? 'its' : 'their'} own delete button — it first checks `
            + 'for work that has not been uploaded. After that this folder can go to the Bin too.'),
      })
      return true
    }
    send(res, 200, trashLife(rel, lang))
    return true
  }

  // VEGLEGES TORLES -- csak a Kukabol. A hatart a `purgeLife` orzi.
  if (path === '/api/life/purge' && method === 'POST') {
    const lang = uiLang(url)
    const body = await readJson(req)
    const rel = String(body?.rel ?? '')
    // A HATART NEZZUK ELOSZOR. Elesben derult ki: egy ures/rossz utvonalra a
    // repo-kerdes futott le eloszor, es a felulet a "ennek ellenere toroljem?"
    // kerdest kinalta az EGESZ fara -- olyasmire, amit a purgeLife ugyis
    // megtagad. Rossz kerdest feltenni ilyen gombnal onmagaban is hiba.
    const kukaRel = lifeName('system', APP_LANG) + '/' + lifeName('trash', APP_LANG)
    if (rel !== kukaRel && !rel.startsWith(kukaRel + '/')) {
      send(res, 200, purgeLife(rel, uiLang(url)))
      return true
    }
    // A Kukaban is allhat git-repo (belekerult egy kukazott mappaval). A
    // vegleges torles azt is elviszi, a fel nem toltott munkaval egyutt --
    // ezert eloszor MEGMONDJUK, es csak kifejezett megerositessel megyunk at
    // rajta. A felhasznalonak latnia kell, mit veszit, mielott elveszti.
    const benne = reposInside(rel)
    if (benne.length && body?.force !== true) {
      send(res, 400, {
        ok: false, rel: '', code: 'has_repos',
        message: T(lang,
          `Ebben ${benne.length === 1 ? 'egy git-repó van' : benne.length + ' git-repó van'}`
            + ` (pl. ${benne[0]}). A végleges törlés a bennük levő, fel nem töltött munkát is elviszi.`,
          `This holds ${benne.length === 1 ? 'a git repository' : benne.length + ' git repositories'}`
            + ` (e.g. ${benne[0]}). Deleting for good also takes the work in ${benne.length === 1 ? 'it' : 'them'} that has not been uploaded.`),
        repos: benne,
      })
      return true
    }
    send(res, 200, purgeLife(rel, uiLang(url)))
    return true
  }

  // 2. SZINT: a repo-mappa torleset NEM tiltjuk -- megmerjuk. Egy klon
  // eldobhato; a veszely a benne levo, fel nem toltott munka.
  // 3. SZINT: ha bekotes mutat ra, azt ajanljuk ELSOKENT -- semmit nem torol.
  // Mit szoktak az egyes mappakba tenni -- MAPPANEV szerint, hogy a felulet
  // barhol (lista, oldalsav, valaszto) ugyanabbol az egy forrasbol dolgozzon.
  if (path === '/api/life/hints' && method === 'GET') {
    // A KULCS a lemezen levo (telepites-nyelvu) mappanev, az ERTEK a felulet
    // nyelven all: a lista a mappa neve alapjan keresi vissza a sugot, de az
    // olvasonak a sajat nyelven kell megjelennie.
    const hintLang = uiLang(url)
    const out: Record<string, string> = {}
    for (const [key, szoveg] of Object.entries(lifeHints(hintLang))) {
      out[lifeName(key, APP_LANG)] = szoveg
    }
    send(res, 200, { hints: out })
    return true
  }

  if (path === '/api/life/repo-status' && method === 'GET') {
    const rel = url.searchParams.get('path') || ''
    const status = await repoStatus(rel)
    const mounts = listMounts().filter((m) => m.target === status.rel || m.rel === status.rel)
    // A zar allapota is ide jon: a felhasznalo egy helyen lassa, mi van a
    // repoval. Kulon lekerdezes konnyen elcsuszna a tobbitol.
    const hely = gitTarhelyHely(status.rel || rel)
    const readOnly = hely ? await isRepoReadOnly(hely.abs) : false
    send(res, 200, { ...status, mounts, zarhato: !!hely, csakOlvasas: readOnly })
    return true
  }

  // A csak-olvasas zar be/ki kapcsolasa egy repora.
  if (path === '/api/life/repo-lock' && method === 'POST') {
    const body = await readJson(req)
    const rel = String(body?.rel ?? '')
    const be = body?.on === true
    // A repoStatus oldja fel a bekotest is: az o `rel`-je mar a valodi hely.
    const feloldott = await repoStatus(rel)
    const hely = gitTarhelyHely(feloldott.rel || rel)
    if (!hely) {
      send(res, 400, { ok: false, message: 'Ez a repó nem egy git-tároló fiókja alatt van, itt nincs mit zárni.' })
      return true
    }
    const ok = be ? await lockRepoReadOnly(hely.abs) : await unlockRepoReadOnly(hely.abs)
    if (!ok) {
      send(res, 400, { ok: false, message: be ? 'A zárat nem sikerült felrakni.' : 'A zárat nem sikerült levenni.' })
      return true
    }
    // A dontes TULELI a kovetkezo lehuzast -- kulonben a gep a hatad mogott
    // visszacsinalna, es legkozelebb mar nem nezne utana senki.
    setReadOnlyException(hely.account, hely.repo, !be)
    logger.info({ rel, be }, '[intezo] csak-olvasas zar allitva')
    send(res, 200, {
      ok: true,
      csakOlvasas: be,
      message: be
        ? 'Zárva: ebből a repóból feltölteni nem lehet. Olvasni és frissülni igen.'
        : 'A zár levéve: ebbe a repóba innen feltölteni is lehet. Ez a következő lehúzás után is így marad.',
    })
    return true
  }

  if (path === '/api/life/repo-delete' && method === 'POST') {
    const body = await readJson(req)
    const rel = String(body?.rel ?? '')
    // A `force` a felulet MASODIK kattintasa: az elso valasz kiirja a mert
    // mondatot, es csak azutan lehet ratenni a kezet. A szerver ujra mer --
    // a bongeszo allitasaban nem bizunk.
    const result = await deleteRepo(rel, { force: body?.force === true })
    logger.info({ rel, ok: result.ok, code: result.code }, '[intezo] git-repo torles keres')
    send(res, result.ok ? 200 : 400, result)
    return true
  }

  if (path === '/api/life/physical' && method === 'GET') {
    const rel = url.searchParams.get('path')
    if (rel === null) {
      send(res, 200, { items: listPhysical() })
      return true
    }
    send(res, 200, getPhysical(rel))
    return true
  }

  if (path === '/api/life/physical' && method === 'POST') {
    const body = await readJson(req)
    const rel = String(body?.path ?? '').trim()
    if (!rel) {
      send(res, 400, { error: 'no_path', message: 'Nem derült ki, melyik iratról van szó.' })
      return true
    }
    const rec = setPhysical(rel, {
      physical: Boolean(body?.physical),
      location: String(body?.location ?? ''),
      note: String(body?.note ?? ''),
    })
    send(res, 200, { ok: true, ...rec })
    return true
  }

  if (path === '/api/life/mounts' && method === 'GET') {
    send(res, 200, mountsOverview())
    return true
  }

  if (path === '/api/life/mounts' && method === 'POST') {
    const body = await readJson(req)
    const result = addMount({
      rel: String(body?.rel ?? ''),
      target: String(body?.target ?? ''),
      kind: String(body?.kind ?? 'local'),
      label: String(body?.label ?? ''),
      note: String(body?.note ?? ''),
      provisional: Boolean(body?.provisional),
    })
    send(res, result.ok ? 200 : 400, result)
    return true
  }

  if (path === '/api/life/mounts/note' && method === 'POST') {
    const body = await readJson(req)
    const result = updateMountNote(String(body?.rel ?? ''), {
      note: String(body?.note ?? ''),
      provisional: Boolean(body?.provisional),
    })
    send(res, result.ok ? 200 : 400, result)
    return true
  }

  if (path === '/api/life/mounts/remove' && method === 'POST') {
    const body = await readJson(req)
    const result = removeMount(String(body?.rel ?? ''))
    send(res, result.ok ? 200 : 400, result)
    return true
  }

  if (path === '/api/life/mount-options' && method === 'GET') {
    send(res, 200, { options: mountCandidates() })
    return true
  }

  if (path === '/api/life/sources' && method === 'GET') {
    send(res, 200, { kinds: listSourceKinds() })
    return true
  }

  // A SABLONOK. Egy frissen telepitett Marveen igy nem ures kepernyovel fogad:
  // a felhasznalo valaszt egy kesz szerkezetet helyorzo nevekkel, aztan atirja
  // magara. (Boss kerese, 2026-08-21.)
  if (path === '/api/life/templates' && method === 'GET') {
    // A `fresh` azt mondja meg a feluletnek, erdemes-e figyelmeztetni: ha mar
    // van MENTETT beallitas, a sablon felulirna a sajat neveket. A mentes
    // letere kerdezunk, nem a szemelyek szamara -- egy friss telepites is kap
    // egy helyorzo gazdat, es azt nincs mit felteni.
    send(res, 200, { templates: listLifeTemplates(APP_LANG), fresh: !lifeConfigExists() })
    return true
  }

  if (path === '/api/life/templates/apply' && method === 'POST') {
    const body = await readJson(req)
    const tpl = findLifeTemplate(String(body?.id ?? ''))
    if (!tpl) { send(res, 400, { message: 'Nincs ilyen sablon.' }); return true }
    const cfg = tpl.build(APP_LANG)
    // SZANDEKOSAN nem irunk lemezre, es alapbol NEM irjuk felul a meglevo
    // beallitast sem: a sablon csak egy JAVASLAT, amit a felulet elonezetben
    // mutat. Menteni a szokasos `POST /api/life/config` fog.
    if (body?.save === true) {
      if (lifeConfigExists() && body?.overwrite !== true) {
        send(res, 409, {
          message: 'Már van beállított életfád. Ha a sablonnal akarod felülírni, '
            + 'erősítsd meg — a mostani személyek és cégek beállítása elveszik. '
            + '(A lemezen lévő mappákhoz és fájlokhoz ez nem nyúl.)',
        })
        return true
      }
      saveLifeConfig(cfg)
    }
    send(res, 200, { config: cfg, saved: body?.save === true, status: lifeTreeStatus(cfg) })
    return true
  }

  if (path === '/api/life/inbox' && method === 'GET') {
    send(res, 200, { count: inboxCount() })
    return true
  }

  // A BEERKEZO-LANC (specifikacio 22-23.).
  //
  // Negy vegpont, kulon felelosseggel: MI VAR (es ha semmi, MIERT), HOVA mehet
  // (a lanc kovetkezo lepese), MI TORTENNE (elonezet), es a vegrehajtas. Az
  // elonezet szandekosan kulon all: a lemezre iro lepes elott latni kell, mi
  // all meg es miert.
  if (path === '/api/life/inbox/items' && method === 'GET') {
    send(res, 200, inboxStatus(uiLang(url)))
    return true
  }

  if (path === '/api/life/inbox/chain' && method === 'GET') {
    send(res, 200, inboxChainStep(url.searchParams.get('rel') || '', uiLang(url)))
    return true
  }

  if (path === '/api/life/inbox/preview' && method === 'POST') {
    const body = await readJson(req)
    const names = Array.isArray(body?.names) ? body.names.map((n: any) => String(n)) : []
    send(res, 200, inboxPreview(names, String(body?.target ?? ''), uiLang(url)))
    return true
  }

  if (path === '/api/life/inbox/file' && method === 'POST') {
    const body = await readJson(req)
    const names = Array.isArray(body?.names) ? body.names.map((n: any) => String(n)) : []
    if (!names.length) {
      send(res, 400, { error: 'no_items', message: 'Nem jelöltél ki tételt.' })
      return true
    }
    const target = String(body?.target ?? '')
    if (!target) {
      // A gazdat NEM talaljuk ki (23. pont, 1. szabaly): cel nelkul megallunk.
      send(res, 400, { error: 'no_target', message: 'Előbb válaszd ki, hova kerüljön – nem találom ki helyetted.' })
      return true
    }
    send(res, 200, inboxFile(names, target, uiLang(url)))
    return true
  }

  // AI-JAVASLAT (kartya #204). A meglevo lanc (fent) MARAD -- ez csak egy
  // MASIK modon ad celt: a felhasznalo helyett eloszor a szerver probal
  // tulajdonost/kategoriat/datumot/nevet javasolni, bizonytalansaggal. A
  // tenyleges athelyezes MINDIG a fenti `inboxFile()`-ra epul, ugyanazokkal a
  // biztonsagi szabalyokkal (soha nem ir felul, hitelesito adatot kiszuri).
  if (path === '/api/life/inbox/analyze' && method === 'POST') {
    const body = await readJson(req)
    const names = Array.isArray(body?.names) ? body.names.map((n: any) => String(n)) : undefined
    // Async: a scanned PDF needs a multi-second OCR, the dashboard must not
    // freeze on it (card 56530b08). The prefetched texts stay in the
    // analyzer's cache for the AI step; they are not sent to the browser.
    const { prefetched: _prefetched, ...result } = await analyzeInboxAsync(names, uiLang(url))
    send(res, 200, result)
    return true
  }

  // AI-JAVASLAT, 2. kor (kartya 56530b08): a szabaly-alapu javaslat fole a
  // Claude (vagy ha nincs, a helyi modell) olvassa el az iratot. Lassu (akar egy
  // perc), ezert KULON hivas: a felulet elobb a gyors javaslatot mutatja, es ezt
  // utana kero. Semmit nem mozgat -- az athelyezes tovabbra is a /place.
  if (path === '/api/life/inbox/ai-suggest' && method === 'POST') {
    const body = await readJson(req)
    const names = Array.isArray(body?.names) ? body.names.map((n: any) => String(n)) : undefined
    const lang = uiLang(url)
    const { prefetched, ...result } = await analyzeInboxAsync(names, lang)
    if (result.reason !== 'ok') {
      send(res, 200, { ...result, ai: { engine: 'none', model: '', note: '' } })
      return true
    }
    const config = loadLifeConfig()
    const run = await classifyWithAi(
      result.suggestions.map((s) => ({ suggestion: s, prefetched: prefetched.get(s.name) })),
      config, result.knownFolders, lang,
    )
    const byName = new Map(run.results.map((r) => [r.name, r]))
    const suggestions = result.suggestions.map((s) => {
      const r = byName.get(s.name)
      return r ? mergeAiIntoSuggestion(s, r, run, config) : s
    })
    send(res, 200, { ...result, suggestions, ai: { engine: run.engine, model: run.model, note: run.note, pending: run.pending || [] } })
    return true
  }

  if (path === '/api/life/inbox/place' && method === 'POST') {
    const body = await readJson(req)
    const name = String(body?.name ?? '').trim()
    const targetRel = String(body?.targetRel ?? body?.target ?? '').trim()
    if (!name) {
      send(res, 400, { error: 'no_item', message: 'Nem jelöltél ki tételt.' })
      return true
    }
    if (!targetRel) {
      // A gazdat itt SEM talaljuk ki: az AI-javaslat csak ajanlat, a vegso
      // celt a felhasznalonak kell megerositenie.
      send(res, 400, { error: 'no_target', message: 'Előbb válaszd ki, hova kerüljön – nem találom ki helyetted.' })
      return true
    }
    const lang = uiLang(url)
    const result = inboxFile([name], targetRel, lang)
    if (!result.moved.length) {
      send(res, 200, { ok: false, rel: '', message: result.failed[0]?.message || result.message })
      return true
    }
    let rel = result.moved[0].rel
    let message = result.message
    const newBase = String(body?.newName ?? '').trim()
    if (newBase) {
      const ext = pathExtname(pathBasename(name))
      const rn = renameLife(rel, safeLifeName(newBase) + ext, lang)
      if (rn.ok) { rel = rn.rel; message = rn.message }
      else message = `${message} ${rn.message}`
    }
    send(res, 200, { ok: true, rel, message })
    return true
  }

  // ARCFELISMERES-BETANITAS (kartya #204). A felhasznalo egy mar beerkezett
  // BEERKEZO tetelt jelol ki (fenykep) es kivalasztja, kihez tartozik -- ez
  // kerul a helyi arcfelismero galeriajaba (`store/face-gallery/<personId>`),
  // hogy legkozelebb magatol felismerje.
  if (path === '/api/life/inbox/enroll-face' && method === 'POST') {
    const body = await readJson(req)
    const lang = uiLang(url)
    const name = String(body?.name ?? '').trim()
    const personId = String(body?.personId ?? '').trim()
    if (!name) {
      send(res, 400, { error: 'no_item', message: T(lang, 'Nem jelöltél ki tételt.', 'You did not select an item.') })
      return true
    }
    if (!personId) {
      send(res, 400, { error: 'no_person', message: T(lang, 'Előbb válaszd ki, kihez tartozik a fotó.', 'First choose who the photo belongs to.') })
      return true
    }
    const config = loadLifeConfig()
    if (!config.persons.some((p) => p.id === personId)) {
      send(res, 400, { error: 'unknown_person', message: T(lang, 'Nincs ilyen személy a fában.', 'No such person in the tree.') })
      return true
    }
    const dir = inboxDir(lang)
    if (!dir) {
      send(res, 400, { error: 'no_tree', message: T(lang, 'Az életfa gyökere még nincs beállítva.', 'The life-tree root is not set up yet.') })
      return true
    }
    const absPhotoPath = pathJoin(dir, pathBasename(name))
    if (!existsSync(absPhotoPath)) {
      send(res, 400, { error: 'not_found', message: T(lang, 'Ez a tétel már nincs a BEÉRKEZŐ-ben.', 'This item is no longer in the INBOX.') })
      return true
    }
    const result = enrollFace(absPhotoPath, personId, lang)
    send(res, result.ok ? 200 : 400, result)
    return true
  }

  // CELMAPPA LETREHOZASA A HELYSZINEN (kartya #246). A "hova kerulne"
  // javaslat gyakran egy MEG NEM LETEZO mappara mutat (pl. a szemely alatt
  // meg soha nem volt "Hatóságok/Németország/Jobcenter" alag). Korabban
  // ilyenkor a felhasznalonak at kellett mennie az Eletfa oldalra, ott
  // kezzel letrehozni, majd vissza a Beerkezobe -- ez a vegpont ugyanezt EGY
  // kattintassal, a Beerkezoben, teszi lehetove. A letrehozas KIZAROLAG erre
  // a vegpontra erkezo, kifejezett kattintasra tortenik -- az elemzes
  // (`/inbox/analyze`) maga SOSE hoz letre semmit, csak javasol.
  if (path === '/api/life/inbox/create-target-folder' && method === 'POST') {
    const body = await readJson(req)
    const lang = uiLang(url)
    const rel = String(body?.rel ?? '').trim()
    if (!rel) {
      send(res, 400, { ok: false, rel: '', message: T(lang, 'Nem adtál meg célmappát.', 'You did not give a target folder.') })
      return true
    }
    const blocked = writeBlockReason(rel)
    if (blocked) {
      send(res, 400, { ok: false, rel: '', code: 'git_repo', message: blocked })
      return true
    }
    const result = mkdirLifePath(rel, lang)
    send(res, result.ok ? 200 : 400, result)
    return true
  }

  return false
}

/**
 * A beerkezo beallitas ellenorzese.
 *
 * Visszaad egy hasznalhato konfiguraciot, VAGY egy magyar mondatot arrol, mi a
 * baj vele. Azert szigoru, mert ezekbol a nevekbol MAPPAK lesznek a lemezen: a
 * hibat itt olcso megfogni, egy felig letrehozott fanal mar nem az.
 */
function parseConfig(body: any, lang: string = APP_LANG): LifeConfig | string {
  if (!body || typeof body !== 'object') return 'Nem érkezett adat.'
  const personsIn = Array.isArray(body.persons) ? body.persons : null
  const companiesIn = Array.isArray(body.companies) ? body.companies : []
  if (!personsIn || !personsIn.length) return 'Legalább egy személynek szerepelnie kell a fában.'

  const persons: LifePerson[] = []
  for (const p of personsIn) {
    const name = String(p?.name ?? '').trim()
    if (!name) return 'Egy személynél üresen maradt a név.'
    if (safeLifeName(name) === '_') return `Ez a név nem használható mappanévnek: ${name}`
    const countries = toNameList(p?.countries)
    persons.push({
      id: String(p?.id ?? '').trim() || safeLifeName(name).toLowerCase().replace(/\s+/g, '-'),
      name,
      role: p?.role === 'owner' ? 'owner' : 'person',
      countries,
      // Melyik kategoriak bomlanak orszagra. A `MEDIA_COUNTRY_KEY` is
      // valaszthato: a Boss keresere (2026-08-21) a fotok es a videok is
      // orszagonkent allnak, ha valaki tobb orszagban elt.
      countrySplit: toKeyList(p?.countrySplit, [...PERSON_CATEGORIES, MEDIA_COUNTRY_KEY], defaultCountrySplit()),
      mediaKinds: toKeyList(p?.mediaKinds, MEDIA_KINDS, defaultMediaKinds()),
      mediaGroups: toNameList(p?.mediaGroups),
      projects: toProjects(p?.projects),
      // Gondviselo (kartya #204): masik szemely id-jara mutathat, "gyerek
      // mindig az anya alá". A hivatkozas ervenyesseget (letezik-e, nincs-e
      // kor) a `sanitizeCustodianIds()` ellenorzi LENT, amikor mar minden
      // szemely id-je ismert.
      custodianId: String(p?.custodianId ?? '').trim() || undefined,
    })
  }
  // Pontosan EGY gazda kell: a gazda kapja a teljes (12 kategoriás) agat, es
  // az o neve alatt all a munka/projektek. Ha ketto lenne, nem tudnank
  // eldonteni, kie a "Munka" -- ha egy sem, senkie.
  const owners = persons.filter((p) => p.role === 'owner')
  if (owners.length !== 1) return 'Pontosan egy személy legyen a gazda (a saját ágad). Jelöld meg, melyik az.'
  sanitizeCustodianIds(persons)

  const companies: LifeCompany[] = []
  for (const c of companiesIn) {
    const name = String(c?.name ?? '').trim()
    if (!name) return 'Egy cégnél üresen maradt a név.'
    if (safeLifeName(name) === '_') return `Ez a cégnév nem használható mappanévnek: ${name}`
    companies.push({
      id: String(c?.id ?? '').trim() || safeLifeName(name).toLowerCase().replace(/\s+/g, '-'),
      name,
      countries: toNameList(c?.countries),
      countrySplit: toKeyList(c?.countrySplit, COMPANY_CATEGORIES, defaultCompanyCountrySplit()),
    })
  }

  // Azonos mappanev ket szemelynek: a masodik beleirna az elso mappajaba.
  const seen = new Set<string>()
  for (const n of [...persons.map((p) => p.name), ...companies.map((c) => c.name)]) {
    const key = safeLifeName(n).toLowerCase()
    if (seen.has(key)) return `Ez a név kétszer szerepel: ${n}. Minden személy és cég neve különbözzön.`
    seen.add(key)
  }

  // The persons' common folder ("Család"). Empty = the persons stay at the
  // root. It becomes a real folder at the root, so it may not take the name
  // of a fixed branch (Cégek, Archív, ...) or of a person/company -- the
  // persons would land inside that branch.
  const groupRaw = String(body.personsGroup ?? '').trim()
  let personsGroup = ''
  if (groupRaw) {
    if (/[\\/]/.test(groupRaw)) return T(lang, 'A közös mappa neve nem tartalmazhat per-jelet.', 'The common folder name cannot contain a slash.')
    personsGroup = safeLifeName(groupRaw)
    if (personsGroup === '_') return T(lang, `Ez a név nem használható mappanévnek: ${groupRaw}`, `This name cannot be used as a folder name: ${groupRaw}`)
    const fixed = ['companies', 'knowledge', 'digital', 'inbox', 'shared', 'archive', 'system']
      .flatMap((k) => [lifeName(k, APP_LANG), lifeName(k, lang)])
      .map((x) => x.toLowerCase())
    if (fixed.includes(personsGroup.toLowerCase()) || seen.has(personsGroup.toLowerCase())) {
      return T(lang,
        `A közös mappa neve nem lehet „${personsGroup}", mert már van ilyen nevű ág vagy személy. Válassz másikat, például „Család".`,
        `The common folder cannot be called "${personsGroup}": a branch or person already has that name. Pick another, for example "Family".`)
    }
  }

  return { persons, companies, personsGroup }
}

/**
 * KULCSLISTA szures: csak az ismert kulcsok maradnak.
 *
 * Miert nem engedjuk at, ami jon? Mert ezekbol a kulcsokbol a `lifeName()`
 * mappanevet csinal -- egy ismeretlen kulcsbol `countrysplit` nevu mappa lenne
 * a fa kozepen. Ha a felulet EGYALTALAN nem kuldte a mezot (regi kliens vagy
 * regi mentett fajl), az alapertelmezes lep eletbe; ha ures tombot kuldott, az
 * SZANDEKOS "egyiket sem", es azt tiszteletben tartjuk.
 */
function toKeyList(v: any, allowed: readonly string[], fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  const out: string[] = []
  for (const item of v) {
    const s = String(item ?? '').trim()
    if (allowed.includes(s) && !out.includes(s)) out.push(s)
  }
  return out
}

/** Szemelyes projektek. A `development` agat (GIT_REPOS) kulon kell kerni. */
function toProjects(v: any): LifeProject[] {
  if (!Array.isArray(v)) return []
  const out: LifeProject[] = []
  for (const item of v) {
    const name = String(item?.name ?? '').trim()
    if (!name || safeLifeName(name) === '_') continue
    if (out.some((o) => safeLifeName(o.name).toLowerCase() === safeLifeName(name).toLowerCase())) continue
    out.push({
      id: String(item?.id ?? '').trim() || newLifeId('project'),
      name,
      development: item?.development !== false,
    })
  }
  return out
}

function toNameList(v: any): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    const s = String(item ?? '').trim()
    if (s && safeLifeName(s) !== '_' && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * Egy fa-beli utrol megmondja, hogy git-tarolo alatti repo-e, es ha igen,
 * melyik fiok melyik repoja -- plusz a valodi lemezes utat.
 *
 * Azert kell, mert a zar a LEMEZEN all (push-cim + hook), a felulet viszont a
 * fa nyelven beszel. A ketto kozott itt az egyetlen forditasi pont: ha tobb
 * helyen forditanank, elobb-utobb ketfele allna.
 */
function gitTarhelyHely(rel: string): { account: string; repo: string; abs: string } | null {
  const root = depotRoot()
  if (!root) return null
  const eleje = storageKindRoot('git').replace(/\\/g, '/') + '/'
  let tiszta = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  // A BEKOTES FELOLDASA. A fa "Cegek/.../GIT_REPOS/docs"-ot mond, a zar viszont
  // a lemezen all. A leghosszabb illeszkedo bekotes nyer: egy melyebb bekotes
  // felulirhat egy sekelyebbet.
  if (!tiszta.startsWith(eleje)) {
    const talalat = listMounts()
      .map((m) => ({ m, r: String(m.rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') }))
      .filter((x) => x.r && (tiszta === x.r || tiszta.startsWith(x.r + '/')))
      .sort((a, b) => b.r.length - a.r.length)[0]
    if (talalat) {
      const maradek = tiszta.slice(talalat.r.length).replace(/^\/+/, '')
      const cel = String(talalat.m.target || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      tiszta = maradek ? cel + '/' + maradek : cel
    }
  }
  if (!tiszta.startsWith(eleje)) return null
  const reszek = tiszta.slice(eleje.length).split('/').filter(Boolean)
  // Pontosan ket szint kell: <fiok>/<repo>. A repon BELUL nincs mit zarni.
  if (reszek.length !== 2) return null
  return { account: reszek[0], repo: reszek[1], abs: pathJoin(root, storageKindRoot('git'), reszek[0], reszek[1]) }
}
