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
import { tierForPct, STALE_AFTER_MS } from '../rate-limit-status.js'
import { rankModelTier } from '../web/smartest-worker.js'
import { liveUsageForAccount, readAccountAccessToken } from '../web/claude-usage-api.js'

type Lister = () => ClaudeAccount[]
let lister: Lister = listClaudeAccountCandidates

// ---------------------------------------------------------------------------
// OBSERVED LIMITS (kanban #434, Boss 2026-09-29: "zoldet mutat az usalackor
// mikozben 100% on van!")
//
// The percentages come from the agent's own statusline, which only refreshes
// while that agent works in its terminal. The same login also answers the
// Workbench (live session, VS Code bridge) -- and when THAT hits the limit,
// the snapshot never learns it: measured 2026-09-29, the bridge said "You've
// hit your session limit · resets 3:10am" at 02:11 while the snapshot still
// said 83% from 01:45. The CLI's own limit sentence is a measurement, so it
// is remembered until the reset it names, and the account shows as limited.
// ---------------------------------------------------------------------------

type LimitWindow = 'five' | 'seven'
interface LimitMark { window: LimitWindow; until: number; at: number }
const marks = new Map<string, LimitMark>()
/** A limit sentence for a KNOWN account whose reset time we cannot tie to its
 *  measured window: hold it this long, then trust the numbers again. */
const UNMATCHED_LIMIT_HOLD_MS = 30 * 60_000

/** Csak teszthez: a megfigyelt limitek torlese. */
export function resetObservedLimitsForTest(): void { marks.clear() }

function windowOf(text: string): LimitWindow | null {
  if (/weekly limit|7-day limit/i.test(text)) return 'seven'
  if (/session limit|5-hour limit|five-hour limit/i.test(text)) return 'five'
  return null
}

/**
 * Does the "resets 3:10am (Europe/Budapest)" / "resets Oct 2, 9am" part of a
 * limit sentence name exactly this instant? Compared in the zone the sentence
 * names (else the install's), to the minute -- the CLI prints no seconds.
 */
export function limitResetMatches(text: string, resetsAt: number): boolean {
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i.exec(text)
  if (!m || !Number.isFinite(resetsAt)) return false
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: m[6] || undefined, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(new Date(resetsAt))
  } catch { return false }
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  if (Number(get('hour')) !== Number(m[3])) return false
  if (Number(get('minute')) !== Number(m[4] ?? '0')) return false
  if (get('dayPeriod').toLowerCase() !== m[5].toLowerCase()) return false
  if (m[1] && (get('month').toLowerCase() !== m[1].toLowerCase() || Number(get('day')) !== Number(m[2]))) return false
  return true
}

/**
 * The CLI answered with its limit sentence: remember which account ran out.
 * `configDir` given = the caller knows the account (live session); otherwise
 * (VS Code bridge, whose login we cannot see) the account is the ONE whose
 * measured window resets exactly when the sentence says. No unique match =
 * nothing is marked -- a guess would paint a working account red.
 * Returns the marked agent, or null.
 */
export function noteLimitAnswer(text: string, opts: { configDir?: string; now?: number } = {}): string | null {
  const now = opts.now ?? Date.now()
  const win = windowOf(text)
  let cands: ClaudeAccount[] = []
  try { cands = lister() } catch { cands = [] }
  if (opts.configDir) cands = cands.filter((c) => c.configDir === opts.configDir)
  const hits: Array<{ agent: string; window: LimitWindow; until: number }> = []
  for (const c of cands) {
    for (const w of (win ? [win] : ['five', 'seven'] as LimitWindow[])) {
      const r = w === 'five' ? c.fiveHourResetsAt : c.sevenDayResetsAt
      if (r != null && r > now && limitResetMatches(text, r)) hits.push({ agent: c.agent, window: w, until: r })
    }
  }
  let hit = hits.length === 1 ? hits[0] : null
  if (!hit && opts.configDir && cands.length === 1) {
    hit = { agent: cands[0].agent, window: win ?? 'five', until: now + UNMATCHED_LIMIT_HOLD_MS }
  }
  if (!hit) return null
  marks.set(hit.agent, { window: hit.window, until: hit.until, at: now })
  return hit.agent
}

/** The accounts as measured, with the observed limits laid over them. A mark
 *  ends at its reset, or when a statusline reading taken AFTER it says the
 *  window is no longer full. */
function withObservedLimits(cands: ClaudeAccount[], now: number): ClaudeAccount[] {
  return cands.map((c) => {
    const mk = marks.get(c.agent)
    if (!mk) return c
    const measuredPct = mk.window === 'five' ? c.fiveHourPct : c.sevenDayPct
    if (mk.until <= now || (c.usageAt != null && c.usageAt > mk.at && measuredPct != null && measuredPct < 100)) {
      marks.delete(c.agent)
      return c
    }
    return mk.window === 'five'
      ? { ...c, fiveHourPct: 100, usageAt: now }
      : { ...c, sevenDayPct: 100, usageAt: now }
  })
}

// ---------------------------------------------------------------------------
// LIVE USAGE (kanban #434, Boss 2026-09-29, two screenshots: the quota monitor
// said usalackor 100% (red) while this picker said green). The monitor asks
// the ACCOUNT (claude-usage-api.ts, 20 s cache shared with it); the picker
// read only the agent's own statusline file (50%, written while that agent
// works). Same account, two sources. The live answer now wins whenever it is
// fresh; the statusline file stays the fallback when the live call fails.
// ---------------------------------------------------------------------------
interface LiveOverlay {
  fiveHourPct: number | null; sevenDayPct: number | null
  fiveHourResetsAt: number | null; sevenDayResetsAt: number | null
  measuredAt: number
}
const liveOverlay = new Map<string, LiveOverlay>()

/** Csak teszthez. */
export function resetLiveOverlayForTest(): void { liveOverlay.clear() }
export function setLiveOverlayForTest(agent: string, o: LiveOverlay): void { liveOverlay.set(agent, o) }

/** Ask every candidate account for its live usage (cached inside
 *  liveUsageForAccount, so calling this per request does not hammer the API).
 *  A failed call keeps the previous overlay until it goes stale. */
export async function refreshLiveAccountUsage(opts: { force?: boolean } = {}): Promise<void> {
  let cands: ClaudeAccount[] = []
  try { cands = lister() } catch { return }
  await Promise.all(cands.map(async (c) => {
    try {
      const r = await liveUsageForAccount(c.agent, readAccountAccessToken(c.configDir), { force: opts.force })
      if (!r.ok) return
      liveOverlay.set(c.agent, {
        fiveHourPct: r.usage.fiveHour?.usedPct ?? null, sevenDayPct: r.usage.sevenDay?.usedPct ?? null,
        fiveHourResetsAt: r.usage.fiveHour?.resetsAt ?? null, sevenDayResetsAt: r.usage.sevenDay?.resetsAt ?? null,
        measuredAt: r.usage.measuredAt,
      })
    } catch { /* the statusline reading stays as the fallback */ }
  }))
}

function withLiveUsage(cands: ClaudeAccount[], now: number): ClaudeAccount[] {
  return cands.map((c) => {
    const o = liveOverlay.get(c.agent)
    if (!o || now - o.measuredAt > STALE_AFTER_MS) return c
    return {
      ...c,
      fiveHourPct: o.fiveHourPct ?? c.fiveHourPct,
      sevenDayPct: o.sevenDayPct ?? c.sevenDayPct,
      fiveHourResetsAt: o.fiveHourResetsAt ?? c.fiveHourResetsAt,
      sevenDayResetsAt: o.sevenDayResetsAt ?? c.sevenDayResetsAt,
      usageAt: o.measuredAt,
    }
  })
}

function listAccounts(now: number): ClaudeAccount[] {
  let cands: ClaudeAccount[] = []
  try { cands = lister() } catch { cands = [] }
  return withObservedLimits(withLiveUsage(cands, now), now)
}

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
  const cands = listAccounts(now)
  const ordered = orderClaudeAccounts(cands.map((c) => ({ ...c, sevenDayPct: null })), now)
  // A heti 100% nem szur ki, de a sor VEGERE kerul (#434, 2026-09-28): a
  // Munkapad kivalasztott egy 0%-os 5 oras, de heti limites fiokot, es az
  // elo munkamenet "weekly limit"-tel megszakadt, mikozben ket zold fiok volt.
  // Csak friss merest hiszunk el; elavult meres nem sorol hatra.
  const weeklyDead = new Set(cands
    .filter((c) => c.sevenDayPct != null && c.sevenDayPct >= 100 && !(c.usageAt !== null && now - c.usageAt > STALE_AFTER_MS))
    .map((c) => c.agent))
  return [...ordered.filter((c) => !weeklyDead.has(c.agent)), ...ordered.filter((c) => weeklyDead.has(c.agent))].map((c) => c.agent)
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
export function workbenchAccountStatuses(now: number = Date.now()): WorkbenchAccountStatus[] {
  const cands = listAccounts(now)
  // CSAK Claude-fiokok. A Munkapad providere a `claude -p`-t inditja, tehat egy
  // nem-Claude fiok (ingyenes glm/laguna/nemotron OpenRouter-modell) itt nem
  // hasznalhato -- ugyanaz a szures, mint az auto-valasztasban (orderClaudeAccounts:
  // rankModelTier >= 200). Enelkul a valaszto olyan fiokot kinalna, amivel a
  // hivas elhasalna.
  const rows: WorkbenchAccountStatus[] = cands.filter((c) => rankModelTier(c.model) >= 200).map((c) => {
    const weeklyDead = c.sevenDayPct != null && c.sevenDayPct >= 100
    const fiveCritical = c.fiveHourPct != null && tierForPct(c.fiveHourPct) === 'critical'
    const noMeasure = c.fiveHourPct == null && (c.sevenDayPct == null)
    // An old reading is not a green light: the numbers only refresh while that
    // agent works in its own terminal, while the Workbench keeps spending the
    // same login (#434: 83% at 01:45, out of limit by 02:11, still green).
    const stale = c.usageAt != null && now - c.usageAt > STALE_AFTER_MS
    const status: WorkbenchAccountState =
      weeklyDead || fiveCritical ? 'limited' : noMeasure || stale ? 'unknown' : 'online'
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
