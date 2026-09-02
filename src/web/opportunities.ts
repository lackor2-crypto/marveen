/**
 * TOVÁBBI LEHETŐSÉGEID -- amit a Marveen tud, és amit ez a telepítés még
 * bővíthet.
 *
 * Boss, 2026-09-02: "az nem hiba, hogyha valamit a Marvinból nem akarok
 * telepíteni [...] ezek nem hibák hanem lehetőségek, további lehetőségek
 * [...] de nem így ide villogó ki pirossal."
 *
 * A kiváltó ok mérve: a `#overviewCapabilities` kártya ("Ezeket még nem
 * használod ki") a `.overview-capabilities` alapértelmezett `#dc2626`
 * hátterét kapta, és -- a Beállítás és az Önellenőrzés kártyával ellentétben,
 * amelyek rajzoláskor felülírják -- SOHA nem írta felül. Így egyetlen be nem
 * kötött, teljesen opcionális szolgáltatás (a GLM/Z.ai) vészpirosban ült az
 * Áttekintés tetején, fekete dobozokkal. Riasztószínt kényelmi funkcióra
 * költeni ugyanaz a hiba, mint elhallgatni egy valódi üzemszünetet: aki
 * megtanulja, hogy a piros semmit nem jelent, a következő pirosat sem nézi meg.
 *
 * A SOR NEM TŰNIK EL, HA BEKÖTÖTTED. Boss, ugyanaznap, a tooltipet olvasva:
 * "de miért tűnik el? a lehetőség továbbra is fennáll. nem? akár felvihetne
 * később egy legújabb GLM előfizetést is. másodikat." Igaza volt, és a hiba
 * mélyebb volt, mint a felirat: a trezor szolgáltatásonként EGY nevet ismert,
 * tehát egy második GLM-kulcs felülírta volna az elsőt. Ezért a lista mostantól
 * FÉRŐHELYEKET mutat (lásd `key-service-slots.ts`): minden sor ott marad, és
 * megmondja, hány van, és hogy felvehetsz-e még egyet.
 *
 * A HATÁRVONAL, amit ez a modul tart:
 *   - ELROMLOTT valami, ami működött  -> az Önellenőrzés kártyája (hangos).
 *   - MÉG BŐVÍTHETŐ, és semmi baja    -> ez a lista (halk, csukott gomb).
 * Ezért nem kerül ide egyetlen lejárt hozzáférés, halott token vagy elesett
 * connector sem: azok tényleg hibák.
 *
 * A NULLA KÉT DOLGOT JELENTHET. Minden mérés vagy számot ad, vagy `null`-t --
 * és a `null` NEM nulla: azt jelenti, hogy a forrást magát nem tudtam
 * elolvasni. Friss telepítésen a "0 Google-fiók" a helyes, csendes válasz; egy
 * olvashatatlan token-tárnál viszont a felület kimondja, hogy nem látott oda.
 * A kettőt sose a találatok számából következtetjük ki, hanem magától a
 * forrástól kérdezzük meg.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { accountsFromTokenStore } from './google-accounts.js'
import { resolveClaudePlans, CLAUDE_PLANS_PATH } from './claude-plans.js'

/** `number` = megmérve. `null` = a forrás nem volt olvasható (NEM nulla). */
export type MaybeCount = number | null

export type OpportunityState =
  /** Még nincs bekötve -- ezt tudod hozzáadni. */
  | 'available'
  /** Már be van kötve. A sor MARAD: ide még felvehetsz egyet. */
  | 'connected'
  /** Nem tudtam megnézni -- a felület ezt KIMONDJA, nem hallgatja el. */
  | 'unknown'

export interface Opportunity {
  /** Állandó kulcs; a felirat és a leírás a web/lang/*.js-ből jön. */
  id: string
  state: OpportunityState
  /** Számok a fordított szövegbe ({n}, {total}...). Lemezről jött szabad
   *  szöveg SOHA nem kerül ide -- a kliens ezeket escape nélkül rajzolja. */
  params?: Record<string, string | number>
  /** Ha ki van töltve, a leírás kulcsa `<descKey>_<variant>` lesz. Arra kell,
   *  amikor a sor ugyanaz a lehetőség, de kevesebbet tudok róla: pl. a
   *  connectoroknál tudom, hány van, de azt nem, hányat kötöttél már be --
   *  ilyenkor a szöveg csak azt mondja ki, amit tényleg megmértem. */
  variant?: string
  /**
   * A választott kulcs-hely eltűnt, a flotta az alap-helyre esett vissza.
   * Ez néma hiba lenne (más előfizetés pénzét költené), ezért a sor kimondja.
   */
  activeMissing?: boolean
}

export const GOOGLE_TOKENS_PATH = join(STORE_DIR, 'google-tokens.json')
export const STORAGES_PATH = join(STORE_DIR, 'storages.json')

/**
 * Hány Claude-előfizetés (named plan) van felvéve.
 *
 * A hiányzó fájl friss telepítés: az 0, és az rendben van. A meglévő, de
 * olvashatatlan vagy romlott fájl viszont `null` -- arra a "0 előfizetésed
 * van" hamis állítás lenne.
 */
export function countClaudePlans(path: string = CLAUDE_PLANS_PATH, home: string = homedir()): MaybeCount {
  try { statSync(path) } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0
    return null
  }
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch { return null }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
  } catch { return null }
  try { return resolveClaudePlans(raw, home).length } catch { return null }
}

/**
 * Hány Google-fiók tokenjét tartja ez a telepítés.
 *
 * Ugyanaz a bontás: nincs fájl = friss telepítés = 0; van fájl, de nem
 * olvasható vagy nem JSON = `null`.
 */
export function countGoogleAccounts(path: string = GOOGLE_TOKENS_PATH): MaybeCount {
  if (!existsSync(path)) return 0
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch { return null }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return accountsFromTokenStore(parsed as Record<string, unknown>).length
}

/**
 * Hány GitHub-fiókhoz van kulcsunk.
 *
 * A számot a `git-accounts.ts` adja (az a forrás, ami a kölcsönzött gh-
 * bejelentkezéseket is ismeri), de a "0 vagy nem látok oda" kérdést MAGÁTÓL a
 * regiszter-fájltól kérdezzük meg: az a függvény hibás fájlnál üres listát ad,
 * ami pontosan úgy néz ki, mint egy friss telepítés.
 */
export function countGithubAccounts(
  accounts: () => string[],
  path: string = STORAGES_PATH,
): MaybeCount {
  if (!existsSync(path)) return 0
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch { return null }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  } catch { return null }
  try { return accounts().length } catch { return null }
}

export interface KeyServiceCount {
  /** A felület azonosítója (pl. `zai`), nem a trezor-név. */
  id: string
  /** Hány helyen van kulcs. `null` = nem láttam a trezorba. */
  count: MaybeCount
  /** A választott hely eltűnt -- lásd az `Opportunity.activeMissing`-et. */
  activeMissing?: boolean
}

export interface OpportunityDeps {
  /** A kulcsos szolgáltatások férőhely-számai. A dobás itt nem hiba, hanem
   *  "nem látok oda" -- `unknown` sor lesz belőle. */
  keyServices: () => KeyServiceCount[]
  claudePlans: () => MaybeCount
  googleAccounts: () => MaybeCount
  githubAccounts: () => MaybeCount
  connectors: () => { total: MaybeCount; installed: MaybeCount }
}

/** Egy szám -> egy sor. `null` esetén kimondott "nem látok oda" sor. */
function countedRow(id: string, n: MaybeCount, extra?: Partial<Opportunity>): Opportunity {
  if (n === null) return { id, state: 'unknown', ...extra }
  return { id, state: n > 0 ? 'connected' : 'available', params: { n }, ...extra }
}

/**
 * A teljes lista, sorrendben.
 *
 * MINDEN sor ott van, akkor is, ha már be van kötve: a lehetőség attól nem
 * szűnik meg, hogy egyszer éltél vele. A `state` mondja meg, hol tartasz, a
 * szám pedig azt, mennyi van -- figyelmeztetés sehol.
 */
export function buildOpportunities(deps: OpportunityDeps): Opportunity[] {
  const out: Opportunity[] = []

  // Kulcsos szolgáltatások: ide mostantól TÖBB kulcs is fér (férőhelyek), ezért
  // a bekötött sem tűnik el. Boss: "akár felvihetne később egy legújabb GLM
  // előfizetést is. másodikat."
  // A dobast SZANDEKOSAN nem nyeljuk el: ha elnyelnenk, a kulcs-sorok
  // nyomtalanul eltunnenek a listabol, es a felulet ugyanugy nezne ki, mint egy
  // friss telepitesen -- vagyis a csend ugyanazt jelentene, mint a rendben.
  // A hivo (`keyServiceCounts`) maga valaszolja meg a "nem latok oda" esetet
  // (`count: null`), es a vegpont hibaja a feluleten kimondott sor lesz
  // (`overview.opportunities.unreachable`).
  for (const svc of deps.keyServices()) {
    out.push(countedRow(svc.id, svc.count, svc.activeMissing ? { activeMissing: true } : undefined))
  }

  // Egy negyedik Claude-előfizetés felvétele, vagy egy meglévő kijelentkeztetése
  // nem hiba (Boss: "most van három, és mi van akkor, ha egy negyediket fogok
  // fölvenni"). A szám mondja meg, hol tart, nem egy figyelmeztetés.
  out.push(countedRow('claude-plan', deps.claudePlans()))

  // Ugyanez a Google-fiókokra: "van egy e-mailem, [...] másik Google Drive az
  // nincs felvezetve vagy bekötve -- ezek nem hibák hanem lehetőségek."
  out.push(countedRow('google-account', deps.googleAccounts()))

  // És a GitHub-fiókokra, amelyek eddig ki is maradtak ebből a listából,
  // pedig ugyanúgy több is lehet belőlük.
  out.push(countedRow('github', deps.githubAccounts()))

  // A connectoroknál a két szám külön mérésből jön, és külön is tud hiányozni.
  // Ha a katalógust sem látom, nincs mit mondani. Ha a katalógust látom, de a
  // bekötött listát nem (ez a normális állapot indulás után: azt a lekérdezést
  // szándékosan csak a Connectorok oldal frissítés gombja indítja el), akkor a
  // sor KIMONDJA, mennyi van összesen, és nem állítja azt, amit nem mért meg.
  const conn = deps.connectors()
  if (conn.total === null) {
    out.push({ id: 'connector', state: 'unknown' })
  } else if (conn.installed === null) {
    out.push({
      id: 'connector',
      state: 'available',
      variant: 'total_only',
      params: { total: conn.total },
    })
  } else {
    out.push({
      id: 'connector',
      state: conn.installed > 0 ? 'connected' : 'available',
      params: { n: conn.total - conn.installed, total: conn.total, installed: conn.installed },
      // Ha mind a 14 be van kötve, a "még {n} van hátra" mondat hazudna.
      variant: conn.installed >= conn.total ? 'all_installed' : undefined,
    })
  }

  return out
}
