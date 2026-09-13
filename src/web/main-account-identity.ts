// KI VAN A FŐ ÁGENS (~/.claude) FIÓKJÁBAN? -- a gép sajat bejelentkezesenek
// azonossag-orzese.
//
// Boss, 2026-09-13: a fo agens (~/.claude) loginja magatol atcsuszott egy
// masik fiokra (usalackor), es SEMMI nem szolt: a nevesitett elofizetesekre
// (`claude-plans.json` -> expectedEmail) volt drift-ellenorzes, a FO agensre
// NEM. "tegyel ellenorzest a fo agensre is." Ez a modul azt a hianyt potolja.
//
// Ugyanaz az elv, mint a plan-fiokoknal (lasd claude-plans.ts pinExpectedEmail):
// az ELSO megfigyelt cim rogzul (friss telepitesen sincs mit kezzel beallitani),
// a kesobbiek ehhez merodnek, es a rogzitett cimet a rendszer SOSE irja felul
// magatol -- ha mas jon be, azt a felhasznalonak jelezzuk, es o dont.
//
// A tarolo (store/main-account.json) operator-tulajdonu, es a Fiokok oldalrol
// szerkesztheto (force-pin). I/O-mentes resze (verdict) egysegtesztelheto.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { normalizeEmail } from './account-identity-guard.js'

export const MAIN_ACCOUNT_PATH = join(PROJECT_ROOT, 'store', 'main-account.json')

/** A fo agens fiokjahoz rogzitett cim, vagy null ha meg nincs. */
export function readMainExpectedEmail(path: string = MAIN_ACCOUNT_PATH): string | null {
  if (!existsSync(path)) return null
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch { return null }
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const cim = (o as Record<string, unknown>).expectedEmail
  return normalizeEmail(typeof cim === 'string' ? cim : null)
}

export type MainPinResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string }

/**
 * A fo agens fiokjahoz rogziti a cimet.
 *
 * - `force: false` (alap): csak akkor ir, ha MEG NINCS rogzitett cim (elso
 *   megfigyeles). Ha mar van, es mas jon, azt NEM itt dontjuk el -- a drift-sor
 *   jelzi a felhasznalonak.
 * - `force: true`: a felhasznalo kifejezett dontese (Fiokok oldal) atirja.
 */
export function pinMainExpectedEmail(
  email: string | null | undefined,
  opts: { force?: boolean; path?: string } = {},
): MainPinResult {
  const path = opts.path || MAIN_ACCOUNT_PATH
  const cim = normalizeEmail(email)
  if (!cim) return { ok: false, error: 'hianyzo cim' }
  const eddigi = readMainExpectedEmail(path)
  if (eddigi && !opts.force) {
    // Mar van rogzitett cim -- ha ugyanaz, nincs teendo; ha mas, azt a
    // drift-ellenorzes jelzi, nem itt irjuk felul.
    return { ok: true, changed: false }
  }
  if (eddigi === cim) return { ok: true, changed: false }
  try {
    atomicWriteFileSync(path, JSON.stringify({ expectedEmail: cim }, null, 2) + '\n')
  } catch (e) {
    return { ok: false, error: `a fiok-nyilvantartas nem irhato: ${(e as Error).message}` }
  }
  return { ok: true, changed: true }
}

export type MainAccountVerdict =
  /** Nem tudtam megkerdezni -- semmit nem allitok. */
  | { kind: 'blind' }
  /** Ki van jelentkezve: nincs mit osszehasonlitani. */
  | { kind: 'signed_out' }
  /** Be van jelentkezve, de meg nincs rogzitett cim (elso megfigyeles). */
  | { kind: 'unpinned'; actual: string }
  /** Be van jelentkezve, es NEM a rogzitett cim van benne. */
  | { kind: 'drift'; expected: string; actual: string }
  /** Be van jelentkezve, es pontosan a rogzitett cim. */
  | { kind: 'ok'; actual: string }

/**
 * Tiszta itelet a fo agens fiokjarol. `probeOk=false` = nem lattam oda (vak).
 * A rogzitett cimet parameterkent kapja, hogy I/O nelkul tesztelheto legyen.
 */
export function mainAccountVerdict(
  probeOk: boolean,
  loggedIn: boolean,
  actualEmail: string | null | undefined,
  expectedEmail: string | null | undefined,
): MainAccountVerdict {
  if (!probeOk) return { kind: 'blind' }
  const actual = normalizeEmail(actualEmail)
  if (!loggedIn || !actual) return { kind: 'signed_out' }
  const expected = normalizeEmail(expectedEmail)
  if (!expected) return { kind: 'unpinned', actual }
  if (expected !== actual) return { kind: 'drift', expected, actual }
  return { kind: 'ok', actual }
}
