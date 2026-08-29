// "Be van jelentkezve?" -- a LEMEZRŐL, nem a panel szövegéből.
//
// Boss, 2026-08-29: a Szakértő kártyáján piros "Bejelentkezés" sáv állt,
// miközben a két kis jelző azt mondta, fut és online. Az újramérés a FORRÁST
// kérdezte meg, nem a képernyőt: az ügynök `.credentials.json`-ja 20:12-kor
// íródott, 2026-08-30 04:12-ig érvényes, és a heti kerete közben 6%-ról
// 8%-ra nőtt -- tehát DOLGOZOTT. A panel állapotsora egyszerűen ELAVULT
// szöveg volt: a Claude Code nem rajzolja újra sikeres bejelentkezés után.
//
// Ez pontosan a "ha egy tényt másodszor is kimondasz, előbb mérd újra"
// szabály: a panel arról szól, mi volt igaz akkor, amikor azt a sort
// kirajzolta -- nem arról, mi igaz most.
//
// FONTOS, mit NEM csinál ez a modul: SOHA nem olvas ki és nem ad tovább
// tokent, kulcsot vagy bármilyen titkot. Kizárólag azt nézi meg, LÉTEZIK-e a
// fájl, és mikor jár le. A hívó is csak ennyit kap.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type CredentialVerdict =
  /** Van hitelesítés, és a lejárata a jövőben van. */
  | 'valid'
  /** Van fájl, de lejárt. */
  | 'expired'
  /** Nincs hitelesítő fájl -- tényleg nincs bejelentkezve. */
  | 'missing'
  /** NEM LÁTUNK ODA: nincs beállított config-könyvtár, vagy a fájl
   *  olvashatatlan / értelmezhetetlen. Ez NEM azonos a "nincs"-csel, és a
   *  hívónak sosem szabad bizonyítékként használnia. */
  | 'unknown'

export interface CredentialFreshness {
  verdict: CredentialVerdict
  /** Unix ms, ha ismert. Titkot nem tartalmaz. */
  expiresAt?: number
  /** Miért ez a verdikt -- emberi mondat, naplóhoz és a súgóhoz. */
  detail: string
}

/**
 * Megnézi egy CLAUDE_CONFIG_DIR hitelesítő fájlját.
 * `configDir === null` esetén 'unknown' -- mert nem tudjuk, hol nézzük.
 */
export function readCredentialFreshness(
  configDir: string | null,
  now = Date.now(),
): CredentialFreshness {
  if (!configDir) {
    return { verdict: 'unknown', detail: 'Nincs beallitott CLAUDE_CONFIG_DIR -- nem tudom, hol nezzem meg.' }
  }
  const path = join(configDir, '.credentials.json')
  let raw: string
  try {
    if (!existsSync(path)) {
      return { verdict: 'missing', detail: 'Nincs .credentials.json ebben a config-konyvtarban.' }
    }
    statSync(path)
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    // Jogosultsag, csatolas-hiba, versenyhelyzet: "nem latok oda", nem "nincs".
    return { verdict: 'unknown', detail: `A .credentials.json nem olvashato: ${(err as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { verdict: 'unknown', detail: 'A .credentials.json nem ertelmezheto JSON -- nem tudom, ervenyes-e.' }
  }
  const oauth = (parsed as Record<string, any>)?.claudeAiOauth
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined
  if (expiresAt === undefined) {
    // Van fajl, de nem tudjuk megmondani a lejaratat (mas hitelesitesi mod,
    // jovobeli mezonev). Nem allitjuk, hogy ervenyes.
    return { verdict: 'unknown', detail: 'Van .credentials.json, de nincs benne ismert lejarat-mezo.' }
  }
  if (expiresAt <= now) {
    return { verdict: 'expired', expiresAt, detail: 'A hitelesites lejart.' }
  }
  return { verdict: 'valid', expiresAt, detail: 'Ervenyes hitelesites van a lemezen.' }
}
