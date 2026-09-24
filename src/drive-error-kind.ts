// MIERT utasitott el a Google -- egy helyen, mindenkinek ugyanaz.
//
// A Drive HAROM, gyokeresen kulonbozo dolgot mond ugyanazzal a szamkoddal
// (403), es a teendo mindharomnal mas:
//   - `quota`   : megtelt a tarhely. A fiok BELEP, helyet kell felszabaditani.
//   - `abusive` : a Google kartekonynak/spamnek jelolte a fajlt, es NEM adja
//                 oda egyetlen programnak sem. Se az ujralogin, se a
//                 helyfelszabaditas nem segit rajta.
//   - `auth`    : tenyleg nincs (mar) jogosultsag -> ujra be kell jelentkezni.
// Minden mas: `other` -- es ezt KI KELL MONDANI, nem beleeroltetni a harom
// kozul a legkozelebbibe.
//
// Valos kar, amiert ez kulon modul lett (Boss, 2026-09-22): a csupasz
// `\b403\b` mintat auth-hibanak vettuk, ezert hat kartekonynak jelolt .exe/.rar
// fajl 403-a "a Google-fiok (nyalomapuncidma) nem tud belepni" sorkent jelent
// meg -- miközben a fiok 4,82 GB / 15 GB-tal, elesben listazta a Drive-jat. A
// felulet olyan teendot tanacsolt (ujralogin), ami semmit nem old meg.

export type DriveErrorKind = 'quota' | 'abusive' | 'auth' | 'api_disabled' | 'other'

/**
 * A Google-projektben nincs bekapcsolva a Drive API (kanban f97acc32).
 *
 * Friss telepitesen ez az ELSO, amibe a felhasznalo belefut, ha a varazslo
 * "kapcsold be a szolgaltatasokat" lepeset kihagyta: a fiok belep, az
 * engedely megvan, de a Google MINDEN Drive-keresre 403-at ad ("Google Drive
 * API has not been used in project N before or it is disabled",
 * SERVICE_DISABLED / accessNotConfigured). Nem egy fajlrol szol, hanem az egesz
 * projektrol, es a teendo egy kapcsolo a Google Console-ban -- se ujralogin,
 * se holnapi ujraprobalas nem segit. Ezert nem mehet se az `auth`, se a
 * "Google nem adja ki" (besorolatlan) kosarba: az utobbi csendben elrejtene,
 * hogy a friss telepitesen SEMMI nem szinkronizal.
 */
export const DRIVE_API_KIKAPCSOLVA_RE = /SERVICE_DISABLED|accessNotConfigured|has not been used in project|API has not been used|drive api .*is disabled|it is disabled\b/i

/**
 * A bekapcsolo oldal cime. MI epitjuk, csupa szamjegybol: a hibauzenet a
 * Google-tol jovo kulso adat, abbol kimasolt cimet linkkent visszaadni nem
 * szabad (ugyanaz az elv, mint a `pickerApiDisabled`-nel).
 */
export function driveApiEnableUrl(reason: string): string {
  const base = 'https://console.cloud.google.com/apis/library/drive.googleapis.com'
  const m = /project[=/\s"']*(\d{4,})/i.exec(String(reason || ''))
  return m ? `${base}?project=${m[1]}` : base
}

/** Megtelt tarhely. A Google tobbfele szoveggel mondja, de a "quota" mindben ott van. */
export const DRIVE_KVOTA_RE = /storage ?quota|storagequotaexceeded|quota (has been )?exceeded|exceeded.*quota|elfogyott a tarhely/i

/** Kartekonynak/spamnek jelolt fajl -- a Google nem adja oda gepi letoltesre. */
export const DRIVE_ABUZIV_RE = /cannotdownloadabusivefile|identified as malware or spam/i

/**
 * VALODI hitelesitesi hiba.
 *
 * A 401 mindig az. A 403 viszont CSAK akkor, ha a Google szavai is azt
 * mondjak (`insufficientPermissions`, `authError`, lejart/visszavont
 * hozzajarulas). Egy 403, aminek nem ismerjuk az indoklasat, NEM auth --
 * inkabb legyen "ismeretlen elutasitas" oszinten, mint egy hamis teendo.
 */
export const DRIVE_AUTH_RE = /\b401\b|invalid authentication|unauthorized|invalid_grant|invalid credentials|insufficient permission|insufficientpermissions|autherror|access_denied|forbidden.*(token|credential)|the request is missing a valid api key|request had insufficient authentication scopes|no refresh token|nincs access_token|token .*(lejart|expired|revoked)/i

/**
 * Egy feljegyzett hiba-indok besorolasa.
 *
 * A sorrend szamit: a kvota es az abuziv eset KONKRETABB, mint az auth, es
 * mindketto 403-mal erkezik -- eloszor azokat kell kizarni.
 */
export function driveErrorKind(reason: string): DriveErrorKind {
  const sz = String(reason || '')
  if (!sz.trim()) return 'other'
  // A kikapcsolt API a LEGKONKRETABB: a 403 es az "is disabled" szoveg
  // masik mintat is megfoghatna, de a teendo itt egyertelmu (Console-kapcsolo).
  if (DRIVE_API_KIKAPCSOLVA_RE.test(sz)) return 'api_disabled'
  if (DRIVE_KVOTA_RE.test(sz)) return 'quota'
  if (DRIVE_ABUZIV_RE.test(sz)) return 'abusive'
  if (DRIVE_AUTH_RE.test(sz)) return 'auth'
  return 'other'
}

/**
 * Elutasitas-e egyaltalan (van-e benne HTTP hibakod vagy ismert hibaszoveg)?
 *
 * Ebbol tudja a kepernyo, hogy egy `other` besorolas "a Google elutasitotta,
 * de nem tudjuk miert" (errol szolni kell), vagy csak egy halozati/helyi gond.
 */
export const DRIVE_ELUTASITAS_RE = /\b(40[0-9]|41[0-9]|42[0-9]|50[0-9])\b/

/**
 * A Google emberi mondata a nyers valasz-torzsbol.
 *
 * A naplo sora `Drive 403: {"error":{"message":"..."}}` alaku (csonkolva, ezert
 * a JSON gyakran nem is ertelmezheto). Ezert eloszor tisztessegesen probalunk
 * JSON-t olvasni, es csak utana esunk vissza szovegmintara. Ha egyik sem megy,
 * ures sztring -- a kepernyo ilyenkor NEM talal ki magyarazatot.
 */
export function driveHibaUzenet(reason: string): string {
  const sz = String(reason || '')
  const kezdet = sz.indexOf('{')
  if (kezdet >= 0) {
    try {
      const o = JSON.parse(sz.slice(kezdet))
      const m = o?.error?.message || o?.error?.errors?.[0]?.message
      if (m) return String(m)
    } catch { /* csonkolt torzs: jon a szovegminta */ }
  }
  const m = /"message"\s*:\s*"([^"]{3,200})/.exec(sz)
  if (m) return m[1]
  return ''
}

/**
 * VEGLEGES elutasitas-e -- vagyis van-e ertelme holnap ujra megprobalni?
 *
 * Boss, 2026-09-23: "Minden Google-elutasitas egyformán, kevesebb sárga."
 * Ezert a kartekony fajl mellett az ISMERETLEN INDOKU elutasitas is a
 * kihagyando-listara kerul -- de CSAK a 4xx. Az az, amikor a Google a
 * KERESRE mond nemet: holnap is ugyanaz lenne a valasz.
 *
 * Az 5xx SZANDEKOSAN kimarad: az a Google sajat atmeneti uzemzavara, nem
 * elutasitas. Egy 503-at veglegesen kihagyni annyi, mint egy tokeletesen
 * jo fajlt csendben orokre kihagyni a szinkronbol -- pont az a nema kar,
 * amit a NULLA-elv tilt. Az ilyen fajl a kovetkezo futasban ujra sorra kerul.
 *
 * A `quota` es az `auth` sem kerul ide: azok nem EGY fajlrol szolnak, hanem
 * az egesz fiokrol, es van ertelmes teendojuk (helyfelszabaditas, ujralogin),
 * ezert sajat, valodi sort kapnak az onellenorzesben.
 */
export const DRIVE_VEGLEGES_ELUTASITAS_RE = /\b(40[0-9]|41[0-9]|42[0-9])\b/

export function driveVeglegesenElutasitva(reason: string): boolean {
  const kind = driveErrorKind(reason)
  if (kind === 'abusive') return true
  if (kind === 'quota' || kind === 'auth' || kind === 'api_disabled') return false
  return DRIVE_VEGLEGES_ELUTASITAS_RE.test(String(reason || ''))
}
