/**
 * ELO keret-lekerdezes: ugyanaz a forras, amit a VS Code Claude Code bovitmeny
 * hasznal.
 *
 * A hiba, ami ezt kikenyszeritette (Boss, 2026-08-30): "ha a vscode dolgozik,
 * es a marveen nem, ugyanazzal a claude fiokkal, akkor a marveen nal lehet
 * hogy 6% van, es sohasem frissul es kozben a vscode nal meg 98% van!"
 *
 * Es tenyleg: a Marveen eddig KIZAROLAG a Claude Code sajat statusline-jabol
 * kapta a szazalekokat (scripts/hooks/statusline.py irja a
 * store/rate-limit-status/<agens>.json-t). Az a fajl viszont csak akkor kap uj
 * szamot, amikor AZ AZ AGENS eppen dolgozik -- egy csendben allo agens mellett
 * a szazalek orakig meg sem mozdul, hiaba egeti ugyanazt a fiokot egy masik
 * kliens (a Boss VS Code-ja). A pillanatkep tehat nem a FIOK allapotat merte,
 * hanem azt, hogy mit latott utoljara egy adott agens.
 *
 * A VS Code bovitmeny (anthropic.claude-code, extension.js) ezt maskepp
 * csinalja: lekerdezi a fiokot magat.
 *
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <a fiok OAuth access tokene>
 *   anthropic-beta: oauth-2025-04-20
 *
 * A valasz a FIOKRA vonatkozik, nem egy munkamenetre -- tehat akkor is a
 * valodi, mostani szamot adja, ha a Marveen agense eppen tetlen. A tokent a
 * fiok sajat CLAUDE_CONFIG_DIR-jenek `.credentials.json`-jabol vesszuk (ezt
 * irja/frissiti maga a Claude Code); mi csak OLVASSUK, sosem irjuk, es sosem
 * naplozzuk.
 *
 * Ez a modul csak a lekerdezes. Hogy melyik fioknak melyik config-konyvtar
 * felel meg, azt a hivo donti el (routes/overview.ts).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20'

/** Ugyanaz az 5 masodperc, amivel a VS Code bovitmeny is felad. */
const REQUEST_TIMEOUT_MS = 5_000

export interface LiveUsageWindow {
  /** 0..100 */
  usedPct: number
  /** Epoch ms, vagy null ha a szolgaltatas nem mondta meg. */
  resetsAt: number | null
}

export interface LiveUsage {
  fiveHour: LiveUsageWindow | null
  sevenDay: LiveUsageWindow | null
  /** Mikor johetett meg a valasz. Ez a "0 perce merve" alapja -- es csak
   *  valodi, sikeres valasz utan all be. */
  measuredAt: number
}

/**
 * Miert nincs elo meres. SOSE talalgatunk okot: mindegyik ag a TENYLEGES
 * hibabol jon (nincs fajl / a szolgaltatas valasza / a halozati kivetel), es
 * amit nem ismerunk fel, az `unknown-answer` a nyers reszlettel egyutt.
 */
export type LiveUsageFailure =
  | 'no-credential'    // nincs (olvashato) token ehhez a fiokhoz
  | 'expired-login'    // a szolgaltatas 401/403-mal utasitotta vissza
  | 'network'          // el sem jutott a kereses odaig
  | 'unknown-answer'   // valaszolt, de nem ugy, ahogy vartuk

export type LiveUsageResult =
  | { ok: true; usage: LiveUsage }
  | { ok: false; reason: LiveUsageFailure; detail: string }

/**
 * A fiok OAuth access tokenje a config-konyvtarabol.
 *
 * Nincs talalgatas es nincs fallback masik fiokra: ha ebben a konyvtarban
 * nincs hasznalhato token, akkor ennek a fioknak NINCS -- egy masik fiok
 * tokenjevel lekerdezve ugyanis egy MASIK fiok szamait irnank ki a sor melle.
 */
export function readAccountAccessToken(configDir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf-8'))
    const tok = raw?.claudeAiOauth?.accessToken
    return typeof tok === 'string' && tok.length > 0 ? tok : null
  } catch {
    return null
  }
}

/** A flotta setup-tokenje (store/.claude-oauth-token): az izolalt config-dirben
 *  futo fo agensnek nincs sajat `.credentials.json`-ja, a hitelesitese ebbol a
 *  fajlbol jon. */
export function readFleetToken(path: string): string | null {
  try {
    const t = readFileSync(path, 'utf-8').trim()
    return t.length > 0 ? t : null
  } catch {
    return null
  }
}

function parseWindow(raw: unknown): LiveUsageWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.utilization !== 'number' || !Number.isFinite(o.utilization)) return null
  // `resets_at` ISO-8601 sztring (vagy null, ha a keret meg el sem kezdodott).
  const parsed = typeof o.resets_at === 'string' ? Date.parse(o.resets_at) : NaN
  return {
    usedPct: Math.max(0, Math.min(100, o.utilization)),
    resetsAt: Number.isFinite(parsed) ? parsed : null,
  }
}

/**
 * Egy fiok elo keret-allapota. Halozati hivas -- a hivonak kell gondoskodnia
 * rola, hogy ne minden masodpercben kerdezze (lasd a gyorsitotarat lent).
 */
export async function fetchLiveUsage(token: string, now: number = Date.now()): Promise<LiveUsageResult> {
  let res: Response
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    // A tenyleges kivetel szovege megy tovabb -- nem tippelunk okot.
    return { ok: false, reason: 'network', detail: err instanceof Error ? err.message : String(err) }
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'expired-login', detail: `HTTP ${res.status}` }
  }
  if (!res.ok) {
    return { ok: false, reason: 'unknown-answer', detail: `HTTP ${res.status}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    return { ok: false, reason: 'unknown-answer', detail: err instanceof Error ? err.message : String(err) }
  }

  const o = (body ?? {}) as Record<string, unknown>
  const fiveHour = parseWindow(o.five_hour)
  const sevenDay = parseWindow(o.seven_day)
  // Valaszolt 200-zal, de egyik ablakot sem ertettuk: ez NEM "nulla szazalek".
  // A nulla ket dolgot jelenthetne, es itt a masodikrol van szo.
  if (!fiveHour && !sevenDay) {
    return { ok: false, reason: 'unknown-answer', detail: 'a valasz egyik keret-ablakot sem tartalmazta' }
  }
  return { ok: true, usage: { fiveHour, sevenDay, measuredAt: now } }
}

/**
 * Gyorsitotar a lekerdezes ele.
 *
 * Az Attekintes tobb uton is betoltodhet (oldalfrissites, lapvaltas, a
 * percenkenti ujrarajzolas melletti 3 perces ujratoltes), es nem akarjuk
 * ugyanazt a fiokot masodpercenkent megkerdezni. A `force` (bongeszo-
 * frissites) atlep a rendes koron, de egy rovid also hataron nem: egy F5-sorozat
 * sem indithat tetszoleges szamu kerest.
 */
const CACHE_TTL_MS = 20_000
const FORCE_MIN_AGE_MS = 3_000

interface CacheEntry { at: number; result: LiveUsageResult }
const cache = new Map<string, CacheEntry>()

export function clearLiveUsageCacheForTest(): void { cache.clear() }

export async function liveUsageForAccount(
  accountId: string,
  token: string | null,
  opts: { force?: boolean; now?: number } = {},
): Promise<LiveUsageResult> {
  const now = opts.now ?? Date.now()
  if (!token) return { ok: false, reason: 'no-credential', detail: 'nincs olvashato OAuth token a fiok config-konyvtaraban' }

  const hit = cache.get(accountId)
  if (hit) {
    const age = now - hit.at
    if (age < (opts.force ? FORCE_MIN_AGE_MS : CACHE_TTL_MS)) return hit.result
  }
  const result = await fetchLiveUsage(token, now)
  cache.set(accountId, { at: now, result })
  return result
}
