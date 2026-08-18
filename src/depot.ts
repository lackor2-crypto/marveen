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
import { join, dirname } from 'node:path'
import { STORE_DIR, DEPOT_ROOT_CONFIGURED } from './config.js'
import { normalizeDepotPath } from './depot-browse.js'

/**
 * A REGI szerkezet gyokere: `fiokok/<fiok>/<fajta>`.
 *
 * 2026-08-15-tol mar nem ide irunk (lasd `depotAccountDir`), de a nev megmarad,
 * mert az egyszeri atkoltoztetes innen emeli at, ami mar lejott.
 */
export const DEPOT_ACCOUNTS = 'fiokok'
/** Amibol dolgozol. */
export const DEPOT_PROJECTS = 'projektek'
/** Ideiglenes, felkesz dolgok. */
export const DEPOT_WORK = 'munka'
/** Biztonsagi mentesek. */
export const DEPOT_BACKUPS = 'mentesek'
/** Amihez soha nem kell hozzanyulnod (adatbazis, naplok). */
export const DEPOT_SYSTEM = 'rendszer'

/** Egy fiokon belul: a Google Fotok kepei. */
export const DEPOT_PHOTOS = 'fotok'
/** Egy fiokon belul: a Google Drive fajljai. */
export const DEPOT_DRIVE = 'drive'

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
      const to = join(root, fajta, fiok)
      try {
        if (!statSync(from).isDirectory()) continue
        if (existsSync(to)) continue
        mkdirSync(dirname(to), { recursive: true })
        renameSync(from, to)
        mozgatott.push(`${DEPOT_ACCOUNTS}/${fiok}/${fajta} -> ${fajta}/${fiok}`)
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
      message: 'Nincs depó beállítva – minden a régi helyén marad.',
    }
  }
  let exists = false
  try {
    exists = existsSync(root) && statSync(root).isDirectory()
  } catch {
    exists = false
  }
  if (!exists) {
    return {
      configured: true, root, exists: false, writable: false,
      message: `A depó mappája nem érhető el: ${root}. `
        + 'Ha külső lemezen van, csatlakoztasd; ha Windows-mappa, lehet, hogy a '
        + 'kapcsolat megszakadt. Amíg nem érhető el, nem mentek oda semmit.',
    }
  }
  const probe = join(root, '.marveen-iras-proba')
  try {
    writeFileSync(probe, 'proba')
    rmSync(probe, { force: true })
  } catch {
    return {
      configured: true, root, exists: true, writable: false,
      message: `A depó mappája megvan, de nem tudok bele írni: ${root}. `
        + 'Ellenőrizd a mappa jogosultságait.',
    }
  }
  return {
    configured: true, root, exists: true, writable: true,
    message: `A depó rendben: ${root}`,
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
          message: `A depó helye nem érhető el: ${parent} nincs meg. `
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

  const created: string[] = []
  // `drive` es `fotok` mostantol FELUL van (`drive/lackor2`), ezert a vazban is
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
