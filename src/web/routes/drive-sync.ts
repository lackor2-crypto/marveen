// Drive-fajlok a SAJAT gepen + szinkronizalas.
//
// Boss, 2026-08-15: "csinald meg. legyen a file a sajat szamitogepemen. es
// csinalj egy szinkronizalasi lehetoseget."
//
// Eddig a Drive-fajlok csak ATFOLYTAK a Marveenen: a Google-tol egyenesen a
// bongeszobe mentek, a gepre semmi nem kerult. Ez itt az uj kepesseg: kijelolsz
// egy Drive-mappat, es a Marveen letolti a depoba, majd idorol idore
// ellenorzi, valtozott-e valami.
//
// MIT TUD ES MIT NEM. A kapcsolat KETIRANYU, de a torles SZANDEKOSAN nem az --
// Boss, 2026-08-15:
//   "en szeretnem ha amit a gepemen szerkesztek az felmenne a drive ra! vagy ha
//    a gepemen uj filet csinalok az is felmenne! ha a gepemen torlok valamit az
//    fent is torlodne. es ami a driv on fent torlodik az nalam megmarad. az
//    helyes. mert ha valaki feltori a drivomat akkor a gepemrol ne tudjon
//    torolni."
//
//   - Drive -> gep:  uj/modosult fajl LEJON.
//   - gep -> Drive:  uj/modosult fajl FELMEGY.
//     A Google-natív fajlok (Doc/Sheet/Slide) is: azok exportkent (.docx/.xlsx/
//     .pptx) jonnek le, es UGYANARRA a fajlazonositora mennek vissza, az export
//     content-type-javal -- a Drive visszakonvertalja, tehat Doc marad Doc.
//     Kivetel a Rajz es az Apps Script: azokat a Drive nem veszi vissza (merve:
//     400), ott a helyi modositas nem tud felmenni, es ezt ki is irjuk.
//   - gepen torolsz: fent is torlodik -- de a KUKABA, nem veglegesen.
//   - Drive-on torlodik: nalad MEGMARAD. Ez az aszimmetria a lenyeg: egy
//     feltort Drive nem tudja letorolni a gepedet.
//
// A TORLES-ATVITEL VESZELYES, ezert harom fek all elotte (lasd `deletionsUp`):
//   1. Ha a helyi mappa nem erheto el (lecsatolt lemez), fel sem megyunk.
//   2. Ha a bejaras csonkolt, a felmeno ag KIMARAD -- csonka kepbol nem szabad
//      "ez mar nincs meg" kovetkeztetest levonni.
//   3. Ha a torlendok aranya atlepi a vészfék-küszöböt, EGY sem megy fel.
// Fék nélkül a kerest funkcio a sajat mentesedet torolne le az elso hibanal.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { PROJECT_ROOT } from '../../config.js'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { depotAccountDir, depotHealth, depotRoot, DEPOT_DRIVE, DEPOT_SYSTEM_ROOT } from '../../depot.js'
import { resolveLifePath } from '../../life-explorer.js'
import { driveDownloadPlan, driveUploadMime, isSafeFolderId } from './drive-browser.js'
import {
  recordSyncFailure, loadSyncFailures, clearSyncFailures, failuresAsText, syncFailureRuns,
  type SyncFailurePhase,
} from '../../drive-sync-failures.js'
import {
  noteExternalScan, recordExternalChange, externalGuardEnabled, loadExternalChanges,
  clearExternalChanges, setExternalGuardEnabled, externalSummaryText,
} from '../../external-delete-guard.js'
import type { RouteContext } from './types.js'

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'drive-sync.json')
/**
 * Egy futasban legfeljebb ennyi mappat jarunk be -- vegtelen melyseg ellen.
 *
 * MERVE 2026-08-16, mind a 10 csatolt fiokon (`files.list`, `trashed=false`):
 * a legnagyobb 293 mappa (nyalomapuncidma), utana 75 (usalackor) es 73
 * (lackor2). A regi 500-as hatart tehat EGYIK Drive sem erte el -- vagyis a
 * lackor2-n latott "reszleges" uzenet NEM a korlatbol jott (a kepernyo hazudott
 * rola, lasd `csonkoltSzoveg`), hanem egy ki nem olvashato mappabol.
 * A hatar megis felmegy: nem a mai meret a kerdes, hanem hogy a novekedes ne
 * fusson bele, es kozben maradjon fek egy elszabadult bejaras ellen.
 */
const MAX_FOLDERS = 5_000
/**
 * Egy futasban legfeljebb ennyi fajlt hozunk le.
 *
 * MERVE 2026-08-16: a legnagyobb Drive 3179 fajl (lackor2), utana 2178
 * (nyalomapuncidma). A regi 5000-es hatar tehat 64%-on allt -- meg nem fajt, de
 * mar lathatoan a kozeleben jart. Ennel a hatarnal az egesz felmeno ag is
 * kimarad (`csonkolt`), vagyis eleg lett volna par ezer uj fajl ahhoz, hogy a
 * szinkron csendben FELIG mukodjon.
 */
const MAX_FILES = 50_000
/**
 * Egy futasban legfeljebb ennyi fajlt kuldunk FEL.
 *
 * KOLTSEGVETES, NEM KORLAT. 2026-08-28-ig ez a szam KETTOT jelentett egyszerre:
 * ennyi fajlt kuldtunk fel, ES a helyi bejaras is ennel allt meg (ez volt a
 * `walkLocalFiles` alapertelmezese). A bejaras csonkolasa viszont az EGESZ
 * felmeno agat kiloki ("tul sok helyi fajl -- a feltoltes es a torles
 * kimaradt"), vagyis 2000 fajl folott a mentes CSENDBEN abbahagyta a
 * feltoltest. A mentendo raktar-ag MERVE 9356 fajl: ott ez el sem indult volna.
 *
 * Mostantol a ketto KULON all: a bejaras a `MAX_LOCAL_FILES`-ig megy (a helyi
 * kep TELJES marad, ezert a torles-dontesek is biztonsagosak maradnak), ebbol
 * pedig futasonkent ennyi fajl megy fel, a tobbi a kovetkezo futasra. A
 * `drive-mentes` kartya ejjel 3-kor magatol indit, tehat ez tenyleg folytatodik
 * -- es a "meg N var" szam ki is irodik. A csend a hiba, nem a lassusag.
 */
export const MAX_UPLOADS = 2_000
/**
 * Egy futasban legfeljebb ennyi HELYI fajlt JARUNK BE.
 *
 * Nem feltoltesi korlat, hanem a "latom-e az egeszet" hatara. A torles-atvitel
 * CSAK teljes helyi kepbol dolgozhat: egy csonka listaban minden hianyzo fajl
 * ugy nezne ki, mintha toroltek volna -- es a "hu" szinkron letorolne oket a
 * Drive-on is, vagyis pont a mentest. MERVE 2026-08-28: a mentendo ag 9356
 * fajl, a teljes raktar a Rendszer nelkul ~9,4 ezer; a hatar husszoros
 * tartalekkal all, de nem vegtelen.
 */
export const MAX_LOCAL_FILES = 200_000
/**
 * Ennel nagyobb fajlt nem kuldunk fel egy darabban.
 *
 * A feltoltes EGY keresben megy, folytatas nelkul: ha a kapcsolat megszakad,
 * a fajl elolrol kezdodik. Ez nem adatvesztes -- a kovetkezo futas ujraprobalja
 * --, de elpazarolt ido, ezert van felso hatar. A darabolt (resumable)
 * feltoltes kulon munka lenne. Amig nincs meg, inkabb KIMONDJUK, hogy egy fajl
 * kimaradt, mint hogy csendben elhasaljon.
 *
 * 2026-08-29: 100 -> 600 MB (a tulajdonos kerte). MERVE ekkor: a Rendszer
 * mappan kivul PONTOSAN 3 fajl esett a ket hatar koze -- egy 540 MB-os MT4
 * naplo, egy 149 MB-os teszt-zip es a 133 MB-os GOLD1.hst --, vagyis 822 MB,
 * ami eddig minden mentesbol kimaradt. A 600 MB folotti fajlok mind a
 * `Rendszer/Tarolok` alatt vannak, azt pedig a teljes-raktar mentes amugy is
 * kihagyja. A legnagyobb beengedett fajl a mert ~14 MB/perc mellett ~40 perc
 * egy keresben; idokorlat nem vagja el, a keresekre nem allitunk timeoutot.
 */
const MAX_UPLOAD_BYTES = 600 * 1024 * 1024
/**
 * Vészfék. Ha egy futas a nyilvantartott fajlok ennel nagyobb hanyadat torolne
 * a Drive-on, EGYET SEM torlunk, es szolunk.
 *
 * Ez a legveszelyesebb pont az egesz funkcioban: egy lecsatolt lemez, egy
 * elgepelt depo-utvonal vagy egy hiba ebben a fajlban ugy nezne ki, mintha a
 * felhasznalo mindent kitorolt volna -- es a "hu" szinkron letorolne a Drive-ot,
 * vagyis pont a mentest. A kuszob ala eso, valodi torlesek atmennek.
 */
const DELETE_BRAKE_PCT = 10
/** Ennyi torles alatt a szazalekos fek nem szol bele (par fajl torlese normalis). */
const DELETE_BRAKE_MIN = 3

export interface SyncPair {
  /** Sajat azonosito, hogy torolni lehessen. */
  id: string
  account: string
  folderId: string
  /** A Drive-mappa neve -- ez lesz a helyi mappa neve is. */
  name: string
  /**
   * MENTES-PAROS: a helyi oldal a raktar egy aga, a Drive oldal a MENTES.
   *
   * Boss (#47 kartya): "ez az egesz mappastruktura folyamatosan sync-elve /
   * feltoltve a Google Drive-ra biztonsagi mentesnek ... azok NEM mennek a git
   * repoba". MERVE 2026-08-28: a raktarban 9356 fajl / 11 GB all ugy, hogy
   * SEHOL nincs masodpeldanya -- a git-tarolok a Rendszer alatt vannak, a
   * szemelyes ag pedig nem git-elheto.
   *
   * A ket paros-fajta IRANYA ellentetes, es ez nem izles kerdese:
   *   * Drive-masolat: a Drive a forras, a gep a masolat -- letoltunk.
   *   * MENTES: a GEP a forras, a Drive a masolat -- ide SOSE toltunk le.
   *     Egy feltort Drive igy nem tud fajlt BEIRNI a munkamappaidba, ahogy
   *     torolni sem tud belole (ez utobbi a 2026-08-15-i eredeti kikotes).
   */
  backup?: true
  /**
   * A mentendo ag a raktar gyokerehez kepest (pl. `Korpás László/Projektek`).
   *
   * URES SZOVEG = a TELJES raktar. Ezert nem eleg a mezo letezeset nezni:
   * hogy mentes-parosrol van-e szo, azt a `backup` mondja meg.
   */
  localPath?: string
  addedAt: string
  lastRunAt?: string
  lastResult?: string
  /**
   * Hany fajl varakozott meg feltoltesre a legutobbi futas vegen.
   *
   * Nem szepsegtapasz: enelkul egy FELIG felment mentes ugyanolyan zold
   * "rendben"-t mutatna az Attekintesen, mint egy kesz. A szamot az
   * onellenorzes olvassa (`drive_sync_incomplete`) -- ezert kulon mezo, es nem
   * egy kepernyore szant mondatbol visszafejtett szam.
   */
  lastPending?: number
}

export interface SyncFileState {
  path: string
  modifiedTime: string
  size: number
  /**
   * A HELYI fajl modositasi ideje akkor, amikor utoljara egyeztettuk.
   *
   * Enelkul nem lehet megkulonboztetni a "te szerkesztetted" esetet a
   * "valtozatlanul ott fekszik" esettol -- a felmeno ag pontosan ezen all.
   *
   * Hianyozhat: a 2026-08-15 elotti bejegyzeseknel meg nem letezett. Ilyenkor
   * NEM tekintjuk helyi modositasnak (kulonben az elso futas az egesz depot
   * felkuldene), csak csendben feljegyezzuk a mostani erteket.
   */
  localMtimeMs?: number
  /**
   * Google sajat formatuma (Docs/Sheets/Slides), amit exportalva hoztunk le.
   *
   * Az ilyen fajl a gepen `.docx`, a Drive-on viszont Google Doc: a bajtjai
   * SOSEM egyeznek egymassal. Ezert a meret-osszehasonlitas ertelmetlen rajuk
   * (`needsDownload`), a visszakuldes pedig kulon content-type-ot kivan.
   */
  exported?: boolean
  /**
   * Ha az exportalt fajl VISSZA is mehet, ezzel a content-type-pal kell felkuldeni.
   *
   * Ez a "nem lehet egy az egyben felmasolni" problema megoldasa: a Doc nem
   * bajtok halmaza, hanem a Drive-on tarolt szerkezet, ezert nincs bajtazonos
   * masolat. De ha a lehozott .docx-et EZZEL a tipussal toltjuk vissza ugyanarra
   * a fajlazonositora, a Google visszakonvertalja -- a fajl Doc marad, a
   * tartalma a tied lesz. Rajz/Script eseten hianyzik: azokat a Drive nem veszi
   * vissza (mert 400-zal valaszol, lasd `driveUploadMime`).
   */
  uploadMime?: string
}

interface SyncConfig {
  pairs: SyncPair[]
  /** Parosonkent: Drive-fajlazonosito -> amit mar lehoztunk rola. */
  state: Record<string, Record<string, SyncFileState>>
  /** Felmegy-e a helyi valtozas a Drive-ra. Alapbol IGEN. */
  upload?: boolean
  /** Felmegy-e a helyi TORLES (a Drive Kukajaba). Alapbol IGEN. */
  deleteUp?: boolean
  /**
   * Csak EBBEN a futasban ervenyes jelzes: a beallitas-fajl olvashatatlan volt.
   *
   * Nem kerul lemezre (lasd `saveSyncConfig`). Kulon mezo, mert a felmeno agat
   * ki KELL kapcsolni ilyenkor, de a felhasznalo kapcsolojat elallitani nem
   * szabad -- kulonben egy egyszeri serules VEGLEG lekapcsolna a funkciot.
   */
  corrupt?: boolean
}

export function loadSyncConfig(): SyncConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return { pairs: [], state: {}, upload: true, deleteUp: true }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return {
      pairs: Array.isArray(raw.pairs) ? raw.pairs : [],
      state: raw.state && typeof raw.state === 'object' ? raw.state : {},
      // Hianyzo kapcsolo = BE. A Boss ezt kerte alapertelmezesnek; a regi,
      // egyiranyu beallitas-fajlokban viszont nincs benne egyik mezo sem.
      upload: raw.upload !== false,
      deleteUp: raw.deleteUp !== false,
    }
  } catch {
    // Serult beallitas nem torolheti el a mar lehozott fajlokat: ures
    // listaval indulunk, a lemezen minden a helyen marad.
    //
    // A felmeno ag ilyenkor KIMARAD (`corrupt`). Ures allapotbol MINDEN helyi
    // fajl "ujnak" latszana -- egy serult beallitas igy az egesz depot
    // felkuldene a Drive-ra. A felhasznalo kapcsolojahoz viszont nem nyulunk:
    // a `corrupt` csak erre a futasra szol, es nem kerul lemezre.
    logger.warn('[drive-sync] serult drive-sync.json, ures listaval indulok (a felmeno ag kihagyva)')
    return { pairs: [], state: {}, upload: true, deleteUp: true, corrupt: true }
  }
}

function saveSyncConfig(cfg: SyncConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  // Serult fajl FOLE nem irunk: eloszor felretesszuk. Kulonben egyetlen
  // kattintas (kapcsolo, hozzaadas, levalasztas) veglegesitene a serulest -- a
  // parosok listaja NYOMTALANUL eltunne, es a felhasznalo csak annyit latna,
  // hogy a szinkronja "elfelejtett" mindent. Igy legalabb visszaallithato.
  if (cfg.corrupt && existsSync(CONFIG_PATH)) {
    const felre = `${CONFIG_PATH}.serult-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      renameSync(CONFIG_PATH, felre)
      logger.warn(`[drive-sync] a serult beallitast felretettem: ${felre}`)
    } catch (e) {
      logger.warn(`[drive-sync] a serult beallitast nem tudtam felretenni: ${String(e)}`)
    }
  }
  // A `corrupt` egy futas-jelzes, nem beallitas -- ha lemezre kerulne, orokre
  // ott ragadna, es a felmeno ag tobbe sose indulna el.
  const { corrupt, ...lemezre } = cfg
  void corrupt
  writeFileSync(CONFIG_PATH, JSON.stringify(lemezre, null, 2))
}

/**
 * Egy Drive-nev, ami mappanevnek/fajlnevnek is jo.
 *
 * A Drive-on barmi lehet egy fajl neve -- akar `../../.ssh/authorized_keys`.
 * Ez a nev NEM a mi adatunk, hanem tetszoleges szoveg, ezert a
 * konyvtar-valtoztato reszek nem kiszurve, hanem lecserelve tunnek el: ami
 * marad, az garantaltan EGY nevkomponens.
 */
export function safeSegment(name: string): string {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '_')          // utvonal-elvalaszto: sose legyen belole alkonyvtar
    .replace(/[\u0000-\u001f\u007f]/g, '')  // vezerlokarakterek
    .replace(/[:*?"<>|]/g, '_')     // Windowson tiltott -- a depo Windows-mappa
    .replace(/^\.+$/, '_')          // "." es ".."
    .replace(/[. ]+$/, '')          // Windowson ponttal/szokozzel nem vegzodhet
    .trim()
  return cleaned.slice(0, 120) || 'nevtelen'
}

/** A mentesek gyujtomappaja a Drive gyokereben. */
export const MENTES_MAPPA = 'Marveen mentés'

/**
 * A paros HELYI oldala: melyik mappat egyezteti a gepen.
 *
 * KET FAJTA PAROS van, es ez a fuggveny valasztja szet oket -- MINDENHOL ez az
 * egy, hogy a kepernyo ne mondhasson mast, mint amit a futas csinal:
 *
 *   * Drive-masolat (`backup` nincs): a fiok sajat mappaja a cel
 *     (`Rendszer/Tárolók/Drive/<fiok>`), es a paros neve alatta meg egy szint.
 *     Ures nev = a teljes Drive, ilyenkor nincs extra szint.
 *   * MENTES-PAROS (`backup: true`): a helyi oldal a raktar egy aga. Itt NINCS
 *     kulon gyoker-szint: a paros gyokere MAGA az ag. A `resolveLifePath`
 *     kezeli a bekoteseket is, es o a kilepes-ellenorzes egyetlen hatara.
 *
 * `null`, ha a helyi oldal nem allapithato meg (nincs raktar, vagy az ag
 * kivezet a fabol). Hivo helyen ez NEM "ures mappa", hanem elakadas.
 */
export function pairLocalDir(pair: SyncPair): { base: string; gyoker: string } | null {
  if (pair.backup) {
    const abs = resolveLifePath(pair.localPath || '')
    return abs ? { base: abs, gyoker: '' } : null
  }
  const base = depotAccountDir(pair.account, DEPOT_DRIVE)
  return base ? { base, gyoker: pair.name ? safeSegment(pair.name) : '' } : null
}

/**
 * Amit egy mentes-parosbol KIHAGYUNK.
 *
 * A teljes raktar mentesebol a `Rendszer` ag marad ki, mert ott all maga a
 * Drive-masolat (`Rendszer/Tárolók/Drive`) es a fenykeptar. Feltolteni annyi
 * lenne, mint a mentest menteni: ugyanazok a bajtok mennenek fel masodszor,
 * korbe. (MERVE 2026-08-28: a Rendszer 13778 fajl / 32 GB.)
 *
 * Egy KIVALASZTOTT ag mentesenel nincs kihagyas: oda a Rendszer nem is eshet
 * bele, mert `mentesAgHiba` mar a bekotesnel visszautasitja.
 */
export function mentesKihagy(pair: SyncPair): Set<string> {
  if (!pair.backup) return new Set()
  return mentesKihagyUt(pair.localPath || '')
}

/**
 * Ugyanaz, csak az UTBOL. Az elonezet meg nem paros, de pontosan azt kell
 * mutatnia, amit a futas majd csinal -- kulonben a szam, amit a Boss lat, nem
 * arrol szol, ami fel fog menni.
 */
export function mentesKihagyUt(localPath: string): Set<string> {
  return mentesUtNorm(localPath) ? new Set<string>() : new Set([DEPOT_SYSTEM_ROOT])
}

/** Raktar-beli ut egysegesitese: `\` -> `/`, se eleje, se vege perjel. */
export function mentesUtNorm(x: string): string {
  return String(x || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/**
 * Menthető-e ez az ág a Drive-ra? A visszateres a HIBA szovege, vagy `null`.
 *
 * Csak a KOROKET utasitja vissza -- azt, amitol a mentes onmagat mentene.
 */
export function mentesAgHiba(localPath: string): string | null {
  const elso = mentesUtNorm(localPath).split('/')[0]
  if (elso === DEPOT_SYSTEM_ROOT) {
    return `A(z) „${DEPOT_SYSTEM_ROOT}” ág nem menthető a Drive-ra: ebben az ágban áll maga a Drive-másolatod és a fényképtárad.`
      + ' Feltölteni annyi lenne, mint a mentést menteni – ugyanazok a fájlok mennének fel másodszor is.'
      + ' A teljes raktár mentése ezt az egy ágat magától kihagyja.'
  }
  return null
}

/**
 * Fedi-e mar egy meglevo mentes ezt az agat? Mindket IRANYBAN nezi.
 *
 * Ket mentes, ami egymasba er, nem "kicsit felesleges": a kozos fajlok KETSZER
 * mennenek fel, ket kulon Drive-mappaba, es minden ejjel ujra.
 */
export function mentesUtkozes(
  pairs: SyncPair[],
  localPath: string,
): { pair: SyncPair; fajta: 'ugyanaz' | 'fölötte' | 'alatta' } | null {
  const uj = mentesUtNorm(localPath)
  for (const p of pairs) {
    if (!p.backup) continue
    const van = mentesUtNorm(p.localPath || '')
    if (van === uj) return { pair: p, fajta: 'ugyanaz' }
    if (van === '' || uj.startsWith(van + '/')) return { pair: p, fajta: 'fölötte' }
    if (uj === '' || van.startsWith(uj + '/')) return { pair: p, fajta: 'alatta' }
  }
  return null
}

/**
 * A mentes Drive-mappajanak neve.
 *
 * Az ag TELJES utjabol keszul (`Korpás László - Projektek`), nem csak az utolso
 * szintbol: ket kulonbozo agban lehet ugyanolyan nevu mappa (`Munka`), es a
 * Drive-on ket azonos nevu mentes-mappa kozott a Boss nem tudna valasztani.
 */
export function mentesMappaNev(localPath: string): string {
  const tiszta = mentesUtNorm(localPath)
  return safeSegment(tiszta ? tiszta.split('/').join(' - ') : 'A teljes raktár')
}

/**
 * ELO access token: a futas KOZBEN is frissul.
 *
 * A Google access token ~1 orat el, a teljes raktar mentese ennel sokkal
 * tovabb tart. Korabban a paros futasanak ELEJEN kertuk el egyszer, es azt az
 * egy sztringet hasznaltuk vegig -- a lejarat pillanataban onnantol MINDEN
 * keres elbukott. MERVE 2026-08-29: 252 sikeres feltoltes (72 MB) utan 4608 db
 *   Drive 401: "Request had invalid authentication credentials."
 * A mentes igy SOHA nem tudott vegigmenni: nem a halozat es nem a jogosultsag
 * volt a baj, hanem az, hogy egy oranal hosszabb munkat egy oras tokennel
 * probaltunk elvegezni.
 *
 * Ezert a halozati fuggvenyek mostantol `TokenForras`-t kapnak: lehet sima
 * sztring (a rovid, egy-keres API-vegpontoknak valtozatlanul jo), vagy egy
 * szolgaltato, amit minden keres elott megkerdezunk. 401-nel EGYSZER
 * eroltetett frissitessel ujraprobalunk -- ha a friss tokennel is 401 jon,
 * akkor tenyleg a hozzaferes a baj, es azt mar nem szabad elnyelni.
 */
export type TokenForras = string | ((eroltetett?: boolean) => Promise<string>)

/** A tokent ennyi ido utan mar nem hisszuk el (a Google ~1 orat ad). */
const TOKEN_ELETTARTAM_MS = 45 * 60 * 1000

async function tokenErteke(t: TokenForras, eroltetett = false): Promise<string> {
  return typeof t === 'string' ? t : await t(eroltetett)
}

/**
 * Egy fiokhoz kotott, magat frissito token-szolgaltato.
 *
 * Sajat gyorsitotarat visz, ezert nem globalis: ket paros ket kulonbozo fiokja
 * nem tudja egymas tokenjet felulirni.
 */
export function tokenSzolgaltato(account?: string): (eroltetett?: boolean) => Promise<string> {
  let ertek = ''
  let ido = 0
  return async (eroltetett = false) => {
    if (!eroltetett && ertek && Date.now() - ido < TOKEN_ELETTARTAM_MS) return ertek
    ertek = await getAccessToken(account)
    ido = Date.now()
    return ertek
  }
}

function getAccessToken(account?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [join(PROJECT_ROOT, 'scripts', 'google-auth.py'), 'token']
    if (account) args.push(account)
    execFile('python3', args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err || !stdout.trim()) {
        reject(new Error((stderr || err?.message || 'nincs access_token').trim().slice(0, 200)))
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function driveJson(url: string, token: TokenForras, init: RequestInit = {}): Promise<any> {
  for (let probal = 0; ; probal++) {
    const t = await tokenErteke(token, probal > 0)
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${t}`, ...(init.headers || {}) } })
    if (res.ok) return res.json()
    const szoveg = (await res.text()).slice(0, 200)
    if (res.status === 401 && probal === 0 && typeof token !== 'string') continue
    throw new Error(`Drive ${res.status}: ${szoveg}`)
  }
}

/** Uj mappa a Drive-on. Visszaadja az azonositojat. */
async function createDriveFolder(name: string, parentId: string, token: TokenForras): Promise<string> {
  const created = await driveJson(`${DRIVE_FILES_URL}?fields=id`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' }),
  })
  return String(created.id)
}

/**
 * A fajl bajtjai felfele.
 *
 * Streamelve megy, nem egyben a memoriaban -- ugyanaz az elv, mint a letoltesnel.
 * A `duplex: 'half'` Node-ban kotelezo, ha a keres torzse folyam.
 *
 * A `contentType` nem szepitseg: EZ mondja meg a Drive-nak, hogy egy Google
 * Doc-ba erkezo .docx-et konvertalja vissza. Alapertelmezesben szandekosan
 * `application/octet-stream` -- "csak bajtok", vagyis a Drive nem ertelmezi.
 */
/**
 * Nev szerinti almappa a Drive-on -- ha nincs, letrehozzuk.
 *
 * Eloszor MEGNEZI, hogy van-e mar ilyen nevu mappa: enelkul minden bekotes uj
 * "Marveen mentés" mappat gyartana, es harom bekotes utan a Boss harom
 * egyforma mappa kozul valogathatna a Drive-jan.
 */
async function ensureDriveFolderByName(name: string, parentId: string, token: TokenForras): Promise<string> {
  const gyerekek = await listFolder(parentId, token)
  const meg = gyerekek.find((f: any) => f.mimeType === 'application/vnd.google-apps.folder' && f.name === name)
  if (meg) return String(meg.id)
  return await createDriveFolder(name, parentId, token)
}

async function putBytes(uploadUrl: string, method: 'POST' | 'PATCH', localPath: string, token: TokenForras, contentType = 'application/octet-stream'): Promise<any> {
  const size = statSync(localPath).size
  // Az olvaso-folyam MINDEN probalkozasnal ujra keszul: egy elhasznalt folyamot
  // nem lehet megegyszer feltolteni, es a csendben ures torzs rosszabb, mint a
  // hibauzenet.
  for (let probal = 0; ; probal++) {
    const t = await tokenErteke(token, probal > 0)
    const res = await fetch(uploadUrl, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        'Content-Type': contentType,
        'Content-Length': String(size),
      },
      body: Readable.toWeb(createReadStream(localPath)) as any,
      duplex: 'half',
    } as any)
    if (res.ok) return res.json()
    const szoveg = (await res.text()).slice(0, 200)
    if (res.status === 401 && probal === 0 && typeof token !== 'string') continue
    throw new Error(`Drive ${res.status}: ${szoveg}`)
  }
}

/**
 * Uj fajl a Drive-on: eloszor a nev/hely (metaadat), utana a tartalom.
 *
 * Ket keres egy tobbreszes (multipart) helyett: az osszefuzott torzs hataraval
 * konnyu csendben elrontani valamit, es egy elrontott hatar rossz bajtokat tolt
 * fel. Igy mindket lepes kulon elszal, ha baj van.
 */
async function uploadNewFile(name: string, parentId: string, localPath: string, token: TokenForras): Promise<{ id: string; modifiedTime: string }> {
  const created = await driveJson(`${DRIVE_FILES_URL}?fields=id`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId] }),
  })
  const id = String(created.id)
  const done = await putBytes(`${DRIVE_UPLOAD_URL}/${encodeURIComponent(id)}?uploadType=media&fields=id,modifiedTime`, 'PATCH', localPath, token)
  return { id, modifiedTime: String(done.modifiedTime || '') }
}

/**
 * Meglevo Drive-fajl tartalmanak felulirasa.
 *
 * `contentType`-pal hivva ez a Google-natív fajlok visszautja is: a fajl-
 * azonosito ugyanaz marad, tehat a Doc megorzi a megosztasait, a linkjet es a
 * verzio-tortenetet -- nem uj fajl keletkezik a regi helyere.
 */
async function updateDriveFile(fileId: string, localPath: string, token: TokenForras, contentType?: string): Promise<string> {
  const done = await putBytes(`${DRIVE_UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=media&fields=modifiedTime`, 'PATCH', localPath, token, contentType)
  return String(done.modifiedTime || '')
}

/**
 * Torles a Drive-on -- a KUKABA, nem veglegesen.
 *
 * Boss kerese ("ha a gepemen torlok valamit az fent is torlodne") teljesul, de
 * marad 30 nap visszavonasi ido. Feltores ellen a Kuka ugyanugy ved (a tamado
 * a gepedrol semmit nem tud torolni); egy sajat baleset ellen viszont menedek.
 * `files.delete` helyett ezert `trashed: true`.
 */
async function trashDriveFile(fileId: string, token: TokenForras): Promise<void> {
  await driveJson(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=id`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  })
}

/** Egy Drive-mappa tartalma, lapozassal egyutt. */
async function listFolder(folderId: string, token: TokenForras): Promise<any[]> {
  const out: any[] = []
  let pageToken = ''
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,modifiedTime)')
    const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    const data = await driveJson(`${DRIVE_FILES_URL}?q=${q}&fields=${fields}&pageSize=200${page}`, token)
    for (const f of data.files || []) out.push(f)
    pageToken = data.nextPageToken || ''
  } while (pageToken)
  return out
}

/**
 * Valtozott-e a fajl azota, hogy lehoztuk?
 *
 * A Drive `modifiedTime`-ja + a meret. Nem md5: a Google-fajlok (Docs, Sheets)
 * exportalva jonnek le, es az exportalt bajtok lenyomata SOSEM egyezne a
 * Drive-en tarolt fajleval -- minden futasban ujra lehoznank mindent.
 */
export function needsDownload(remote: { modifiedTime?: string; size?: string | number }, known: SyncFileState | undefined, localPath: string): boolean {
  if (!known) return true
  if (!existsSync(localPath)) return true      // kezzel torolte: hozzuk vissza
  if ((remote.modifiedTime || '') !== known.modifiedTime) return true
  // A Google-natív fajloknal a ket meret KET KULONBOZO dolog: a Drive a sajat
  // belso meretet adja (merve: 1024 bajt egy ures Docra), a `known.size` viszont
  // az EXPORTALT .docx merete (merve: 6780 bajt). Ha ezeket osszevetnenk, minden
  // Doc "valtozottnak" latszana MINDEN futasban -- ezert nezzuk itt csak a datumot.
  if (known.exported) return false
  const size = remote.size ? Number(remote.size) : 0
  if (size > 0 && size !== known.size) return true
  return false
}

/**
 * Megvaltozott-e a fajl a GEPEN azota, hogy utoljara egyeztettuk?
 *
 * Datum VAGY meret: a meret azert kell, mert egy szerkeszto vissza tudja allitani
 * a modositasi idot (es a masolo programok is sokszor megorzik).
 *
 * Ha a bejegyzesben meg nincs `localMtimeMs` (2026-08-15 elotti allapot), akkor
 * NEM mondjuk valtozottnak. Kulonben az atallas utani elso futas az egesz depot
 * felkuldene a Drive-ra -- tomeges, felesleges es ijeszto.
 */
export function localChanged(known: SyncFileState | undefined, stat: { mtimeMs: number; size: number } | null): boolean {
  if (!known || !stat) return false
  // Google-natív fajl csak akkor mehet fel, ha a Drive VISSZA is veszi
  // (Doc/Sheet/Slide igen, Rajz/Script nem). Amit nem vesz vissza, azt meg sem
  // probaljuk: minden futasban egy 400-as hibat irna a naplodobozba.
  if (known.exported && !known.uploadMime) return false
  if (known.localMtimeMs === undefined) return false
  if (Math.round(stat.mtimeMs) !== Math.round(known.localMtimeMs)) return true
  return stat.size !== known.size
}

/**
 * Megallitja-e a vészfék a torleseket?
 *
 * Kulon, tiszta fuggveny, hogy VALODI szamokkal lehessen tesztelni. Ez a fek all
 * a legveszelyesebb muvelet elott, es egy csak-szovegre illesztett teszt nem
 * mutatna meg, ha a hataron elcsuszik.
 */
export function shouldBrakeDeletions(wouldDelete: number, tracked: number): boolean {
  if (wouldDelete <= DELETE_BRAKE_MIN) return false   // par fajl torlese hetkoznapi
  if (tracked <= 0) return false
  return (wouldDelete / tracked) * 100 > DELETE_BRAKE_PCT
}

/** A helyi fa: minden fajl relativ uttal. A felbeszakadt letoltesek kimaradnak. */
/**
 * Az elonezet merese -- ugy, hogy kozben a dashboard EL.
 *
 * Miert nem a `walkLocalFiles`? Mert az szinkron, es a Node egy szalon fut: a
 * teljes raktar bejarasa MERVE 52 masodperc (9358 fajl a 9p csatoloson), ezalatt
 * pedig egyetlen masik keres sem kapna valaszt. Egy gombnyomasra egy percre
 * befagyna az egesz felulet, hibauzenet nelkul.
 *
 * Ezert adagonkent (`ADAG`) visszaadjuk a vezerlest az esemenyhuroknak. Cserebe
 * a meres kicsit lassabb, de kozben minden mas mukodik.
 *
 * A meretet MENET KOZBEN merjuk: kulon `statSync`-kor meg egyszer vegig kellene
 * menni ugyanazon a 9358 fajlon, megegyszer 50 masodpercert.
 */
export async function merjMentendot(
  base: string,
  max = MAX_LOCAL_FILES,
  kihagy: Set<string> = new Set(),
): Promise<{ files: number; bytes: number; tooBig: number; unreadable: number; csonkolt: boolean }> {
  // IDO-alapu, nem darabszam-alapu. A darabszam nem mond semmit arrol, mennyi
  // ideig tart: SSD-n 500 fajl 2 ms, halozati vagy 9p mappan 3 masodperc
  // (MERVE 2026-08-29). Az orat nezzuk, igy lassu lemezen surubben lelegzunk.
  const SZELET_MS = 15
  let files = 0
  let bytes = 0
  let tooBig = 0
  let unreadable = 0
  let csonkolt = false
  let utolso = Date.now()
  const queue: string[] = ['']
  const lelegzet = async () => {
    if (Date.now() - utolso < SZELET_MS) return
    await new Promise((r) => setImmediate(r))
    utolso = Date.now()
  }
  while (queue.length) {
    const rel = queue.shift()!
    let entries: { name: string; dir: boolean }[]
    try {
      entries = readdirSync(join(base, rel), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }))
    } catch {
      continue      // idokozben eltunt vagy nem olvashato -- nem allitjuk meg a merest
    }
    for (const e of entries) {
      await lelegzet()
      const child = rel ? join(rel, e.name) : e.name
      if (e.dir) {
        if (kihagy.has(child)) continue
        queue.push(child)
        continue
      }
      if (e.name.endsWith('.part')) continue
      if (files >= max) { csonkolt = true; return { files, bytes, tooBig, unreadable, csonkolt } }
      files++
      try {
        const st = statSync(join(base, child))
        bytes += st.size
        if (st.size > MAX_UPLOAD_BYTES) tooBig++
      } catch {
        // Kozben eltunt vagy nem olvashato. NEM nulla merettel szamoljuk: az
        // hazudna a vegosszegben. Kulon szamoljuk, es ki is irjuk.
        unreadable++
      }
    }
  }
  return { files, bytes, tooBig, unreadable, csonkolt }
}

export function walkLocalFiles(
  base: string,
  max = MAX_LOCAL_FILES,
  /** Ezeket az AL-MAPPAKAT (a `base`-hez kepesti uttal) at sem lepjuk. */
  kihagy: Set<string> = new Set(),
): { files: string[]; dirs: string[]; csonkolt: boolean } {
  const files: string[] = []
  const dirs: string[] = []
  const queue: string[] = ['']
  let csonkolt = false
  while (queue.length) {
    const rel = queue.shift()!
    let entries: { name: string; dir: boolean }[]
    try {
      entries = readdirSync(join(base, rel), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }))
    } catch {
      continue      // idokozben eltunt vagy nem olvashato -- nem allitjuk meg a futast
    }
    for (const e of entries) {
      const child = rel ? join(rel, e.name) : e.name
      if (e.dir) {
        // Kihagyott ag: se a listaba, se a sorba. Nem "ures mappa" lesz belole,
        // hanem NEM LATOTT -- ezert a torles-atvitel sem hozhat rola dontest.
        if (kihagy.has(child)) continue
        dirs.push(child); queue.push(child); continue
      }
      // A `.part` egy eppen zajlo letoltes fele fajlja -- sose kuldjuk fel.
      if (e.name.endsWith('.part')) continue
      if (files.length >= max) { csonkolt = true; return { files, dirs, csonkolt } }
      files.push(child)
    }
  }
  return { files, dirs, csonkolt }
}

async function downloadTo(url: string, token: TokenForras, dest: string): Promise<number> {
  let res = await fetch(url, { headers: { Authorization: `Bearer ${await tokenErteke(token)}` } })
  if (res.status === 401 && typeof token !== 'string') {
    res = await fetch(url, { headers: { Authorization: `Bearer ${await tokenErteke(token, true)}` } })
  }
  if (!res.ok || !res.body) throw new Error(`Drive ${res.status}`)
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  try {
    // Darabonkent a lemezre: egy nagy fajl sem kerul egyben a memoriaba, es a
    // dashboard tobbi resze kozben is valaszol.
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp))
    renameSync(tmp, dest)     // a vegleges nev csak a KESZ fajlnak jar
    return statSync(dest).size
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* nem is keszult el */ }
    throw err
  }
}

export interface SyncJob {
  running: boolean
  /**
   * Ennek a futasnak az azonositoja.
   *
   * Ez koti ossze a kepernyon latott "N nem sikerult" szamot a lemezen allo
   * NEVEKKEL: a hibalista sorai ezt hordozzak, igy a felhasznalo pontosan a
   * LEGUTOBBI futas kimaradt fajljait tudja elokerni -- nem az osszes valahai
   * hibat egy kupacban.
   */
  runId: string
  startedAt: string
  finishedAt: string | null
  pair: string
  /** Hany fajlt hoztunk le ebben a futasban. */
  downloaded: number
  /** Hany fajlt kuldtunk FEL a Drive-ra (uj + modositott). */
  uploaded: number
  /** Hany fajlt tettunk a Drive Kukajaba, mert a gepen mar nincs meg. */
  trashed: number
  /** Hany volt mar naprakesz. */
  upToDate: number
  skipped: number
  failed: number
  bytes: number
  errors: string[]
  current: string
  /**
   * Ha a vészfék megallitotta a torleseket, itt all, hany fajlrol volt szo.
   * A kepernyon ez kulon, feltuno uzenetet kap -- nem szabad elsikkadnia.
   */
  deleteBrake?: { wouldDelete: number; tracked: number }
}

let job: SyncJob | null = null

/** Csak a teszteknek. */
export function resetSyncJob(): void { job = null }

/**
 * Miert maradt csonka a bejaras. NEM `boolean`: a felhasznalonak ez donti el,
 * mit tegyen -- egy elert korlatnal varni/emelni kell, egy olvasasi hibanal
 * viszont a Drive-on vagy a jogosultsagnal van a baj.
 *
 * Pont ez volt a 2026-08-16-i felrevezetes: a lackor2-n "elertuk a felso
 * hatart" allt, kozben a Drive-jan 73 mappa es 3179 fajl van (merve), vagyis a
 * korlat kozelebe sem ert -- egy ki nem olvashato mappa volt a valodi ok.
 */
export type CsonkaOk = 'mappa-korlát' | 'fájl-korlát' | 'olvasási hiba'

export function csonkoltSzoveg(okok: CsonkaOk[], maxFolders: number, maxFiles: number): string {
  const reszek = okok.map((ok) => {
    if (ok === 'mappa-korlát') return `elértük a(z) ${maxFolders} mappás felső határt`
    if (ok === 'fájl-korlát') return `elértük a(z) ${maxFiles} fájlos felső határt`
    return 'egy vagy több mappát nem tudtam kiolvasni a Drive-ról'
  })
  return reszek.join('; ')
}

/**
 * Egy elakadas feljegyzese -- a KEPERNYORE es a LEMEZRE is.
 *
 * A lemezre iras AZONNAL megtortenik (#64): a `job` egyetlen memoriabeli
 * valtozo, amit a kovetkezo futas felulir, es egy ujraindulas nyomtalanul
 * elviszi. A Boss viszont pont ezekbol a nevekbol akarja kezzel lementeni, ami
 * nem jott le -- ez tehat nem naplo, hanem ADAT.
 *
 * A kepernyon levo lista tovabbra is rovid (20 sor), de mar nem az EGYETLEN
 * peldany: alatta a "Mi maradt ki?" lista a teljes fajlbol dolgozik.
 */
function gond(a: {
  pair: SyncPair
  phase: SyncFailurePhase
  localPath?: string
  driveName?: string
  driveId?: string
  reason: string
  /** Igaz, ha ez "nem sikerult"-nek szamit. A szandekos kihagyas nem az. */
  failed?: boolean
}): void {
  recordSyncFailure({
    runId: job?.runId || 'futás-azonosító-nélkül',
    at: new Date().toISOString(),
    account: a.pair.account,
    pair: pairLabel(a.pair),
    pairId: a.pair.id,
    phase: a.phase,
    localPath: a.localPath || '',
    driveName: a.driveName || '',
    driveId: a.driveId || '',
    reason: a.reason,
  })
  if (!job) return
  if (a.failed) job.failed++
  if (job.errors.length < 20) job.errors.push(`${a.localPath || a.driveName || pairLabel(a.pair)}: ${a.reason}`)
}

/**
 * Egy paros lehozasa. A visszateres azt mondja meg, hogy TELJES-e a masolat.
 *
 * Ez nem szormenyeszes: a Boss ezt biztonsagi mentesnek szanja ("a drive a
 * neten egy biztonsagi mentes. mint a github"). Egy csonka mentes, amire a
 * lista azt irja, hogy "rendben", pontosan akkor derulne ki, amikor mar baj van.
 */
async function syncPair(pair: SyncPair, cfg: SyncConfig): Promise<{
  csonkolt: CsonkaOk[]
  brake: { wouldDelete: number; tracked: number } | null
  maradt: number
}> {
  const hely = pairLocalDir(pair)
  // KET KULON OK, ket kulon teendo -- ezert nem egy mondat mind a kettore.
  if (!hely) {
    throw new Error(pair.backup
      ? `a mentendő ág nincs meg a raktárban: ${pair.localPath || 'a raktár gyökere'}`
      : 'nincs raktár beállítva')
  }
  const base = hely.base
  // Szolgaltato, nem sztring: a mentes tobb oraig is tarthat, a token egy oraig el.
  const token = tokenSzolgaltato(pair.account)
  // Fail-fast: ha a hozzaferes MOST sincs meg, ne a 3000. fajlnal deruljon ki.
  await token()
  const state = cfg.state[pair.id] || {}
  cfg.state[pair.id] = state
  // Szelessegi bejaras: mappa + a hozza tartozo HELYI utvonal.
  //
  // Ures nev = TELJES Drive. Ilyenkor NEM teszunk fole meg egy szintet: a
  // tartalom egyenesen a fiok sajat mappajaba kerul (`<depo>/drive/lackor2`),
  // igy a fa pontosan ugyanaz, mint a neten. A `safeSegment('')` `nevtelen`-t
  // adna vissza, ezert itt NEM hivhatjuk meg ures nevre.
  // MENTES-PAROSNAL a gyoker mindig ures: ott a paros gyokere MAGA az ag.
  const gyoker = hely.gyoker
  const gyokerAbs = join(base, gyoker)
  // Helyi mappa-ut -> Drive-mappaazonosito. A lefele menet epiti fel, a felmeno
  // ag ebbol tudja, HOVA kerulhet egy uj fajl.
  const folderIds = new Map<string, string>([[gyoker, pair.folderId]])
  // `nyers`: a Drive-beli NEVEKBOL epult ut, `safeSegment` nelkul. Csak a
  // mentes-parosnal szamit, de ott fontos: a helyi fajlneveket mi kuldtuk fel
  // valtozatlanul, a `safeSegment` viszont 120 karakternel VAG. Ha csak a
  // vagott utat ismernenk, egy hosszu nevu fajl minden futasban "ujnak"
  // latszana -- vagyis minden ejjel egy ujabb masodpeldanyt kapna a Drive-on.
  const queue: Array<{ id: string; rel: string; nyers: string }> = [{ id: pair.folderId, rel: gyoker, nyers: '' }]
  // Mentes-parosnal: Drive-beli ut -> fajlazonosito. Ebbol tudja a felmeno ag,
  // hogy egy helyi fajlnak MAR van fent peldanya -- meg akkor is, ha a
  // nyilvantartas elveszett (megszakadt futas, ujra bekotott paros).
  const driveUtak = new Map<string, string>()
  let folders = 0
  let files = 0
  // Halmaz, nem `boolean`: ha tobb okbol is csonka lett, MIND ki kell derulnie.
  // Egy elert korlat mas teendo, mint egy ki nem olvashato mappa.
  const csonkaOkok = new Set<CsonkaOk>()
  // NEVUTKOZES. Egy Doc neve "Jelentes", a helyi masolate "Jelentes.docx" -- de
  // ugyanabban a mappaban lehet egy VALODI "Jelentes.docx" fajl is (a Drive
  // "Google Doc-ka alakitas" pont ilyen part hagy maga utan). Ket kulon
  // Drive-fajl esne EGY helyi utra: felvaltva irnak egymasra, a felmeno ag pedig
  // az egyik tartalmat kuldene a MASIK dokumentumba. Ezert az elso viszi a
  // nevet, a masodikat kihagyjuk es NEVEN NEVEZZUK.
  const hasznaltUtak = new Set<string>()
  const utkozoIdk = new Set<string>()
  // KULSO TORLES ELLENI VEDELEM (6. pont): amit MOST lattunk a Drive-on. Amire
  // a nyilvantartasban van sor, de ebben a halmazban nincs, azt fent toroltek.
  // A kovetkeztetes CSAK teljes bejarasnal all meg -- lasd `noteExternalScan`.
  const latottIdk = new Set<string>()
  while (queue.length) {
    const cur = queue.shift()!
    if (++folders > MAX_FOLDERS) {
      gond({
        pair, phase: 'mappa',
        localPath: join(base, cur.rel), driveName: cur.rel || 'a Drive gyökere', driveId: cur.id,
        reason: `a(z) ${MAX_FOLDERS} mappás felső határ elérve – ez a mappa és ami utána jött, kimaradt`,
      })
      csonkaOkok.add('mappa-korlát')
      break
    }
    let entries: any[]
    try {
      entries = await listFolder(cur.id, token)
    } catch (err: any) {
      // A TELJES Drive gyokerenel a `rel` ures -- ott a hibauzenet ": Drive 403"
      // lenne, ami elott nincs semmi. Ilyenkor kimondjuk, melyik szintrol van szo.
      //
      // EZ A LEGSULYOSABB EGY SOR a listaban: nem egy fajl maradt ki, hanem egy
      // EGESZ MAPPA tartalma -- akar tobb szaz fajl, nevrol sem tudjuk oket.
      gond({
        pair, phase: 'mappa', failed: true,
        localPath: join(base, cur.rel), driveName: cur.rel || 'a Drive gyökere', driveId: cur.id,
        reason: `a mappát nem tudtam kiolvasni, EGÉSZ TARTALMA kimaradt – ${String(err?.message || err).slice(0, 120)}`,
      })
      // Egy be nem jart mappa = hianyos kep. A felmeno ag ezutan mar nem
      // dontheti el megbizhatoan, mi "hianyzik" -- ezert csonkoltnak vesszuk.
      csonkaOkok.add('olvasási hiba')
      continue
    }
    for (const f of entries) {
      const seg = safeSegment(f.name)
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const rel = join(cur.rel, seg)
        folderIds.set(rel, f.id)
        const nyers = cur.nyers ? join(cur.nyers, f.name) : f.name
        // A nyers nevvel is felvesszuk: enelkul egy 120 karakternel hosszabb
        // nevu mappa alatt a felmeno ag minden futasban UJ mappat gyartana.
        if (pair.backup) folderIds.set(nyers, f.id)
        queue.push({ id: f.id, rel, nyers })
        continue
      }
      // Csonka bejarasbol nem szabad felmenni, ezert itt AZONNAL visszaterunk:
      // a felmeno ag (`uploadPhase`) el sem indul.
      if (++files > MAX_FILES) {
        gond({
          pair, phase: 'mappa',
          localPath: join(base, cur.rel), driveName: seg, driveId: f.id,
          reason: `a(z) ${MAX_FILES} fájlos felső határ elérve – ez a fájl és minden utána következő kimaradt`,
        })
        csonkaOkok.add('fájl-korlát')
        return { csonkolt: [...csonkaOkok], brake: null, maradt: 0 }
      }
      // A fajl LETEZIK a Drive-on. Ez fuggetlen attol, le tudjuk-e tolteni (egy
      // Urlapot nem tudunk, de attol meg nem toroltek le) -- ezert all a
      // kihagyo agak ELOTT.
      latottIdk.add(f.id)
      const plan = driveDownloadPlan(f.id, f.mimeType, seg)
      if (plan.unsupported) {
        // Urlap, Site, terkep: ezeknek nincs letoltheto alakjuk. Nem hiba,
        // csak nincs mit lehozni -- ezert kulon szamoljuk.
        if (job) job.skipped++
        continue
      }
      // Google sajat formatuma (Doc/Sheet/Slide): exportalva jon le, a helyi
      // bajtok SOSEM egyeznek a Drive-en tarolttal. `uploadMime` mondja meg,
      // hogy a Drive VISSZA is veszi-e -- ha igen, a felmeno ag ezzel kuldi fel.
      const exported = String(f.mimeType || '').startsWith('application/vnd.google-apps.')
      const uploadMime = driveUploadMime(f.mimeType) || undefined
      const rel = join(cur.rel, safeSegment(plan.filename))
      const dest = join(base, rel)
      if (hasznaltUtak.has(rel)) {
        utkozoIdk.add(f.id)
        if (job) job.skipped++
        gond({
          pair, phase: 'kihagyva',
          localPath: dest, driveName: f.name || seg, driveId: f.id,
          reason: 'két Drive-fájl esne ugyanarra a névre – a másodikat kihagytam (nevezd át az egyiket a Drive-on)',
        })
        continue
      }
      hasznaltUtak.add(rel)
      // MENTES-PAROS: innentol nem megyunk tovabb. A Drive itt CEL, nem forras
      // -- egyetlen bajt sem jon LE a munkamappaidba, meg akkor sem, ha fent
      // van valami, ami itt nincs. (Ez a #47 aszimmetriaja: aki felturja a
      // Drive-odat, nem tud fajlt BEIRNI a gepedbe, ahogy torolni sem tud.)
      // A bejaras csak azert fut, hogy tudjuk, mi van mar fent (`driveUtak`),
      // es hova kerulhet egy uj fajl (`folderIds`).
      if (pair.backup) {
        driveUtak.set(cur.nyers ? join(cur.nyers, f.name) : f.name, f.id)
        continue
      }
      if (job) job.current = rel
      // `let`: az atnevezes-ag alabb frissiti, kulonben a lenti agak a REGI
      // utat irnak vissza az allapotba.
      let known = state[f.id]
      // ATNEVEZTEK A DRIVE-ON. Merve (2026-08-15): az atnevezes felviszi a
      // `modifiedTime`-ot, tehat a fajl "valtozottnak" latszik, es az UJ neven
      // jon le -- a regi nevu peldany viszont ott maradna a gepen. Az mar nem
      // szerepelne a nyilvantartasban, vagyis a felmeno ag UJ FAJLKENT kuldene
      // vissza a Drive-ra: az atnevezes utan ujra megjelenne a regi nev is.
      // (Google Doc eseten ez ravadaszul egy idegen Word-fajl lenne a Doc
      // mellett.) Ezert nem hagyjuk ott: ATNEVEZZUK a helyi peldanyt is.
      // Torlesnek ez NEM szamit -- egy bajt sem vesz el, csak koveti a nevet.
      const regiAbs = known && known.path !== rel ? join(base, known.path) : ''
      if (regiAbs && existsSync(regiAbs) && !existsSync(dest)) {
        const regiStat = statSync(regiAbs)
        if (localChanged(known, regiStat)) {
          // Fent atneveztek, itt kozben szerkesztetted. A GEP nyer: hozzanyulni
          // sem szabad, a felmeno ag majd felkuldi a tartalmat a mar atnevezett
          // fajlba (ugyanaz a fajlazonosito).
          if (job && job.errors.length < 20) {
            job.errors.push(`${known.path}: a Drive-on átnevezték, a gépeden módosult – a tiéd marad, az megy fel`)
          }
          continue
        }
        try {
          mkdirSync(dirname(dest), { recursive: true })
          renameSync(regiAbs, dest)
          // TAVOLROL VEZERELT HELYI VALTOZAS. Egy bajt sem vesz el, de a
          // gepeden levo fajl neve egy Drive-beli lepes miatt valtozott meg --
          // ha valaki a Drive-odat turja fel, ennek latszodnia kell.
          if (externalGuardEnabled()) {
            recordExternalChange({
              runId: job?.runId || 'futás-azonosító-nélkül',
              at: new Date().toISOString(),
              account: pair.account, pair: pairLabel(pair), pairId: pair.id,
              kind: 'átnevezés', driveId: f.id, localPath: dest, relPath: rel,
              driveName: f.name || seg,
              note: `A Drive-on átnevezték, ezért a gépeden is átneveztem: ${known.path} → ${rel}. A tartalomhoz nem nyúltam.`,
            })
          }
          known = { ...known, path: rel }
          state[f.id] = known
        } catch (err: any) {
          gond({
            pair, phase: 'kihagyva',
            localPath: join(base, known.path), driveName: f.name || seg, driveId: f.id,
            reason: `a Drive-on átnevezték, de a gépeden nem tudtam átnevezni (${String(err?.message || err).slice(0, 80)}) – a régi néven maradt`,
          })
        }
      }
      const helyiStat = existsSync(dest) ? statSync(dest) : null
      if (!needsDownload(f, known, dest)) {
        if (job) job.upToDate++
        // Regi bejegyzesek potlasa. Ketto is hianyozhat beloluk: a helyi
        // idobelyeg (2026-08-15 elottrol), es a visszaut content-type-ja (a
        // Google-natív fajlok korabban egyaltalan nem mehettek fel). Amig ezek
        // nincsenek meg, a fajl helyi szerkeszteset nem vennenk eszre.
        const hianyzikIdo = known && known.localMtimeMs === undefined && helyiStat
        const hianyzikMime = known && known.uploadMime !== uploadMime
        if (known && (hianyzikIdo || hianyzikMime)) {
          state[f.id] = {
            ...known,
            localMtimeMs: known.localMtimeMs ?? helyiStat?.mtimeMs,
            exported,
            // Szandekosan felulir (nem `...`-szal beolvaszt): ha a fajl tipusa
            // valtozott es MAR NEM mehet vissza, a regi ertek nem maradhat ott.
            uploadMime,
          }
        }
        continue
      }
      // UTKOZES: a Drive-on IS, a gepen IS valtozott. A gep nyer -- a Boss
      // szamara a gep az igazsag, a Drive a mentes. A Drive-beli valtozat nem
      // vesz el: a feltoltes utan a Google verzio-tortenetebol elohozhato.
      if (localChanged(known, helyiStat)) {
        if (job && job.errors.length < 20) {
          job.errors.push(`${rel}: mindkét helyen módosult – a gépeden lévő marad, az kerül fel`)
        }
        continue
      }
      try {
        const size = await downloadTo(plan.url, token, dest)
        state[f.id] = {
          path: rel,
          modifiedTime: f.modifiedTime || '',
          size,
          localMtimeMs: existsSync(dest) ? statSync(dest).mtimeMs : undefined,
          exported,
          uploadMime,
        }
        if (job) { job.downloaded++; job.bytes += size }
      } catch (err: any) {
        // EZ a "N nem sikerult" szam forrasa. A nev es a teljes helyi ut most
        // mar lemezre is kerul -- ebbol tudja a Boss, mit kell kezzel lementenie.
        gond({
          pair, phase: 'letöltés', failed: true,
          localPath: dest, driveName: f.name || seg, driveId: f.id,
          reason: String(err?.message || err).slice(0, 200),
        })
      }
    }
  }

  const csonkolt = [...csonkaOkok]
  // KULSO TORLES ELLENI VEDELEM (6. pont). Mentes-parosnal nincs ertelme: ott a
  // Drive a CEL, nem forras -- a bejaras el sem jut a fajlok allapotaig, es egy
  // ottani torles nem "kulso torles", hanem a mentes hianya (azt a felmeno ag
  // potolja). Nem-mentes parosnal viszont a nyilvantartas es a most latott
  // halmaz kulonbsege pontosan a fentrol torolt fajlokat adja -- de csak akkor,
  // ha a bejaras TELJES volt.
  if (!pair.backup) {
    const tracked = new Map<string, string>()
    for (const [id, st] of Object.entries(state)) {
      if (st && typeof st.path === 'string' && st.path) tracked.set(id, st.path)
    }
    noteExternalScan({
      runId: job?.runId || 'futás-azonosító-nélkül',
      account: pair.account, pair: pairLabel(pair), pairId: pair.id,
      base,
      tracked,
      seen: latottIdk,
      complete: csonkolt.length === 0,
      incompleteReason: csonkolt.length ? csonkoltSzoveg(csonkolt, MAX_FOLDERS, MAX_FILES) : '',
    })
  }
  const felmeno = await uploadPhase({ pair, cfg, state, token, base, gyoker, gyokerAbs, folderIds, csonkolt, utkozoIdk, driveUtak })
  return { csonkolt, brake: felmeno.brake, maradt: felmeno.maradt }
}

/** Amit a felmeno ag jelent vissza. */
interface FelmenoEredmeny {
  /** Nem `null`, ha a vészfék megallitotta a torleseket. */
  brake: { wouldDelete: number; tracked: number } | null
  /** Hany fajl var meg feltoltesre a futasonkenti koltsegveten TUL. */
  maradt: number
}

/**
 * A FELMENO ag: helyi uj/modositott fajl a Drive-ra, helyi torles a Kukaba.
 *
 * Kulon fuggveny, mert kulon a felelossege: a lefele menet legrosszabb esetben
 * felesleges letoltes, ez viszont IR a Drive-ra. Ami itt elromlik, az a
 * felhasznalo mentesen romlik el.
 */
async function uploadPhase(a: {
  pair: SyncPair
  cfg: SyncConfig
  state: Record<string, SyncFileState>
  token: TokenForras
  base: string
  gyoker: string
  gyokerAbs: string
  folderIds: Map<string, string>
  csonkolt: CsonkaOk[]
  /** Nevutkozes miatt kihagyott Drive-fajlok: ezekhez EGYALTALAN nem nyulunk. */
  utkozoIdk: Set<string>
  /** Mentes-parosnal: mi van MAR fent (Drive-beli ut -> fajlazonosito). */
  driveUtak: Map<string, string>
}): Promise<FelmenoEredmeny> {
  const { pair, cfg, state, token, gyoker, gyokerAbs, folderIds, utkozoIdk } = a
  const semmi: FelmenoEredmeny = { brake: null, maradt: 0 }
  if (cfg.upload === false) return semmi
  // 0. FEK: olvashatatlan beallitas. Ilyenkor ures az allapot, vagyis MINDEN
  // helyi fajl "ujnak" latszik -- a felmeno ag az egesz depot felkuldene.
  if (cfg.corrupt) {
    job?.errors.push('a szinkron beállítás-fájlja sérült – a feltöltés és a törlés kimaradt')
    return semmi
  }

  // 1. FEK: csonka kepbol nem szabad felmenni. Ha a bejaras beleutkozott a
  // korlatba vagy egy mappat nem tudtunk kiolvasni, akkor nem ismerjuk a Drive
  // valodi tartalmat -- egy "ez fent nincs meg, kuldjuk fel" vagy "ez itt nincs
  // meg, toroljuk fent" dontes ilyenkor vaktaban szuletne.
  if (a.csonkolt.length) {
    gond({
      pair, phase: 'kihagyva', driveName: pairLabel(pair),
      reason: `a Drive bejárása hiányos maradt (${csonkoltSzoveg(a.csonkolt, MAX_FOLDERS, MAX_FILES)})`
        + ' – a feltöltés és a törlés ezúttal kimaradt',
    })
    return semmi
  }
  // 2. FEK: ha a helyi mappa nincs a helyen (lecsatolt lemez, atnevezett depo),
  // az NEM azt jelenti, hogy mindent toroltel.
  if (!existsSync(gyokerAbs)) {
    job?.errors.push(`${pairLabel(pair)}: a helyi mappa nem található – a feltöltés kimaradt`)
    return semmi
  }

  const { files: helyiek, csonkolt: helyiCsonkolt } = walkLocalFiles(gyokerAbs, MAX_LOCAL_FILES, mentesKihagy(pair))
  if (helyiCsonkolt) {
    gond({
      pair, phase: 'kihagyva', localPath: gyokerAbs, driveName: pairLabel(pair),
      reason: `túl sok helyi fájl (${MAX_LOCAL_FILES} fölött), a feltöltés és a törlés kimaradt`,
    })
    return semmi
  }
  // A helyi utak a paros gyokerehez kepest jonnek; az allapot a depo fiok-
  // mappajahoz kepest tarol. Egy nyelvre hozzuk oket.
  const teljesRel = (rel: string) => (gyoker ? join(gyoker, rel) : rel)
  const helyiSet = new Set(helyiek.map(teljesRel))
  // Ut -> Drive-azonosito, hogy egy helyi fajlrol eldonthessuk, ismerjuk-e.
  const utrolId = new Map<string, string>()
  // MENTES-PAROS: eloszor az, amit a Drive-on MOST lattunk. Ha a nyilvantartas
  // elveszett (megszakadt futas, ujra bekotott paros), enelkul minden fajl
  // "ujnak" latszana, es a mentes MASODPELDANYT gyartana az egeszbol.
  for (const [ut, id] of a.driveUtak) { if (!utkozoIdk.has(id)) utrolId.set(ut, id) }
  // A nyilvantartas pontosabb forras (o tudja a helyi idobelyeget is), ezert
  // felulirja a bejarasbol jott parositast.
  for (const [id, s] of Object.entries(state)) {
    // A nevutkozes egyik feleben sem lehetunk biztosak: melyik dokumentumhoz
    // tartozik a lemezen fekvo fajl? Amig a Boss at nem nevezi az egyiket,
    // egyikbe sem irunk -- egy rossz tipp IDEGEN dokumentumot irna felul.
    if (utkozoIdk.has(id)) continue
    utrolId.set(s.path, id)
  }

  /** A Drive-mappa, ahova egy helyi konyvtar tartalma valo. Ha nincs, letrehozzuk. */
  const ensureFolder = async (relDir: string): Promise<string> => {
    if (!relDir || relDir === '.' || relDir === gyoker) return pair.folderId
    const van = folderIds.get(relDir)
    if (van) return van
    const szuloId = await ensureFolder(dirname(relDir))
    const id = await createDriveFolder(basename(relDir), szuloId, token)
    folderIds.set(relDir, id)
    return id
  }

  // --- feltoltes: uj es modositott fajlok ---
  //
  // KOLTSEGVETES, NEM KORLAT: futasonkent `MAX_UPLOADS` fajl megy fel, a tobbi
  // a kovetkezo futasra marad (a `drive-mentes` kartya ejjel 3-kor magatol
  // indit). A `maradt` szamot a lista ES az Attekintes is kiirja: egy felig
  // felment mentes nem mutathat zold "rendben"-t.
  let feltoltve = 0
  let maradt = 0
  for (const rel of helyiek) {
    const teljes = teljesRel(rel)
    const abs = join(gyokerAbs, rel)
    let st: { mtimeMs: number; size: number }
    try { st = statSync(abs) } catch { continue }   // kozben eltunt
    const meglevoId = utrolId.get(teljes)
    const known = meglevoId ? state[meglevoId] : undefined
    // Google-natív fajl, amit a Drive NEM vesz vissza (Rajz, Apps Script):
    // ezeknel a helyi szerkesztes nem tud felmenni. Merve, nem feltetelezve:
    // egy PNG visszairasa a rajzra 400-zal all meg.
    if (known?.exported && !known.uploadMime) {
      if (localChanged({ ...known, exported: false }, st)) {
        if (job) job.skipped++
        gond({
          pair, phase: 'kihagyva',
          localPath: abs, driveName: basename(teljes), driveId: meglevoId || '',
          reason: 'ezt a Google nem veszi vissza (rajz/script), a helyi módosítás nem ment fel',
        })
      }
      continue
    }
    // MENTES-PAROS + fent levo, de NEM NYILVANTARTOTT peldany: rairunk. A gep
    // az igazsag, a Drive a masolat -- ha nem tudjuk, egyezik-e, akkor nem
    // egyezik. (Egy Drive-masolat parosnal ez forditva veszelyes lenne, ezert
    // all rajta a `pair.backup` feltetel.)
    const ismeretlenMasolat = pair.backup === true && !!meglevoId && !known
    if (meglevoId && !ismeretlenMasolat && !localChanged(known, st)) continue
    if (st.size > MAX_UPLOAD_BYTES) {
      if (job) job.skipped++
      gond({
        pair, phase: 'kihagyva',
        localPath: abs, driveName: basename(teljes), driveId: meglevoId || '',
        reason: `túl nagy a feltöltéshez (${Math.round(st.size / 1024 / 1024)} MB), kimaradt`,
      })
      continue
    }
    // A koltsegvetes CSAK a valodi feltolteseket szamolja: a valtozatlan
    // fajlok mar felette kiestek. Igy a kovetkezo futas ott folytatja, ahol ez
    // abbahagyta -- nem az elejerol probalkozik ujra.
    if (feltoltve >= MAX_UPLOADS) { maradt++; continue }
    if (job) job.current = teljes
    try {
      if (meglevoId) {
        // `...known`: az `exported`/`uploadMime` jelzest MEG KELL TARTANI. Ha
        // elveszne, a kovetkezo futas ugy nezne a Doc-ra, mint egy kozonseges
        // fajlra -- a meret-osszehasonlitas miatt minden alkalommal ujra
        // lehozna, es octet-streamkent kuldene vissza (vagyis Word-fajlt
        // csinalna a Doc-bol).
        const modifiedTime = await updateDriveFile(meglevoId, abs, token, known?.uploadMime)
        state[meglevoId] = { ...known, path: teljes, modifiedTime, size: st.size, localMtimeMs: st.mtimeMs }
      } else {
        const parentId = await ensureFolder(dirname(teljes))
        const { id, modifiedTime } = await uploadNewFile(basename(teljes), parentId, abs, token)
        state[id] = { path: teljes, modifiedTime, size: st.size, localMtimeMs: st.mtimeMs }
        utrolId.set(teljes, id)
      }
      feltoltve++
      if (job) { job.uploaded++; job.bytes += st.size }
    } catch (err: any) {
      gond({
        pair, phase: 'feltöltés', failed: true,
        localPath: abs, driveName: basename(teljes), driveId: meglevoId || '',
        reason: String(err?.message || err).slice(0, 200),
      })
    }
  }

  // --- torles: ami a gepen mar nincs meg, az fent a Kukaba ---
  //
  // A `maradt` NEM akadaly itt: a helyi kep TELJES (a bejaras nem csonkolt),
  // csak a feltoltes fert bele a koltsegvetesbe. Amirol tudjuk, hogy a gepen
  // mar nincs meg, arrol ettol meg tudjuk.
  if (cfg.deleteUp === false) return { brake: null, maradt }
  // A torles a Google-natív fajlokra IS vonatkozik -- ott nincs "bajtok
  // egyezese" kerdes, csak annyi: a gepen mar nincs meg. A Rajz/Script is
  // ideszamit, noha a TARTALMUK nem tud felmenni: a torles nem konvertalas.
  const torlendok = Object.entries(state).filter(([id, s]) => !utkozoIdk.has(id) && !helyiSet.has(s.path))
  const tracked = Object.keys(state).length
  // 3. FEK: tomeges torles megallitasa. Par fajl torlese hetkoznapi, a
  // nyilvantartas nagy hanyada viszont majdnem biztosan hiba (rossz mappa,
  // felcsatolasi baj, hiba ebben a kodban) -- olyankor egy sem megy fel.
  if (shouldBrakeDeletions(torlendok.length, tracked)) {
    if (job) job.deleteBrake = { wouldDelete: torlendok.length, tracked }
    job?.errors.push(
      `VÉSZFÉK: ${torlendok.length} fájl tűnt el a gépedről (a ${tracked}-ból) – ` +
      'ennyit nem törlök a Drive-on magamtól. Nézd meg, hogy a raktár a helyén van-e.',
    )
    return { brake: { wouldDelete: torlendok.length, tracked }, maradt }
  }
  for (const [id, s] of torlendok) {
    if (job) job.current = s.path
    try {
      await trashDriveFile(id, token)
      delete state[id]
      if (job) job.trashed++
    } catch (err: any) {
      gond({
        pair, phase: 'törlés', failed: true,
        localPath: join(a.base, s.path), driveName: basename(s.path), driveId: id,
        reason: String(err?.message || err).slice(0, 200),
      })
    }
  }
  return { brake: null, maradt }
}

/**
 * Ahogy a paros a kepernyon megjelenik.
 *
 * Ures nev = a TELJES Drive; ilyenkor nincs mappanev, amit kiirhatnank, es egy
 * ures allapotsor ("epp ezen dolgozom: ") ijeszto. Ezert van sajat szovege.
 */
export function pairLabel(pair: { name?: string; backup?: true; localPath?: string }): string {
  // MENTES-PAROSNAL a HELYI ag a beszedes fel. A Drive-oldal neve ("Korpás
  // László - Projektek") a mi sajat gyartmanyunk: a Boss nem azt keresi.
  if (pair.backup) return `${pair.localPath || 'a teljes raktár'} → mentés a Drive-ra`
  return pair.name || 'a teljes Drive'
}

async function runSync(pairs: SyncPair[]): Promise<void> {
  const cfg = loadSyncConfig()
  for (const pair of pairs) {
    if (job) job.pair = pairLabel(pair)
    // A futas hiba-szamlaloja KOZOS a parosok kozott, ezert a paros sajat
    // hibait a kulonbsegbol olvassuk ki -- kulonben az elso paros hibai
    // ravetulnenek a tobbire.
    const hibaElotte = job?.failed || 0
    try {
      const { csonkolt, brake, maradt } = await syncPair(pair, cfg)
      const hibas = (job?.failed || 0) - hibaElotte
      // Csonka mentesre NEM irhatunk "rendben"-t: a listaban ez az egy szo
      // mondja meg, megbizhat-e benne. A hatarok a naplo-dobozban is ott
      // vannak, de oda csak az nez, aki eppen figyeli a futast.
      //
      // A vészfék ugyanigy: ha megallitotta a torleseket, akkor a Drive ES a
      // gep NEM egyezik. Ezt kimondani fontosabb, mint a szep zold "rendben".
      // A fek EZ a paros feke (a `syncPair` adja vissza), nem a futase: kulonben
      // az elso paros vészféke ravetulne a tobbire is, ami hazugsag lenne.
      //
      // A "reszleges" MOST MAR MEGMONDJA, MIERT. A regi valtozat mindig a felso
      // hatarra fogta -- a lackor2-nel ez merhetoen HAMIS volt (73 mappa / 3179
      // fajl all a Drive-jan, az akkori korlat 500 / 5000 volt), a valodi ok egy
      // ki nem olvashato mappa. A rossz ok rossz teendot sugall: a Boss a hatart
      // emelte volna, kozben egy jogosultsagi/halozati baj allt mogotte.
      //
      // A "folyamatban" NEM hiba, es szandekosan NEM a `részleges` szoval
      // kezdodik: abbol az onellenorzes PIROS sort csinal (csonka masolat), ez
      // viszont egy rendben zajlo, tobb ejszakas elso feltoltes. Sajat, sarga
      // sora van (`drive_sync_incomplete`). Zold "rendben" viszont nem lehet:
      // amig var fajl, a mentes NINCS kesz.
      //
      // AZ ELBUKOTT FAJLOK IS "NEM RENDBEN". 2026-08-29-en a mentes 252 fajlt
      // toltott fel es 8926-ot elrontott (lejart token), a paros mégis
      // "rendben"-t irt ki, mert a lanc csak a VARAKOZO fajlokat nezte -- azok
      // pedig elfogytak: minden fajlra sor kerult, csak epp elbukott. Egy zold
      // "rendben" egy ures mentes folott a legrosszabb fajta csend.
      // A hibak HANGOSABBAK a "folyamatban"-nal: az utobbi rendben zajlo elso
      // feltoltes, ez viszont teendo.
      pair.lastResult = brake
        ? `vészfék: ${brake.wouldDelete} fájl hiányzik a gépedről, ezért fent semmit nem töröltem`
        : csonkolt.length
          ? `részleges: ${csonkoltSzoveg(csonkolt, MAX_FOLDERS, MAX_FILES)} – a többi kimaradt`
          : hibas
            ? `${hibas} fájl nem ment fel – a Hibák dobozban látod, melyik miért`
            : maradt
              ? `folyamatban: még ${maradt} fájl vár feltöltésre – a következő futás onnan folytatja`
              : 'rendben'
      pair.lastPending = maradt
    } catch (err: any) {
      pair.lastResult = String(err?.message || err).slice(0, 200)
      gond({
        pair, phase: 'mappa', failed: true,
        driveName: pairLabel(pair),
        reason: `az egész páros elhasalt: ${pair.lastResult}`,
      })
    }
    pair.lastRunAt = new Date().toISOString()
    // Parosonkent mentunk, nem a vegen: egy megszakadt futas utan sem kezdjuk
    // elolrol azt, ami mar lejott.
    const live = loadSyncConfig()
    live.state = { ...live.state, ...cfg.state }
    live.pairs = live.pairs.map((p) => (p.id === pair.id
      ? { ...p, lastRunAt: pair.lastRunAt, lastResult: pair.lastResult, lastPending: pair.lastPending }
      : p))
    saveSyncConfig(live)
  }
  if (job) {
    job.running = false
    job.current = ''
    job.finishedAt = new Date().toISOString()
  }
  logger.info({ downloaded: job?.downloaded, failed: job?.failed }, '[drive-sync] futas kesz')
}

export async function tryHandleDriveSync(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/drive/sync' && method === 'GET') {
    const cfg = loadSyncConfig()
    json(res, {
      pairs: cfg.pairs.map((p) => {
        // Ures nev = teljes Drive: a fiok sajat mappaja MAGA a cel, nincs alatta
        // meg egy szint. (A `safeSegment('')` `nevtelen`-t adna -- itt hibas ut.)
        // MENTES-PAROSNAL a helyi oldal a raktar aga. UGYANAZ a fuggveny adja,
        // ami a futasnal is dont -- a kepernyo nem mondhat mast, mint a gep.
        const hely = pairLocalDir(p)
        return {
          ...p,
          localDir: hely ? join(hely.base, hely.gyoker) : null,
          label: pairLabel(p),
          files: Object.keys(cfg.state[p.id] || {}).length,
        }
      }),
      depot: depotHealth(),
      // A ket kapcsolo LATSZODJON: a felmeno ag ir a Drive-ra, a torles-atvitel
      // pedig torol. Amit nem lehet a kepernyon ellenorizni, arrol a felhasznalo
      // nem tudja eldonteni, be van-e kapcsolva.
      upload: cfg.upload !== false,
      deleteUp: cfg.deleteUp !== false,
      // Serult beallitas: ezt KI KELL mondani a kepernyon. A naploba irt
      // figyelmeztetest a felhasznalo sose latja, a parosok listaja viszont
      // uresen all -- magyarazat nelkul ez ugy nez ki, mintha o torolte volna.
      configBroken: cfg.corrupt === true,
      job,
    })
    return true
  }

  // A ket veszelyes kapcsolo atallitasa. Kulon vegpont, hogy a szinkron-futas
  // inditasa (`/run`) sose valtoztathasson rajtuk mellekhatáskent.
  if (path === '/api/drive/sync/settings' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const cfg = loadSyncConfig()
    if (typeof data.upload === 'boolean') cfg.upload = data.upload
    if (typeof data.deleteUp === 'boolean') cfg.deleteUp = data.deleteUp
    saveSyncConfig(cfg)
    json(res, { ok: true, upload: cfg.upload !== false, deleteUp: cfg.deleteUp !== false })
    return true
  }

  if (path === '/api/drive/sync/add' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const account = String(data.account || '')
    const folderId = String(data.folderId || '')
    const name = String(data.name || '')
    // TELJES SZINKRON. Boss 2026-08-15: "ha szinkronizalasrol van szo akkor az
    // egeszet egyben kellene szinkronizalni ... meg a fa struktura is ugyanaz
    // legyen. hiszen ez total szinkronnak kellene lennie" -- a Drive gyokerenel
    // (`root`) ezert NEM kerunk mappanevet: nev nelkul a tartalom a fiok sajat
    // mappajaba kerul, extra szint nelkul, vagyis a szerkezet AZONOS a Drive-eval.
    if (!account) { json(res, { error: 'hiányzik a fiók' }, 400); return true }
    if (!name && folderId !== 'root') { json(res, { error: 'hiányzik a mappa neve' }, 400); return true }
    if (!isSafeFolderId(folderId)) { json(res, { error: 'érvénytelen mappa-azonosító' }, 400); return true }
    const health = depotHealth()
    if (!health.writable) { json(res, { error: health.message, code: 'depot_unreachable' }, 409); return true }
    const cfg = loadSyncConfig()
    if (cfg.pairs.some((p) => p.account === account && p.folderId === folderId)) {
      // Az uzenet a KET esetre kulon szol: a fo uton (egy gomb, egy fiok) eppen
      // az "megegyszer megnyomtam" a leggyakoribb, es ott a "ez a mappa" szo
      // ertelmetlen -- nem mappat valasztott, hanem az egesz Drive-ot.
      const uzenet = folderId === 'root'
        ? `A(z) ${account} teljes Drive-ja már szinkronizálva van.`
        : 'ez a mappa már szinkronizálva van'
      json(res, { error: uzenet, code: 'exists' }, 409)
      return true
    }
    // Ha a TELJES Drive mar bent van, egy azon beluli mappa masodszor hozna le
    // ugyanazokat a bajtokat -- ugyanoda. Nem hiba nelkuli: a masodik paros nem
    // ismeri az elso allapotat (`needsDownload` `!known` -> `true`), vagyis minden
    // futasban ujra letoltene az egeszet. Ezert inkabb kimondjuk.
    if (folderId !== 'root' && cfg.pairs.some((p) => p.account === account && p.folderId === 'root')) {
      json(res, {
        error: `A(z) ${account} TELJES Drive-ja már szinkronizálva van – ezen belül minden mappa magától jön.`,
        code: 'whole_drive_exists',
      }, 409)
      return true
    }
    const pair: SyncPair = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      account, folderId, name, addedAt: new Date().toISOString(),
    }
    cfg.pairs.push(pair)
    saveSyncConfig(cfg)
    json(res, { ok: true, pair })
    return true
  }

  // A RAKTAR AGAI -- ebbol valaszt a "Mentsd a Drive-ra" kartya.
  //
  // Sajat vegpont, nem az Intezo listaja: itt pontosan az kell latszodjon, amit
  // MENTENI lehet. A `Rendszer` ag is BENNE VAN a listaban, de megjelolve --
  // ha egyszeruen kihagynank, a Boss azt hinne, eltunt, es keresne.
  if (path === '/api/drive/sync/local-branches' && method === 'GET') {
    const gyoker = depotRoot()
    // HAROM eset, nem ketto: nincs beallitva / be van, de nem latunk oda / ok.
    // A ket elso KULON teendo, ezert nem egy uzenet.
    if (!gyoker) {
      json(res, { root: null, configured: false, reachable: false, branches: [] })
      return true
    }
    let latszik = false
    try { latszik = statSync(gyoker).isDirectory() } catch { latszik = false }
    if (!latszik) {
      json(res, { root: gyoker, configured: true, reachable: false, branches: [] })
      return true
    }
    const alszint = (abs: string, elotag: string): Array<{ path: string; name: string }> => {
      let be: Array<{ name: string; dir: boolean }>
      try {
        be = readdirSync(abs, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }))
      } catch {
        return []
      }
      return be
        .filter((d) => d.dir && !d.name.startsWith('.'))
        .map((d) => ({ path: elotag ? `${elotag}/${d.name}` : d.name, name: d.name }))
        .sort((x, y) => x.name.localeCompare(y.name, 'hu'))
    }
    const branches = alszint(gyoker, '').map((b) => {
      const blocked = mentesAgHiba(b.path)
      return { ...b, blocked, children: blocked ? [] : alszint(join(gyoker, b.name), b.path) }
    })
    json(res, { root: gyoker, configured: true, reachable: true, branches, systemBranch: DEPOT_SYSTEM_ROOT })
    return true
  }

  // ELONEZET a bekotes ELOTT: hany fajl, mennyi bajt, mennyi fer fel.
  //
  // Ez a funkcio a Boss egesz munkajat feltolti egy kulso szolgaltatasba -- azt
  // NEM lehet ugy elinditani, hogy a merteket csak utana latja meg. A szamok
  // MERTEK, nem becsultek, es a Drive szabad helyet is magatol a Google-tol
  // kerdezzuk meg, nem tippeljuk.
  if (path === '/api/drive/sync/local-preview' && method === 'GET') {
    const rel = String(ctx.url.searchParams.get('path') || '')
    const account = String(ctx.url.searchParams.get('account') || '')
    if (!depotRoot()) {
      json(res, { error: 'Nincs raktár beállítva – a Beállításokban add meg, hova kerüljenek a fájljaid.', code: 'no_depot' }, 409)
      return true
    }
    const abs = resolveLifePath(rel)
    let mappa = false
    try { mappa = !!abs && statSync(abs).isDirectory() } catch { mappa = false }
    if (!abs || !mappa) {
      json(res, { error: `Ez a mappa nincs meg a raktárban: ${rel || 'a raktár gyökere'}`, code: 'no_dir' }, 404)
      return true
    }
    const kizart = mentesAgHiba(rel)
    if (kizart) { json(res, { error: kizart, code: 'kizart' }, 400); return true }

    const meres = await merjMentendot(abs, MAX_LOCAL_FILES, mentesKihagyUt(rel))
    const { bytes, csonkolt } = meres
    const tulNagy = meres.tooBig
    const nemLathato = meres.unreadable

    // A DRIVE SZABAD HELYE. Negy KULON eset -- a `null` itt is ketfelet
    // jelentene, ezert nem `null` jon vissza, hanem az, hogy MIERT nem tudjuk.
    let quota: any = { fajta: 'nincs_fiok' }
    if (account) {
      try {
        const token = await getAccessToken(account)
        const d = await driveJson('https://www.googleapis.com/drive/v3/about?fields=storageQuota', token)
        const limit = Number(d?.storageQuota?.limit || 0)
        const usage = Number(d?.storageQuota?.usage || 0)
        // `limit` nelkul a fiok korlatlan (Workspace) -- ez NEM ismeretlen.
        quota = limit > 0
          ? { fajta: 'ismert', limit, usage, free: Math.max(0, limit - usage) }
          : { fajta: 'korlatlan', usage }
      } catch (err: any) {
        quota = { fajta: 'nem_kerdezheto', error: String(err?.message || err).slice(0, 200) }
      }
    }

    json(res, {
      path: rel,
      absPath: abs,
      files: meres.files,
      bytes,
      tooBig: tulNagy,
      unreadable: nemLathato,
      truncated: csonkolt,
      excluded: mentesUtNorm(rel) ? null : DEPOT_SYSTEM_ROOT,
      driveFolder: `${MENTES_MAPPA}/${mentesMappaNev(rel)}`,
      perRun: MAX_UPLOADS,
      runs: Math.max(1, Math.ceil(Math.max(0, meres.files - tulNagy) / MAX_UPLOADS)),
      maxFileMb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
      quota,
    })
    return true
  }

  // BEKOTES: a raktar egy aga -> mentes a Drive-ra.
  //
  // A Drive-oldalt MI hozzuk letre (`Marveen mentés/<ag>`), hogy ne kelljen
  // mappat keresgelni egy masik felulet-fan. Amit itt visszautasitunk, azt
  // NEM izlesbol tesszuk: mindegyik korbe vinne (a mentes mentese).
  if (path === '/api/drive/sync/add-local' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const account = String(data.account || '')
    const rel = String(data.path || '')
    if (!account) { json(res, { error: 'hiányzik a fiók' }, 400); return true }
    const health = depotHealth()
    if (!health.writable) { json(res, { error: health.message, code: 'depot_unreachable' }, 409); return true }
    const abs = resolveLifePath(rel)
    let mappa = false
    try { mappa = !!abs && statSync(abs).isDirectory() } catch { mappa = false }
    if (!abs || !mappa) {
      json(res, { error: `Ez a mappa nincs meg a raktárban: ${rel || 'a raktár gyökere'}`, code: 'no_dir' }, 404)
      return true
    }
    const kizart = mentesAgHiba(rel)
    if (kizart) { json(res, { error: kizart, code: 'kizart' }, 400); return true }
    const cfg = loadSyncConfig()
    const utk = mentesUtkozes(cfg.pairs, rel)
    if (utk) {
      const mas = pairLabel(utk.pair)
      const uzenet = utk.fajta === 'ugyanaz'
        ? `Ez az ág már mentve van a Drive-ra (${mas}).`
        : utk.fajta === 'fölötte'
          ? `Ezt már menti egy nagyobb mentés (${mas}) – ami ebben az ágban van, magától felmegy.`
          : `Ezen belül már van egy külön mentés (${mas}). Előbb vedd ki azt, különben minden fájl kétszer menne fel.`
      json(res, { error: uzenet, code: 'exists' }, 409)
      return true
    }
    // Innentol HALOZAT: a hibat szo szerint adjuk vissza, nem talalgatjuk.
    let folderId: string
    try {
      const token = await getAccessToken(account)
      const mentesGyoker = await ensureDriveFolderByName(MENTES_MAPPA, 'root', token)
      folderId = await ensureDriveFolderByName(mentesMappaNev(rel), mentesGyoker, token)
    } catch (err: any) {
      json(res, {
        error: `A Drive-on nem tudtam létrehozni a mentés-mappát: ${String(err?.message || err).slice(0, 200)}`,
        code: 'drive_error',
      }, 502)
      return true
    }
    const pair: SyncPair = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      account,
      folderId,
      name: mentesMappaNev(rel),
      backup: true,
      localPath: mentesUtNorm(rel),
      addedAt: new Date().toISOString(),
    }
    cfg.pairs.push(pair)
    saveSyncConfig(cfg)
    json(res, { ok: true, pair })
    return true
  }

  if (path === '/api/drive/sync/remove' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const id = String(data.id || '')
    const cfg = loadSyncConfig()
    const before = cfg.pairs.length
    cfg.pairs = cfg.pairs.filter((p) => p.id !== id)
    delete cfg.state[id]
    saveSyncConfig(cfg)
    // A LEMEZRE nem nyulunk: a mar lehozott fajlok a tieid, egy kapcsolat
    // megszuntetese nem viheti el oket.
    json(res, { ok: true, removed: before - cfg.pairs.length })
    return true
  }

  if (path === '/api/drive/sync/run' && method === 'POST') {
    if (job?.running) { json(res, { error: 'A szinkronizálás már fut.', code: 'already_running', job }, 409); return true }
    const health = depotHealth()
    if (!health.writable) { json(res, { error: health.message, code: 'depot_unreachable' }, 409); return true }
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const only = String(data.id || '')
    const cfg = loadSyncConfig()
    const pairs = only ? cfg.pairs.filter((p) => p.id === only) : cfg.pairs
    if (!pairs.length) { json(res, { error: 'nincs szinkronizálandó mappa', code: 'no_pairs' }, 400); return true }
    job = {
      running: true,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: new Date().toISOString(), finishedAt: null, pair: '',
      downloaded: 0, uploaded: 0, trashed: 0, upToDate: 0, skipped: 0, failed: 0, bytes: 0, errors: [], current: '',
    }
    void runSync(pairs).catch((err) => {
      logger.error({ err: err?.message }, '[drive-sync] a futas megallt')
      if (job) { job.running = false; job.finishedAt = new Date().toISOString(); job.errors.push(String(err?.message || err)) }
    })
    json(res, { ok: true, job })
    return true
  }

  // MI MARADT KI -- nevvel, teljes helyi utvonallal, Drive-linkkel.
  //
  // Boss, 2026-08-16: "kellene az eleresi utvonaluk mindegyiknek es a neve a
  // filenek. mert hogy ha automatan nem ment, akor majd kezzel megprobalom a
  // felhoben levo driv rol lementeni a szamitogepre." Ez a vegpont EZT adja.
  //
  // Alapbol a LEGUTOBBI futas hibai jonnek (`run=last`): a Boss a most latott
  // "19 nem sikerult" szamhoz keresi a neveket, nem az osszes valahai hibahoz.
  // `run=all` a teljes lista, `run=<runId>` egy korabbi futase.
  if (path === '/api/drive/sync/failures' && method === 'GET') {
    const runs = syncFailureRuns()
    const kert = ctx.url.searchParams.get('run') || 'last'
    const runId = kert === 'all' ? undefined : (kert === 'last' ? (job?.runId || runs[0]?.runId) : kert)
    // `run=last`, de meg egy futas sem hagyott hibat: ures lista, NEM az osszes.
    const failures = kert !== 'all' && !runId ? [] : loadSyncFailures({ runId, limit: 2_000 })
    json(res, {
      runId: runId || null,
      runs,
      failures,
      // Egy gombbal kimasolhato alak -- ezzel all neki a kezi lementesnek.
      text: failuresAsText(failures),
    })
    return true
  }

  if (path === '/api/drive/sync/failures/clear' && method === 'POST') {
    clearSyncFailures()
    json(res, { ok: true })
    return true
  }

  // KULSO TORLES ELLENI VEDELEM (6. pont) -- allapot es naplo.
  //
  // Friss telepitesen ez a vegpont is valaszol: a vedelem BE, a lista ures, es
  // az `summary` megmondja, hogy azert ures, mert MEG NEM FUTOTT ilyen
  // szinkron -- nem azert, mert nem tortent semmi.
  if (path === '/api/drive/sync/external' && method === 'GET') {
    const lang = ctx.url.searchParams.get('lang') === 'en' ? 'en' : 'hu'
    const load = loadExternalChanges({ limit: 500 })
    json(res, {
      enabled: externalGuardEnabled(),
      changes: load.list,
      fileExists: load.fileExists,
      readError: load.readError,
      summary: externalSummaryText(load, lang),
    })
    return true
  }

  if (path === '/api/drive/sync/external' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    if (data.clear === true) {
      // Csak a NAPLOT uriti. Fajlt nem torol -- itt nincs mit elveszteni.
      clearExternalChanges()
      json(res, { ok: true, enabled: externalGuardEnabled(), cleared: true })
      return true
    }
    if (typeof data.enabled !== 'boolean') {
      json(res, { error: 'Hiányzik, hogy be- vagy kikapcsoljam a védelmet.', code: 'bad_request' }, 400)
      return true
    }
    setExternalGuardEnabled(data.enabled)
    json(res, { ok: true, enabled: data.enabled })
    return true
  }

  return false
}
