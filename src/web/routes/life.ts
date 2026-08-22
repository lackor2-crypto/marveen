// AZ EGYSEGES ELETFA es a Marvin INTEZO vegpontjai.
//
//   GET  /api/life/status     -- all-e mar a fa, mi hianyzik beloele
//   POST /api/life/ensure     -- a hianyzo mappak letrehozasa (SOSE torol)
//   GET  /api/life/config     -- kik/mely cegek szerepelnek a faban
//   POST /api/life/config     -- ezek szerkesztese
//   GET  /api/life/list       -- egy mappa tartalma, forrasjelvenyekkel
//   GET  /api/life/info       -- a reszletes informacios panel egy tetelrol
//   GET  /api/life/search     -- nev szerinti kereses a fan belul
//   POST /api/life/mkdir      -- uj mappa
//   POST /api/life/move       -- athelyezes a fan belul
//   GET  /api/life/repo-status -- egy git-repo allapota emberi mondatban
//   POST /api/life/repo-delete -- egy git-repo mappa torlese (meressel)
//   GET  /api/life/physical   -- papir peldanyok listaja ("papir-terkep")
//   POST /api/life/physical   -- egy tetel papir-adatanak rogzitese
//   GET  /api/life/mounts     -- mely fa-pontok mutatnak masik helyre
//   POST /api/life/mounts     -- uj bekotes (Drive-mappa / Fotok / git repo)
//   POST /api/life/mounts/remove -- bekotes megszuntetese (a fajlok maradnak)
//   GET  /api/life/mount-options -- mit lehet bekotni (magatol osszeszedve)
//   GET  /api/life/sources    -- a jelvenyek jelmagyarazata (forrasfajtak)
//   GET  /api/life/inbox      -- hany irat var a BEERKEZO-ben
//
// Minden hibauzenet MAGYAR MONDAT, es azt mondja meg, mit tegyen a
// felhasznalo -- nem azt, hogy melyik fuggveny hasalt el.
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  ensureLifeTree, lifeTreeStatus, loadLifeConfig, saveLifeConfig,
  inboxCount, safeLifeName, newLifeId, lifeName, lifeConfigExists,
  PERSON_CATEGORIES, COMPANY_CATEGORIES, MEDIA_COUNTRY_KEY, MEDIA_KINDS,
  defaultCountrySplit, defaultCompanyCountrySplit, defaultMediaKinds, defaultMediaGroups,
  type LifeConfig, type LifePerson, type LifeCompany, type LifeProject,
} from '../../life-tree.js'
import { listLifeTemplates, findLifeTemplate } from '../../life-templates.js'
import { lifeHints } from '../../life-hints.js'
import {
  lockRepoReadOnly, unlockRepoReadOnly, isRepoReadOnly, setReadOnlyException,
} from '../../git-accounts.js'
import { depotRoot } from '../../depot.js'
import { storageKindRoot } from '../../storages.js'
import { join as pathJoin } from 'node:path'
import { APP_LANG } from '../../config.js'
import {
  listLife, lifeInfo, moveLife, mkdirLife, renameLife, trashLife, searchLife, explorerRoot,
} from '../../life-explorer.js'
import { listSourceKinds } from '../../life-sources.js'
import { listMounts, addMount, removeMount } from '../../life-mounts.js'
import { repoAt, reposInside, repoStatus, deleteRepo, writeBlockReason } from '../../git-guard.js'
import { mountCandidates } from '../../life-mount-candidates.js'
import { getPhysical, setPhysical, listPhysical } from '../../life-documents.js'
import type { RouteContext } from './types.js'

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

export async function tryHandleLife(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (!path.startsWith('/api/life/')) return false

  // Depo nelkul egyetlen vegpontnak sincs ertelme -- es ez nem hiba, hanem egy
  // meg el nem vegzett beallitas. Ezert mondjuk meg, HOVA menjen erte.
  if (!explorerRoot() && path !== '/api/life/sources') {
    send(res, 400, {
      error: 'no_depot',
      message: 'Még nincs beállítva, hol tárolja a Marveen a fájljaidat. Nyisd meg a Depó oldalt, és válaszd ki a mappát (például D:\\Marveen).',
    })
    return true
  }

  if (path === '/api/life/status' && method === 'GET') {
    send(res, 200, lifeTreeStatus())
    return true
  }

  if (path === '/api/life/ensure' && method === 'POST') {
    try {
      const result = ensureLifeTree()
      logger.info({ created: result.created.length }, '[eletfa] fa letrehozva/kiegeszitve')
      send(res, 200, {
        ...result,
        ok: true,
        message: result.created.length
          ? `Kész: ${result.created.length} mappa jött létre.`
          : 'A könyvtárszerkezet már teljes volt, nem kellett létrehozni semmit.',
      })
    } catch (err: any) {
      send(res, 500, { error: 'failed', message: `Nem sikerült létrehozni a mappákat: ${String(err?.message || err)}` })
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
    const parsed = parseConfig(body)
    if (typeof parsed === 'string') {
      send(res, 400, { error: 'bad_config', message: parsed })
      return true
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
    send(res, 200, listLife(rel, { deep }))
    return true
  }

  if (path === '/api/life/info' && method === 'GET') {
    const rel = url.searchParams.get('path') || ''
    const info: any = lifeInfo(rel)
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
    send(res, 200, info)
    return true
  }

  if (path === '/api/life/search' && method === 'GET') {
    const rel = url.searchParams.get('path') || ''
    const q = url.searchParams.get('q') || ''
    send(res, 200, searchLife(rel, q))
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
    const result = mkdirLife(String(body?.parent ?? ''), String(body?.name ?? ''))
    send(res, result.ok ? 200 : 400, result)
    return true
  }

  if (path === '/api/life/move' && method === 'POST') {
    const body = await readJson(req)
    // MINDKET veget nezzuk: a repobol kimozgatni ugyanugy elrontja a
    // verziokovetest, mint belerakni egy oda nem tartozo fajlt.
    const blocked = writeBlockReason(String(body?.from ?? '')) || writeBlockReason(String(body?.to ?? ''))
    if (blocked) {
      send(res, 400, { ok: false, rel: '', code: 'git_repo', message: blocked })
      return true
    }
    const result = moveLife(String(body?.from ?? ''), String(body?.to ?? ''))
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
  const bekotesOrzo = (rel: string): { code: string; message: string } | null => {
    const alatta = listMounts().filter((m) => m.rel === rel || m.rel.startsWith(rel + '/'))
    if (alatta.length) {
      return {
        code: 'has_mounts',
        message: `Ebben a mappában ${alatta.length === 1 ? 'egy bekötés van' : alatta.length + ' bekötés van'}`
          + ` (pl. ${alatta[0].rel}). Előbb szüntesd meg őket a „Mit mutasson ez a mappa?" résznél — `
          + 'különben a bekötés egy nem létező helyre mutatna tovább.',
      }
    }
    const celok = listMounts().filter((m) => m.target === rel || m.target.startsWith(rel + '/'))
    if (celok.length) {
      return {
        code: 'is_target',
        message: `Erre a mappára ${celok.length === 1 ? 'egy bekötés mutat' : celok.length + ' bekötés mutat'}`
          + ` (innen látszik: ${celok[0].rel}). Ha elmozdítom, ott üres hely maradna. `
          + 'Előbb szüntesd meg a bekötést, aztán mozdítsd el.',
      }
    }
    return null
  }

  if (path === '/api/life/rename' && method === 'POST') {
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
      send(res, 400, {
        ok: false, rel: '', code: 'mounted',
        message: 'Ez a mappa be van kötve máshova. Előbb szüntesd meg a bekötést, nevezd át, aztán kösd be újra — '
          + 'a bekötés az útvonalra szól, új néven nem találna rá.',
      })
      return true
    }
    const baj = bekotesOrzo(rel)
    if (baj) { send(res, 400, { ok: false, rel: '', ...baj }); return true }
    send(res, 200, renameLife(rel, String(body?.name ?? '')))
    return true
  }

  if (path === '/api/life/trash' && method === 'POST') {
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
        message: 'Ez a mappa csak MUTAT egy másik helyre, saját tartalma nincs. Ha nem kell itt, '
          + 'a „Mit mutasson ez a mappa?" résznél szüntesd meg a bekötést — a fájlok a helyükön maradnak.',
      })
      return true
    }
    // GIT-REPO: a klon eldobhato, a benne levo, fel nem toltott munka nem. Erre
    // van sajat, MERO vegpont -- oda kuldjuk, nem kukazunk vaktaban.
    const at = repoAt(rel)
    if (at && at.isRoot) {
      send(res, 400, {
        ok: false, rel: '', code: 'repo',
        message: 'Ez egy git-repó. A törléséhez a repó saját gombját használd — az előbb megnézi, '
          + 'van-e benne fel nem töltött munka.',
      })
      return true
    }
    const baj = bekotesOrzo(rel)
    if (baj) { send(res, 400, { ok: false, rel: '', ...baj }); return true }
    // Egy mappa a BENNE levo repokat is magaval vinne. A repoknak sajat, MERO
    // torlesuk van (megnezi a fel nem toltott munkat) -- oda kuldjuk.
    const benne = reposInside(rel)
    if (benne.length) {
      send(res, 400, {
        ok: false, rel: '', code: 'has_repos',
        message: `Ebben a mappában ${benne.length === 1 ? 'egy git-repó van' : benne.length + ' git-repó van'}`
          + ` (pl. ${benne[0]}). Ezeket a saját törlő gombjukkal szüntesd meg — az előbb megnézi, `
          + 'van-e bennük fel nem töltött munka. Utána ez a mappa is mehet a Kukába.',
      })
      return true
    }
    send(res, 200, trashLife(rel))
    return true
  }

  // 2. SZINT: a repo-mappa torleset NEM tiltjuk -- megmerjuk. Egy klon
  // eldobhato; a veszely a benne levo, fel nem toltott munka.
  // 3. SZINT: ha bekotes mutat ra, azt ajanljuk ELSOKENT -- semmit nem torol.
  // Mit szoktak az egyes mappakba tenni -- MAPPANEV szerint, hogy a felulet
  // barhol (lista, oldalsav, valaszto) ugyanabbol az egy forrasbol dolgozzon.
  if (path === '/api/life/hints' && method === 'GET') {
    const out: Record<string, string> = {}
    for (const [key, szoveg] of Object.entries(lifeHints())) {
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
    send(res, 200, { mounts: listMounts() })
    return true
  }

  if (path === '/api/life/mounts' && method === 'POST') {
    const body = await readJson(req)
    const result = addMount({
      rel: String(body?.rel ?? ''),
      target: String(body?.target ?? ''),
      kind: String(body?.kind ?? 'local'),
      label: String(body?.label ?? ''),
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

  return false
}

/**
 * A beerkezo beallitas ellenorzese.
 *
 * Visszaad egy hasznalhato konfiguraciot, VAGY egy magyar mondatot arrol, mi a
 * baj vele. Azert szigoru, mert ezekbol a nevekbol MAPPAK lesznek a lemezen: a
 * hibat itt olcso megfogni, egy felig letrehozott fanal mar nem az.
 */
function parseConfig(body: any): LifeConfig | string {
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
    })
  }
  // Pontosan EGY gazda kell: a gazda kapja a teljes (12 kategoriás) agat, es
  // az o neve alatt all a munka/projektek. Ha ketto lenne, nem tudnank
  // eldonteni, kie a "Munka" -- ha egy sem, senkie.
  const owners = persons.filter((p) => p.role === 'owner')
  if (owners.length !== 1) return 'Pontosan egy személy legyen a gazda (a saját ágad). Jelöld meg, melyik az.'

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

  return { persons, companies }
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
