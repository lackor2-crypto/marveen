/**
 * MELYIK FIOKKAL MENJEN A MUNKAPAD-HIVAS (kanban #402, 2. resz).
 *
 * A tulajdonos (2026-09-26): "Mindig azt hasznalja, ahol van." Ezert a
 * Munkapad nem a fo agens fiokjahoz kotott: a bejelentkezett Claude-fiokok
 * kozul a legtobb 5 oras kerettel rendelkezovel indul, es ha az a
 * szolgaltato szavaval ("limit") elutasitja, a kovetkezovel probalja.
 *
 * A sorrend ugyanaz, mint a `life-inbox-ai.ts` fiokvalasztasae
 * (`orderClaudeAccounts`), EGY elteressel: CSAK AZ 5 ORAS KERET SZAMIT, a heti
 * szam itt nem szur ki fiokot (telepitesi szabaly). Ha egy fiok heti kerete
 * tenyleg elfogyott, a hivasa "limit"-tel ter vissza, es a kovetkezo jon.
 *
 * Semmi beegetve: a fiokok az install agenseibol jonnek (MAIN_AGENT_ID +
 * listAgentNames), a fiok-azonosito az agens neve -- sosem token, sosem email.
 */
import { listClaudeAccountCandidates, orderClaudeAccounts, type ClaudeAccount } from '../life-inbox-ai.js'
import { tierForPct } from '../rate-limit-status.js'

type Lister = () => ClaudeAccount[]
let lister: Lister = listClaudeAccountCandidates

/** Csak teszthez: a fiok-lista forrasanak cserelese. `null` visszaallitja. */
export function setWorkbenchAccountListerForTest(l: Lister | null): void {
  lister = l || listClaudeAccountCandidates
}

/**
 * A kiprobalando fiokok (agens-id), a legjobb elol. URES lista = nincs
 * hasznalhato elofizeteses fiok (nincs bejelentkezes, vagy mind kritikus
 * 5 oras keretnel) -- a hivo ilyenkor a szolgaltato alapertelmezettjere
 * esik vissza, ami a tenyleges okot (nincs fiok / keret) ki is mondja.
 */
export function workbenchAccounts(now: number = Date.now()): string[] {
  let cands: ClaudeAccount[] = []
  try { cands = lister() } catch { cands = [] }
  return orderClaudeAccounts(cands.map((c) => ({ ...c, sevenDayPct: null })), now).map((c) => c.agent)
}

/** Egy fiok ELO allapota a valasztohoz (kanban #426). */
export type WorkbenchAccountState = 'online' | 'limited' | 'unknown'

export interface WorkbenchAccountStatus {
  agent: string
  model: string
  /** online = tud most valaszolni; limited = a heti/5 oras kerete elfogyott;
   *  unknown = nincs friss meres (nem 0, hanem "nem latunk oda"). */
  status: WorkbenchAccountState
  fiveHourPct: number | null
  sevenDayPct: number | null
}

/**
 * MINDEN bejelentkezett fiok, az ELO allapotaval -- a Munkapad fiokvalasztojahoz.
 *
 * A `workbenchAccounts()` (az auto-valasztas) kizarja a kritikus 5 oras keretut
 * es a heti-limiteset; ITT viszont EGY fiok sem esik ki, mert a felhasznalonak
 * latnia kell a pirosat is (Boss, 2026-09-27: "meg fiok online de hogy lehessen
 * valasztani... zold vagy piros"). Az elo (zold) fiokok elol, hogy az elso
 * kesz-valasztas is jo legyen.
 */
export function workbenchAccountStatuses(): WorkbenchAccountStatus[] {
  let cands: ClaudeAccount[] = []
  try { cands = lister() } catch { cands = [] }
  const rows: WorkbenchAccountStatus[] = cands.map((c) => {
    const weeklyDead = c.sevenDayPct != null && c.sevenDayPct >= 100
    const fiveCritical = c.fiveHourPct != null && tierForPct(c.fiveHourPct) === 'critical'
    const noMeasure = c.fiveHourPct == null && (c.sevenDayPct == null)
    const status: WorkbenchAccountState =
      weeklyDead || fiveCritical ? 'limited' : noMeasure ? 'unknown' : 'online'
    return { agent: c.agent, model: c.model, status, fiveHourPct: c.fiveHourPct, sevenDayPct: c.sevenDayPct ?? null }
  })
  const rank = (s: WorkbenchAccountState): number => (s === 'online' ? 0 : s === 'unknown' ? 1 : 2)
  rows.sort((a, b) =>
    rank(a.status) - rank(b.status)
    || (a.fiveHourPct ?? Number.POSITIVE_INFINITY) - (b.fiveHourPct ?? Number.POSITIVE_INFINITY)
    || a.agent.localeCompare(b.agent))
  return rows
}

/** A fiok-lista adott azonositoju fiokja letezik-e (a valasztott fiok
 *  ellenorzesehez, hogy egy ismeretlen nev ne kerulhessen a hivasba). */
export function isKnownWorkbenchAccount(agent: string): boolean {
  return workbenchAccountStatuses().some((a) => a.agent === agent)
}
