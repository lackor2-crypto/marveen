/**
 * TOVÁBBI LEHETŐSÉGEID -- amit a Marveen tud, de ez a telepítés még nem
 * használ.
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
 * A HATÁRVONAL, amit ez a modul tart:
 *   - ELROMLOTT valami, ami működött  -> az Önellenőrzés kártyája (hangos).
 *   - SOSE VOLT bekötve, és nem is kell -> ez a lista (halk, csukott gomb).
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
  /** Bekötheted, még nincs bekötve. */
  | 'available'
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
}

export const GOOGLE_TOKENS_PATH = join(STORE_DIR, 'google-tokens.json')

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

export interface OpportunityDeps {
  /** A kulcsos szolgáltatások: id + "be van-e már kötve". A dobás (kivétel)
   *  itt nem hiba, hanem "nem látok oda" -- `unknown` sor lesz belőle. */
  keyServices: Array<{ id: string; configured: () => boolean }>
  claudePlans: () => MaybeCount
  googleAccounts: () => MaybeCount
  connectors: () => { total: MaybeCount; installed: MaybeCount }
}

/**
 * A teljes lista, sorrendben. Csak azt sorolja fel, ami MÉG NINCS kihasználva;
 * a bekötött dolgok egyszerűen kimaradnak (a "minden rendben" mondat az
 * Önellenőrzés dolga, nem ezé).
 */
export function buildOpportunities(deps: OpportunityDeps): Opportunity[] {
  const out: Opportunity[] = []

  for (const svc of deps.keyServices) {
    let configured: boolean
    try { configured = svc.configured() } catch {
      out.push({ id: svc.id, state: 'unknown' })
      continue
    }
    if (!configured) out.push({ id: svc.id, state: 'available' })
  }

  // Egy negyedik Claude-előfizetés felvétele, vagy egy meglévő kijelentkeztetése
  // nem hiba (Boss: "most van három, és mi van akkor, ha egy negyediket fogok
  // fölvenni"). Ezért ez a sor AKKOR IS ott van, ha már van három: a szám
  // mondja meg, hol tart, nem egy figyelmeztetés.
  const plans = deps.claudePlans()
  out.push(plans === null
    ? { id: 'claude-plan', state: 'unknown' }
    : { id: 'claude-plan', state: 'available', params: { n: plans } })

  // Ugyanez a Google-fiókokra: "van egy e-mailem, [...] másik Google Drive az
  // nincs felvezetve vagy bekötve -- ezek nem hibák hanem lehetőségek."
  const google = deps.googleAccounts()
  out.push(google === null
    ? { id: 'google-account', state: 'unknown' }
    : { id: 'google-account', state: 'available', params: { n: google } })

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
  } else if (conn.installed < conn.total) {
    out.push({
      id: 'connector',
      state: 'available',
      params: { n: conn.total - conn.installed, total: conn.total, installed: conn.installed },
    })
  }

  return out
}
