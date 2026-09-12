/**
 * MAPPA-TALLOZAS A VEGREHAJTO GEPEN.
 *
 * Boss, 2026-09-12: "majd megcsinalom azt hogy az agent kartyajan kivalasztom a
 * munkamappat ahol dolgozhat. de nezd meg egyaltalan ki tudom e valasztani. mert
 * neztem es nem nagyon lehet. ott kitallozast kellene beepiteni. de valami kezzel
 * kell beirni verzio van. az nem jo. tehat a gyokermappat kivalasztani kitallozva
 * lehessen."
 *
 * MIERT NEM EGYSZERU. A Marveen a WSL-ben fut, a projektek a Windowson vannak,
 * es ezen a gepen a `/mnt/c` bejarasa EIO-val all le -- tehat a szerver SAJAT
 * MAGA nem tudja felsorolni a Windows-mappakat, es tippelnie tilos. A
 * vegrehajto (`marvin-code-worker.ps1`) viszont ott fut, ahol a mappak vannak.
 *
 * Nincs nyitott portunk a Windows fele: minden forgalom KIFELE indul. Ezert a
 * tallozas ugyanazon a csatornan megy, mint a ful-bezaras kerese -- a kerest a
 * rendszeres jelentes VALASZA viszi ki, az eredmenyt egy kulon POST hozza
 * vissza. Emiatt a valasz nem azonnali: a felulet addig `pending` allapotot lat.
 *
 * A NULLA KET DOLGOT JELENTHET -- itt kulonosen elesen, ezert a valasz allapota
 * SOHA nem egy ures lista onmagaban:
 *   'pending'    -- a keres kiment, meg nem jott valasz
 *   'no_worker'  -- nem fut (vagy regi) a vegrehajto: NEM LATUNK ODA
 *   'ok'         -- megnezte; az `entries` ures listaja azt jelenti, hogy a
 *                   mappa TENYLEG ures
 *   'error'      -- a gep sajat hibauzenetevel (nem talalgatott okkal)
 *   'expired'    -- tul regi keres, a valasz mar nem johet meg
 */

/** Egy bejegyzes a tallozoban. Csak MAPPAK -- fajlt nem kinalunk, mert
 *  munkamappat valasztunk, nem fajlt. */
export type BrowseEntry = {
  /** A megjeleno nev (a mappa utolso szegmense, vagy meghajtonal `C:\`). */
  name: string
  /** A TELJES ut a vegrehajto gepen -- ezt kapja a `workspacePath`. */
  path: string
  /** Van-e benne `.git` -- ebbol latszik, melyik a valodi projekt-gyoker.
   *  `null` = nem neztuk meg / nem lattunk bele (jogosultsag). */
  isRepo: boolean | null
}

export type BrowseStatus = 'pending' | 'ok' | 'error' | 'no_worker' | 'expired'

export type BrowseResult = {
  id: string
  /** Amit kertunk. Ures string = a gep GYOKEREI (meghajtok). */
  path: string
  status: BrowseStatus
  /** A szulomappa utja, vagy `null`, ha mar a gyokerben vagyunk (nincs "fel"). */
  parent: string | null
  entries: BrowseEntry[]
  /** A gep SAJAT hibauzenete, ha volt. Sosem talalgatott ok. */
  error: string | null
  createdAt: number
  answeredAt: number | null
}

/** Meddig var a felulet egy valaszra. A vegrehajto ~10 mp-enkent jelent, tehat
 *  ez tobb korre eleg -- de nem vegtelen: egy leallt vegrehajtonal a felulet
 *  ne porogjon orakig egy valaszon, ami sosem jon meg. */
export const BROWSE_TTL_MS = 90_000

/** A vegrehajto ennyi ideig latja a kerest a jelentese valaszaban. Rovidebb,
 *  mint a TTL: ha addig egyszer sem jelentkezett, a keres mar elavult. */
export const BROWSE_PICKUP_TTL_MS = 60_000

/**
 * EGY KERES ALLAPOTA, mellekhatas nelkul kiszamolva -- ez teszi tesztelhetove a
 * "nulla ket dolgot jelenthet" dontest adatbazis es halozat nelkul.
 *
 * @param req      a nyilvantartott keres
 * @param workerSeenAt  a vegrehajto utolso jelentkezese, vagy `null`, ha MEG
 *                      EGYSZER SEM jelentkezett (friss telepites)
 * @param workerStaleMs ennyi utan szamit a vegrehajto halottnak
 */
export function browseStatus(
  req: { answeredAt: number | null; status: BrowseStatus; createdAt: number },
  workerSeenAt: number | null,
  now: number,
  workerStaleMs: number,
): BrowseStatus {
  // Ami megjott, az megjott -- a vegrehajto kesobbi leallasa nem irja felul egy
  // mar meglevo, ervenyes valasz ertelmet.
  if (req.answeredAt !== null) return req.status
  // NEM LATUNK ODA. Ezt a `pending`-tol KULON kell mondani: a felhasznalonak az
  // elso azt uzeni, hogy varjon, a masodik azt, hogy indítsa el a vegrehajtot.
  // A `null` itt egyertelmuen azt jelenti, hogy meg egyszer sem jelentkezett.
  if (workerSeenAt === null || now - workerSeenAt > workerStaleMs) return 'no_worker'
  if (now - req.createdAt > BROWSE_TTL_MS) return 'expired'
  return 'pending'
}

/**
 * A SZULOMAPPA kiszamolasa Windows-uton. A szerver Linuxon fut, tehat a
 * `node:path` POSIX-valtozata volna kezugyben -- az viszont a `C:\x\y`-bol
 * ertelmetlenseget csinalna. Ezert sajat, kimondottan Windows-alaku logika.
 *
 * Visszaadott `null` = mar a legfelso szinten vagyunk (a meghajto gyokere vagy
 * egy UNC-megoszto gyokere), tehat nincs hova feljebb menni. A hivo ilyenkor a
 * MEGHAJTOK listajat kinalja (`path: ''`).
 */
export function windowsParent(p: string): string | null {
  const raw = (p || '').trim()
  if (!raw) return null
  const norm = raw.replace(/\//g, '\\').replace(/\\+$/, '')
  // UNC: \\gep\megoszto -- ennek a gyokere maga a megoszto, nem a gep.
  if (norm.startsWith('\\\\')) {
    const parts = norm.slice(2).split('\\').filter((x) => x.length > 0)
    if (parts.length <= 2) return null
    return '\\\\' + parts.slice(0, -1).join('\\')
  }
  // Meghajto-gyoker: `C:` vagy `C:\` -- nincs feljebb.
  if (/^[A-Za-z]:$/.test(norm)) return null
  const idx = norm.lastIndexOf('\\')
  if (idx < 0) return null
  const head = norm.slice(0, idx)
  if (/^[A-Za-z]:$/.test(head)) return head + '\\'
  if (head === '') return null
  return head
}

/** A megjeleno nev egy teljes utbol. Meghajtonal maga a `C:\`, kulonben az
 *  utolso szegmens -- igy a lista olvashato marad, a `path` viszont vegig
 *  teljes ut, tehat a valasztas nem fugg attol, hol jarunk. */
export function displayName(p: string): string {
  const norm = (p || '').replace(/\//g, '\\').replace(/\\+$/, '')
  if (/^[A-Za-z]:$/.test(norm)) return norm + '\\'
  const idx = norm.lastIndexOf('\\')
  return idx >= 0 ? norm.slice(idx + 1) || norm : norm
}
