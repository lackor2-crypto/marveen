// A DEPO: egy hely a szamitogepen, ahol a Marveen minden HOZZAD tartozo fajlja
// van. Fotok, Drive-fajlok, projektek.
//
// Boss, 2026-08-15: "A szamitogepen a legnagyobb Winchesteren nyitni kell egy
// mappat, mondjuk Marvin mappa [...] egy ilyen depot kellene letrehozni, ugy
// mint a GitHubnal van egy depo, es az alatt van minden."
//
// Miert nem eleg a store/ mappa, ami eddig volt?
//   1. A TELEPITESI mappan belul van. Egy ujratelepites vagy egy verziovaltas
//      kozvetlen kozelebe kerul mindennek, ami a tied.
//   2. Nem talalod meg. A Boss dontese (2026-08-15): "egy komuves user nem tud
//      bemenni az ubuntu ala. az bonyolult neki. [...] meg ha lassabb is, de a
//      hasznalhatosag a fontos." Ezert a depo alapertelmezett helye egy
//      Windows-mappa (D:\Marveen), amit a Fajlkezeloben megnyitsz, elmentesz,
//      vagy atmasolsz egy kulso lemezre -- barmiféle parancssor nelkul.
//   3. Rendezetlen. A store/ gyokereben 83 tetel hevert egymas mellett.
//
// Mibe kerul a Windows-mappa? Merve (2026-08-15, ugyanaz a 30 valodi kep):
// egy kep megnyitasa 1,7 ms helyett 5,7 ms; egy 40 kepes racs igy 0,16
// masodperccel lassabb. A bolyegkep-keszites viszont EGYALTALAN nem lassul
// (4,44 vs 4,39 mp), mert ott a szamolas visz mindent. Vagyis a lassulas ezen
// a munkan nem erzekelheto.
//
// A veszely viszont valodi, es merve is van: ugyanezen a napon a WSL
// Windows-lemez osszekottetese MENET KOZBEN elszallt (`/mnt/c` es `/mnt/d` is
// I/O hibat adott, 50 ora uzem utan). Ezert van a `depotHealth()`: ha a depo
// nem erheto el, azt KIMONDJUK, nem pedig felig irunk bele valamit.
import { existsSync, mkdirSync, statSync, writeFileSync, rmSync, rmdirSync, readdirSync, renameSync } from 'node:fs'
import { depotRemountPlan, type RemountPlan } from './depot-remount.js'
import { join, dirname } from 'node:path'
import { STORE_DIR, DEPOT_ROOT_CONFIGURED, APP_LANG } from './config.js'
import { normalizeDepotPath } from './depot-browse.js'

/**
 * A REGI szerkezet gyokere: `fiokok/<fiok>/<fajta>`.
 *
 * 2026-08-15-tol mar nem ide irunk (lasd `depotAccountDir`), de a nev megmarad,
 * mert az egyszeri atkoltoztetes innen emeli at, ami mar lejott.
 */
export const DEPOT_ACCOUNTS = 'fiokok'

/**
 * A TECHNIKAI mappak a `RENDSZER` ala kerulnek -- KIVEVE a `drive`-ot es a
 * `fotok`-ot.
 *
 * Boss, 2026-08-21: "ami most jelenleg van az intezo alatt azokat [...] helyezd
 * at abba amit most kitalaltunk fa rendszerbe. de ne maradjanak ott kint.
 * projektek [...] munka stb." -- majd nem sokkal kesobb, pontositva: "a drive es
 * a fotok mappakat hagyd meg. az jol sikerult es atlathato. egyutt van minden.
 * ahhoz ne nyulj. egyenlore."
 *
 * Ezert a `drive/` es a `fotok/` a gyokerben MARAD, es a szinkron utvonalai sem
 * valtoznak (a ket mappaban ~30 GB all -- egy elmozditas a letoltoket is
 * atallitana, es az a kockazatos resz). A tobbi technikai mappa viszont a
 * `RENDSZER` ala megy, hogy a gyokerben a LOGIKAI eletfa lassek: sajat nev,
 * CEGEK, MEDIA, ... (specifikacio 4. es 34. pont).
 *
 * A nevek a telepites nyelvet kovetik, es EGYEZNIUK KELL a `life-tree.ts`
 * `NAMES` tablajaval (`system`, `storages`, `git`, `marvin`) -- kulonben az
 * eletfa `RENDSZER`-t hozna letre, a szinkron meg `SYSTEM`-be irna. Erre teszt
 * all.
 *
 * Miert itt allnak es nem a `life-tree.ts`-ben? Mert a `life-tree` mar most is
 * innen importal (`depotRoot`), es forditva korkoros import lenne.
 */
const HU = APP_LANG === 'hu'

/** A technikai reteg gyokere a depoban. */
export const DEPOT_SYSTEM_ROOT = HU ? 'Rendszer' : 'System'
/** A tarolok kozos mappaja: ide megy a Drive es a Google Fotok is. */
export const DEPOT_STORAGES = `${DEPOT_SYSTEM_ROOT}/${HU ? 'Tárolók' : 'Storages'}`

// A specifikacio 36. pontja szerint a `Rendszer` alatt EGYETLEN ag all, a
// `Tárolók`. Ezert a technikai munkamappak nem a `Rendszer` gyokerebe kerulnek
// (ott negy idegen mappa allt: Git, Munka, Mentések, Marvin), hanem a `Tárolók`
// ala -- ahogy a Boss is kerte: "csak a taroloknak kellene ott lennie es az
// alatt a drive es git stb.".
/** Amibol dolgozol: a git-repok es a projektmunkak helye. */
export const DEPOT_PROJECTS = `${DEPOT_STORAGES}/Git`
/**
 * A Marveen sajat munkamappai: NEM tarolok.
 *
 * Boss, 2026-08-21: "A tarolok alol torold ki a mentesek es munka mappat.
 * azok nem tarolok!" -- igaza van: a `Tárolók` ala az tartozik, aminek egy
 * KULSO FIOK all mogotte (Drive, Google Fotok, Git). A munkamappa es a mentes
 * a Marveen sajatja, ezert a `Rendszer/Marveen` ala kerul. Igy a `Tárolók`
 * lista tenyleg csak tarolokat mutat, es a `Rendszer` alatt tovabbra is
 * ketto, egyertelmuen gepi ag all.
 */
export const DEPOT_MARVEEN = `${DEPOT_SYSTEM_ROOT}/Marveen`
/** Ideiglenes, felkesz dolgok. */
export const DEPOT_WORK = `${DEPOT_MARVEEN}/${HU ? 'Munka' : 'Work'}`
/** Biztonsagi mentesek. */
export const DEPOT_BACKUPS = `${DEPOT_MARVEEN}/${HU ? 'Mentések' : 'Backups'}`
/**
 * A Marveen sajat, technikai masolatai (ma: a fotok-index tukorkepe).
 *
 * NEM kap sajat `Marvin` mappat a fa gyokereben: a 32. pont szerint a Marveen
 * rendszerfajljai a sajat kornyezeteben maradnak, a 8. alapszabaly szerint
 * pedig a "Marvin" nev a SZEMELYES projektage (`<szemely>/Projektek/Marvin`).
 * Igy a tukor a fotok-tarolo melle kerul, ahova tartalmilag is tartozik.
 */
export const DEPOT_SYSTEM = `${DEPOT_STORAGES}/${HU ? 'GOOGLE_PHOTOS' : 'GOOGLE_PHOTOS'}`

/**
 * A Google Fotok kepei, fiokonkent almappaban.
 *
 * A TAROLOK ala tartozik, nem a gyokerbe: ez nem egy elet-terulet, hanem egy
 * kulso szolgaltatas helyi masolata. (A Boss korabbi "hagyd meg a drive es a
 * fotok mappakat" kerese az IRODA MENU ket oldalara vonatkozott -- azok
 * valtozatlanok --, nem az Intezo gyokerere.)
 */
export const DEPOT_PHOTOS = `${DEPOT_STORAGES}/GOOGLE_PHOTOS`
/**
 * A Google Drive fajljai, fiokonkent almappaban.
 *
 * A TAROLOK ala tartozik -- lasd a `DEPOT_PHOTOS` megjegyzeset.
 */
export const DEPOT_DRIVE = `${DEPOT_STORAGES}/Drive`

/**
 * A REGI, lapos nevek ugyanezekre. KELLENEK, mert ket helyen a mappa NEVE a
 * bemenet, nem a celja: a `fiokok/<fiok>/fotok` elrendezes belso mappaneve, es
 * a gyokerben talalt regi `drive`/`fotok`, amit at kell emelnunk. Ha ezekre a
 * fenti konstansokat hasznalnank, az atkoltoztetes sajat magat keresne.
 */
export const LEGACY_KIND_PHOTOS = 'fotok'
export const LEGACY_KIND_DRIVE = 'drive'

/**
 * A REGI, lapos helyek -- ahonnan egyszer atkoltoztetunk.
 *
 * Nem torlunk semmit: `renameSync`-kel emeljuk at a mappat a helyere. Ugyanazon
 * a lemezen ez pillanatszeru es nem duplazza a helyet. A `drive` es a `fotok`
 * IS a listan van: ezek a TAROLOK ala valok, nem az Intezo gyokerebe.
 */
// A SORREND SZAMIT. A `rendszer` all elol, mert a celja (`RENDSZER/MARVIN`)
// kis-nagybetuben azonos a sajat nevevel: Windowson eloszor ideiglenes nevre
// kell tenni. Ha addigra mar bekerult volna melle a `GIT` vagy a `MUNKA`, azt
// az ideiglenes atnevezes MAGAVAL VINNE. Uresen viszont nem visz semmit.
const LEGACY_FLAT_DIRS: Array<{ from: string; to: string }> = [
  { from: 'rendszer',  to: DEPOT_SYSTEM },
  { from: 'projektek', to: DEPOT_PROJECTS },
  { from: 'munka',     to: DEPOT_WORK },
  { from: 'mentesek',  to: DEPOT_BACKUPS },
  { from: LEGACY_KIND_DRIVE,  to: DEPOT_DRIVE },
  { from: LEGACY_KIND_PHOTOS, to: DEPOT_PHOTOS },
]

/**
 * Egyszeri atkoltoztetes a lapos szerkezetbol a `RENDSZER` ala.
 *
 * Harom szabaly, mind adatvesztes ellen:
 *   1. Ha a CEL mar letezik, NEM nyulunk hozza. Inkabb marad ket helyen, mint
 *      hogy barmit felulirjunk.
 *   2. Ures forrasmappat nem koltoztetunk, csak torlunk (ha ures) -- egy ures
 *      `munka/` mappa atemelese csak zajt csinalna.
 *   3. Minden hiba lenyelve: egy sikertelen koltoztetes nem allithatja meg az
 *      indulast, a fajlok ilyenkor a regi helyukon maradnak es lathatoak.
 */
export function migrateFlatDepotDirs(): Array<{ from: string; to: string }> {
  const root = depotRoot()
  if (!root) return []
  const moved: Array<{ from: string; to: string }> = []
  for (const { from, to } of LEGACY_FLAT_DIRS) {
    const src = join(root, from)
    const dst = join(root, ...to.split('/'))
    try {
      if (!existsSync(src) || !statSync(src).isDirectory()) continue
      // A `RENDSZER` es `RENDSZER/MARVIN` nevek Windowson kis-nagybetu-azonosak
      // a regi `rendszer`-rel: ilyenkor a `renameSync` onmagara mutatna.
      if (dst === src) continue
      if (existsSync(dst)) continue
      const entries = readdirSync(src).filter((f) => !f.startsWith('.'))
      if (!entries.length) { try { rmdirSync(src) } catch { /* maradhat */ } continue }

      // KIS-NAGYBETU CSAPDA. Windowson (es macOS-en) a `rendszer` es a
      // `RENDSZER` UGYANAZ a mappa. A `rendszer -> RENDSZER/MARVIN` koltoztetes
      // igy azt jelentene, hogy a mappat sajat magaba mozgatjuk (EINVAL), es a
      // Boss adatbazisa meg naploi ott ragadnanak. Ezert ilyenkor eloszor egy
      // ideiglenes nevre tesszuk at, es csak onnan a helyere.
      const top = to.split('/')[0]
      let source = src
      if (top.toLowerCase() === from.toLowerCase() && top !== from) {
        const tmp = join(root, `${from}.koltozes`)
        if (existsSync(tmp)) continue
        renameSync(src, tmp)
        source = tmp
      }
      mkdirSync(dirname(dst), { recursive: true })
      renameSync(source, dst)
      moved.push({ from, to })
    } catch { /* marad a regi helyen, es ott lathato is */ }
  }
  return moved
}

/**
 * Hol van a depo?
 *
 * Ha nincs beallitva, a valasz `null`, es MINDEN a regi helyen marad. Ez
 * szandekos: egy meglevo telepites ugy viselkedik, mint eddig, amig a
 * felhasznalo maga nem valaszt depot.
 *
 * Sorrend: a Beallitasok oldalon mentett ertek (illetve a .env) ELOZI a
 * kornyezeti valtozot. Forditva egy regen ottfelejtett `MARVEEN_DEPOT=`
 * kornyezeti valtozo csendben felulirna azt, amit a felhasznalo a feluleten
 * eppen beallitott -- a mentes latszolag sikerulne, es semmi nem valtozna.
 *
 * Windows-alakot is elfogadunk (`D:\Marveen`), es magunk forditjuk le arra,
 * amit a Linux ert (`/mnt/d/Marveen`). Aki beallit egy depot, annak nem kell
 * tudnia, milyen alakban vart utvonalat a program belul -- ugyanez a forditas
 * all a mappavalaszto mogott is.
 */
export function depotRoot(): string | null {
  const raw = (DEPOT_ROOT_CONFIGURED || process.env.MARVEEN_DEPOT || '').trim()
  return raw ? normalizeDepotPath(raw) : null
}

/**
 * A fiok egy adatfajtajanak a mappaja: `drive/lackor2`, `fotok/lackor2`.
 *
 * A FAJTA van felul, nem a fiok. Boss 2026-08-15: "a szinkronizalas helye meg a
 * gepemen egyertelmuen a drive mappaba a drive-k fognak menni. pl. a lackor2
 * drive az a lackor2 nevu mappaba. [...] a fotokba ugyanigy: a fotok mappaba
 * lesz lackor2, usalackor stb. nevu mappak."
 *
 * (Korabban forditva volt -- `fiokok/<fiok>/fotok` --, azzal az indokkal, hogy
 * egy fiok levalasztasakor egyetlen mappat kell torolni. A Boss viszont a
 * mappat NEZI is, nem csak a program: igy ket helyen kell keresni, es ez
 * fontosabb. A regi helyen maradt fajlokat a `migrateLegacyAccountDirs()` emeli
 * at, egyszer.)
 *
 * `null`, ha nincs depo (ilyenkor a hivo a regi helyet hasznalja).
 */
export function depotAccountDir(account: string, kind: string): string | null {
  const root = depotRoot()
  if (!root) return null
  return join(root, kind, safeDepotName(account))
}

/**
 * Egyszeri atkoltoztetes a REGI szerkezetbol: `fiokok/<fiok>/<fajta>` ->
 * `<fajta>/<fiok>`.
 *
 * ATNEVEZES, nem masolas: ugyanazon a lemezen pillanatszeru, es nem duplazza a
 * helyet. Ha a cel MAR letezik, NEM nyulunk hozza -- inkabb marad ket helyen,
 * mint hogy barmit felulirjunk. Minden hiba lenyelve: egy sikertelen koltoztetes
 * nem allithatja meg az indulast, a fajlok ilyenkor a regi helyukon maradnak.
 */
/** Regi belso mappanev -> a mai helye. */
const LEGACY_KIND_TARGETS: Record<string, string> = {
  [LEGACY_KIND_PHOTOS]: DEPOT_PHOTOS,
  [LEGACY_KIND_DRIVE]: DEPOT_DRIVE,
}

export function migrateLegacyAccountDirs(): string[] {
  const root = depotRoot()
  if (!root) return []
  const regi = join(root, DEPOT_ACCOUNTS)
  const mozgatott: string[] = []
  let fiokok: string[] = []
  try {
    if (!existsSync(regi) || !statSync(regi).isDirectory()) return []
    fiokok = readdirSync(regi).filter((f) => !f.startsWith('.'))
  } catch { return [] }
  for (const fiok of fiokok) {
    let fajtak: string[] = []
    try { fajtak = readdirSync(join(regi, fiok)).filter((f) => !f.startsWith('.')) } catch { continue }
    for (const fajta of fajtak) {
      const from = join(regi, fiok, fajta)
      // A REGI elrendezesben a mappa neve `fotok`/`drive`; a mai celjuk viszont
      // a TAROLOK alatt van. Aminek nincs uj helye, az marad a sajat neven.
      const cel = LEGACY_KIND_TARGETS[fajta] || fajta
      const to = join(root, ...cel.split('/'), fiok)
      try {
        if (!statSync(from).isDirectory()) continue
        if (existsSync(to)) continue
        mkdirSync(dirname(to), { recursive: true })
        renameSync(from, to)
        mozgatott.push(`${DEPOT_ACCOUNTS}/${fiok}/${fajta} -> ${cel}/${fiok}`)
      } catch { /* marad, ahol volt */ }
    }
    // Az ures fiok-mappa mar csak zavar. `rmdirSync`, NEM `rmSync`: ez ures
    // mappat torol, es barmi bennmaradt tartalomnal magatol elhasal (ENOTEMPTY).
    // (A `rmSync(..., { recursive: false })` mappara mindig hibat dob -- ez a
    // teszt bukott el elsore: a `fiokok` ottmaradt.)
    try { rmdirSync(join(regi, fiok)) } catch { /* nem ures, marad */ }
  }
  try { rmdirSync(regi) } catch { /* nem ures, marad */ }
  return mozgatott
}

/**
 * Egy nev, ami mappanevnek is jo -- Windowson is.
 *
 * A Windows tobb karaktert tilt, mint a Linux (`: * ? " < > |`), es a depo
 * alapertelmezetten EPPEN egy Windows-mappa. Egy `usalackor@gmail.com` fiok
 * neve igy is olvashato marad, csak a tiltott jelek helyere `_` kerul.
 */
export function safeDepotName(name: string): string {
  // A szelekrol ELOSZOR a szokozok, es csak AZUTAN a csere. Forditva a vegen
  // allo szokozbol elobb `_` lenne, es a "ne vegzodjon szokozzel" szabaly mar
  // nem talalna meg: `lackor2 ` fiokbol `lackor2_` mappa lenne -- mukodik, de
  // nem az, amit a felhasznalo lat a fiokja neveként.
  const cleaned = String(name || '').trim().replace(/[^a-zA-Z0-9._@-]/g, '_')
  // Windowson a ponttal vegzodo mappanev nem nyithato meg.
  const trimmed = cleaned.replace(/\.+$/, '')
  return trimmed || '_'
}

export interface DepotHealth {
  /** Be van-e egyaltalan allitva depo. */
  configured: boolean
  /** Az utvonal, ahogy be van allitva (null, ha nincs). */
  root: string | null
  /** Letezik-e es mappa-e. */
  exists: boolean
  /** Tudunk-e bele VALOBAN irni (nem a jogosultsag-bitekbol kovetkeztetve). */
  writable: boolean
  /** Emberi mondat arrol, mi a helyzet -- ez megy ki a feluletre. */
  message: string
  /**
   * Ha a depo Windows-meghajton van ES nem erheto el: hogyan lehet
   * helyreallitani. `null`, ha nem ez a helyzet -- akkor az ujracsatolas nem
   * a valasz, es javasolni is karos volna.
   *
   * A hibaut nem allhat meg a diagnozisnal: minden hibauzenetnek a KOVETKEZO
   * LEPESSEL kell vegzodnie.
   */
  repair: RemountPlan | null
}

/**
 * El-e a depo?
 *
 * Az irast VALODI irassal probaljuk ki, nem a jogosultsagi bitekbol
 * kovetkeztetve. Mert a mert hibamod (elszallt WSL-osszekottetes) eppen olyan,
 * hogy a mappa "ott van" a beallitasban, de minden muvelet I/O hibat ad.
 */
export function depotHealth(): DepotHealth {
  const root = depotRoot()
  if (!root) {
    return {
      configured: false, root: null, exists: false, writable: false,
      message: 'Nincs raktár beállítva – minden a régi helyén marad.',
      repair: null,
    }
  }
  const terv = depotRemountPlan(root)
  let exists = false
  try {
    exists = existsSync(root) && statSync(root).isDirectory()
  } catch {
    exists = false
  }
  if (!exists) {
    return {
      configured: true, root, exists: false, writable: false,
      repair: terv,
      message: terv
        ? `A raktár mappája nem érhető el: ${root}. A Windows-meghajtó kapcsolata `
          + 'szakadt el a WSL felé (ez a WSL ismert hibája újraindítás után). '
          + 'Két javítás van: a teljes helyreállítás Windowsból a `wsl --shutdown`, '
          + 'utána indul újra minden; ha nem akarod leállítani a Marveent, a Raktár '
          + 'oldalon ott a célzott újracsatoló parancs. Amíg nem érhető el, nem '
          + 'mentek oda semmit.'
        : `A raktár mappája nem érhető el: ${root}. Ha külső lemezen van, `
          + 'csatlakoztasd. Amíg nem érhető el, nem mentek oda semmit.',
    }
  }
  const probe = join(root, '.marveen-iras-proba')
  try {
    writeFileSync(probe, 'proba')
    rmSync(probe, { force: true })
  } catch {
    return {
      configured: true, root, exists: true, writable: false,
      repair: terv,
      message: `A raktár mappája megvan, de nem tudok bele írni: ${root}. `
        + (terv
          ? 'Egy Windows-meghajtónál ez tipikusan az elszakadt WSL-kapcsolat: a mappa '
            + 'látszik, de minden művelet hibát ad. A Raktár oldalon ott a helyreállító parancs.'
          : 'Ellenőrizd a mappa jogosultságait.'),
    }
  }
  return {
    configured: true, root, exists: true, writable: true,
    message: `A raktár rendben: ${root}`,
    repair: null,
  }
}

/**
 * A depo alapmappai. Csak akkor keszulnek el, ha a depo VALOBAN irhato --
 * kulonben egy elszallt kapcsolatnal ures mappa-vazat hoznank letre valahol.
 */
export function ensureDepotSkeleton(): { created: string[]; health: DepotHealth } {
  const health = depotHealth()
  if (!health.configured || !health.root) return { created: [], health }
  // Ha meg nem letezik a gyoker, EGY probat teszunk a letrehozasara: egy
  // frissen valasztott depot igy nem kell kezzel megcsinalni.
  if (!health.exists) {
    // De CSAK akkor, ha a szulomappa mar ott van.
    //
    // Enelkul a `recursive: true` maga huzna fel a hianyzo szulot is -- es
    // eppen ez a legveszelyesebb hibamod: ha a `/mnt/d` elszall (a mert eset:
    // a WSL drvfs-atjaro meghalt menet kozben), akkor a `/mnt/d/Marveen`
    // letrehozasa egy `/mnt/d` nevu KOZONSEGES linux-mappat csinalna a WSL
    // gyokeren, es a Marveen boldogan irna oda a kepeket -- nem a D: lemezre,
    // hanem a semmibe. A szulo letezese pont azt kulonbozteti meg, hogy "a
    // lemez ott van, csak a mappa nincs meg" (ezt megcsinaljuk) attol, hogy
    // "a lemez nincs ott" (ehhez nem nyulunk).
    const parent = dirname(health.root)
    let parentOk = false
    try { parentOk = existsSync(parent) && statSync(parent).isDirectory() } catch { parentOk = false }
    if (!parentOk) {
      return {
        created: [],
        health: {
          ...health,
          message: `A raktár helye nem érhető el: ${parent} nincs meg. `
            + 'Ha külső lemezre mutat, csatlakoztasd; ha Windows-mappa, a kapcsolat '
            + 'megszakadt. Amíg nem érhető el, nem hozok létre semmit és nem mentek oda.',
        },
      }
    }
    try { mkdirSync(health.root, { recursive: true }) } catch { return { created: [], health } }
    const again = depotHealth()
    if (!again.writable) return { created: [], health: again }
    return ensureDepotSkeleton()
  }
  if (!health.writable) return { created: [], health }

  // A regi szerkezet atemelese ELOBB tortenik, mint az uj mappak letrehozasa:
  // az atnevezes csak akkor mukodik, ha a cel MEG NINCS meg (`drive/`, `fotok/`
  // uresen letrehozva is "letezo cel" lenne az almappaknak).
  migrateLegacyAccountDirs()
  migrateFlatDepotDirs()

  const created: string[] = []
  // A fajta van felul, a fiok alatta (`.../DRIVE/lackor2`), ezert a vazban is
  // itt a helyuk -- igy egy ures depoban is latszik, mi hova fog kerulni.
  for (const d of [DEPOT_DRIVE, DEPOT_PHOTOS, DEPOT_PROJECTS, DEPOT_WORK, DEPOT_BACKUPS, DEPOT_SYSTEM]) {
    const p = join(health.root, d)
    if (existsSync(p)) continue
    try { mkdirSync(p, { recursive: true }); created.push(d) } catch { /* a tobbi meg keszuljon el */ }
  }
  return { created, health }
}

/**
 * Hol vannak egy fiok kepei MOST? A depoban, vagy meg a regi helyen?
 *
 * Az atkoltozes nem egyik pillanatrol a masikra tortenik, es egy felbeszakadt
 * koltozes utan is mukodnie kell az oldalnak. Ezert a szabaly: ha a depoban
 * MAR van ilyen mappa, az a hiteles; kulonben a regi hely.
 */
export function resolvePhotoDir(account: string, legacyDir: string): string {
  const d = depotAccountDir(account, DEPOT_PHOTOS)
  if (!d) return legacyDir
  try {
    if (existsSync(d) && statSync(d).isDirectory()) return d
  } catch { /* nem erheto el -- maradunk a regin */ }
  return legacyDir
}

/** A regi (telepitesi mappan beluli) tarhely, ahonnan koltozunk. */
export const LEGACY_STORE = STORE_DIR

/** Hany fajl van egy mappaban? Hianyzo mappanal 0, nem hiba. */
export function countFiles(dir: string): number {
  try {
    return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')).length : 0
  } catch {
    return 0
  }
}
