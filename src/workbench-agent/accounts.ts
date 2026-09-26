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
