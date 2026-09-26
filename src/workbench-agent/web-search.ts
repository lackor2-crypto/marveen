/**
 * MUNKAPAD WEBKERESES (kanban #404).
 *
 * Miert a SAJAT tool-loopunkban, es nem a Claude CLI beepitett keresojevel:
 * igy a kereses is atmegy az autonomia-kapun, bekerul az audit-naplóba (ki
 * kerte), a talalatok `wrapUntrustedFetch`-csel, megbizhatatlan adatkent
 * jutnak a modell ele -- es a Munkapad nincs egy Anthropic-fiokhoz kotve.
 *
 * Harom szabaly:
 *
 * 1. SZOLGALTATO-FUGGETLEN. A `WebSearchProvider` a szerzodes; az elso
 *    megvalositas a Brave Search API. Uj kereso = uj provider, a tool nem
 *    valtozik.
 * 2. A CEL-CIM FIX. A modell CSAK a keresokifejezest adja; a gazdagep a kodban
 *    all (`BRAVE_ENDPOINT`), tehat egy befecskendezett utasitas sem tudja a
 *    kerest mashova iranyitani. Ez a szerver sajat hivasa, nem az ugynokok
 *    WebFetch-e: az egress-gate hook arra vonatkozik, ide nem kell felvenni.
 * 3. A NULLA KET DOLGOT JELENTHET. "Nincs beallitva", "nem tudtam megkerdezni"
 *    (idotullepes, halozat, rossz kulcs) es "megkerdeztem, nincs talalat"
 *    harom KULON kimenet. Kulcs nelkul SOSE ures lista jon vissza.
 */
import { getEffectiveSettingValue } from '../settings-store.js'
import { generateFetchNonce, wrapUntrustedFetch } from '../prompt-safety.js'
import type { ToolResult } from './execute.js'

export const WEB_SEARCH_KEY_SETTING = 'BRAVE_SEARCH_API_KEY'
export const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
/** Ahol a tulajdonos kulcsot szerez. */
export const BRAVE_KEY_URL = 'https://brave.com/search/api/'
export const WEB_SEARCH_MAX_RESULTS = 10
export const WEB_SEARCH_TIMEOUT_MS = 10_000
/** A Brave legfeljebb 400 karakteres kifejezest fogad el. */
export const WEB_SEARCH_MAX_QUERY = 400
const SNIPPET_MAX = 500
/** A talalat-blokk felso hatara (az orchestrator 6000-nel vag, a JSON-escape is nyel). */
export const RESULTS_TEXT_MAX = 4500

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

export type WebSearchErrorCode =
  | 'web_search_not_configured'
  | 'web_search_timeout'
  | 'web_search_unauthorized'
  | 'web_search_rate_limited'
  | 'web_search_http_error'
  | 'web_search_network_error'
  | 'web_search_bad_response'

export type WebSearchOutcome =
  | { ok: true; provider: string; hits: WebSearchHit[] }
  | { ok: false; code: WebSearchErrorCode; detail: string }

export interface WebSearchProvider {
  id: string
  /** Az a cim, ahova a keres megy -- a talalatok forrasa. */
  endpoint: string
  configured(): boolean
  search(query: string, opts: { count: number; timeoutMs: number }): Promise<WebSearchOutcome>
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  statusText?: string
  json(): Promise<unknown>
}>

let fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>

/** Csak teszthez: a halozat helyett egy hamis `fetch`. `null` visszaallitja. */
export function setWebSearchFetchForTest(f: FetchLike | null): void {
  fetchImpl = f || ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>)
}

function braveKey(): string {
  try { return String(getEffectiveSettingValue(WEB_SEARCH_KEY_SETTING) ?? '').trim() } catch { return '' }
}

/** A Brave a kivonatba `<strong>` jeloloket tesz; a modellnek sima szoveg kell. */
function plain(s: unknown, max: number): string {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export const braveProvider: WebSearchProvider = {
  id: 'brave',
  endpoint: BRAVE_ENDPOINT,
  configured: () => braveKey().length > 0,
  async search(query, { count, timeoutMs }) {
    const key = braveKey()
    if (!key) return { ok: false, code: 'web_search_not_configured', detail: 'no Brave Search API key is set' }
    const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
        signal: ctl.signal,
      })
    } catch (e) {
      if (ctl.signal.aborted) return { ok: false, code: 'web_search_timeout', detail: `no answer from the search service within ${Math.round(timeoutMs / 1000)} seconds` }
      return { ok: false, code: 'web_search_network_error', detail: e instanceof Error ? e.message : String(e) }
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const detail = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
      if (res.status === 401 || res.status === 403) return { ok: false, code: 'web_search_unauthorized', detail }
      if (res.status === 429) return { ok: false, code: 'web_search_rate_limited', detail }
      return { ok: false, code: 'web_search_http_error', detail }
    }
    let body: unknown
    try { body = await res.json() } catch (e) {
      return { ok: false, code: 'web_search_bad_response', detail: e instanceof Error ? e.message : String(e) }
    }
    const web = (body as { web?: { results?: unknown } } | null)?.web
    // A `web` blokk HIANYA a Brave-nel azt jelenti, hogy nincs webes talalat --
    // de ha van, es nem lista, az mar olvashatatlan valasz, nem "nulla".
    if (web !== undefined && !Array.isArray(web?.results)) {
      return { ok: false, code: 'web_search_bad_response', detail: 'the answer has no result list' }
    }
    const raw = Array.isArray(web?.results) ? web!.results as Array<Record<string, unknown>> : []
    const hits = raw
      .map((r) => ({ title: plain(r.title, 200), url: String(r.url ?? '').trim(), snippet: plain(r.description, SNIPPET_MAX) }))
      .filter((h) => /^https?:\/\//i.test(h.url))
      .slice(0, count)
    return { ok: true, provider: 'brave', hits }
  },
}

let provider: WebSearchProvider = braveProvider

/** Csak teszthez. */
export function setWebSearchProviderForTest(p: WebSearchProvider | null): void {
  provider = p || braveProvider
}

export function activeWebSearchProvider(): WebSearchProvider {
  return provider
}

type ProbeResult = { state: 'ok' | 'not_configured' | 'check_failed'; detail: string | null; version: string | null; path: string | null }
let lastProbe: { keyTail: string; result: ProbeResult } | null = null

/** A kulcs utolso 4 karaktere: csak azt nezzuk, UGYANARRA a kulcsra szol-e a
 *  meres. A kulcsot magat nem taroljuk el meg egyszer. */
function keyTail(): string { return braveKey().slice(-4) }

/** A legutobbi VALODI proba-kereses eredmenye, ha a kulcs azota nem valtozott. */
export function lastWebSearchProbe(): ProbeResult | null {
  if (!lastProbe || lastProbe.keyTail !== keyTail()) return null
  return lastProbe.result
}

/** Egy egytalalatos proba-kereses: kiderul, hogy a kulcs JO-e. A "nem tudtam
 *  megkerdezni" (idotullepes, halozat) `check_failed`, nem "nincs beallitva". */
export async function probeWebSearch(): Promise<ProbeResult> {
  const p = activeWebSearchProvider()
  if (!p.configured()) return { state: 'not_configured', detail: null, version: null, path: null }
  const out = await p.search('Marveen', { count: 1, timeoutMs: WEB_SEARCH_TIMEOUT_MS })
  const result: ProbeResult = out.ok
    ? { state: 'ok', detail: null, version: null, path: p.id }
    : out.code === 'web_search_unauthorized'
      ? { state: 'not_configured', detail: `the key was rejected: ${out.detail}`, version: null, path: p.id }
      : { state: 'check_failed', detail: `${out.code}: ${out.detail}`, version: null, path: p.id }
  lastProbe = { keyTail: keyTail(), result }
  return result
}

/** Csak teszthez. */
export function resetWebSearchProbeForTest(): void { lastProbe = null }

/** Hany talalatot kerjunk: 1..10, alapbol 5. */
export function clampCount(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return 5
  return Math.min(n, WEB_SEARCH_MAX_RESULTS)
}

/** Emberi mondat a "nincs beallitva" allapothoz -- a felhasznalo ezt latja. */
export function notConfiguredMessage(lang: 'hu' | 'en'): string {
  return lang === 'en'
    ? `Web search is not set up. You can set it on the Workbench page: "What works on this machine?" > Web search. You get a key here: ${BRAVE_KEY_URL}`
    : `A webkeresés nincs beállítva. A Munkapad oldalon állíthatod be: „Mi működik ezen a gépen?” > Webkeresés. Kulcsot itt szerzel: ${BRAVE_KEY_URL}`
}

/** Emberi mondat a hibakodhoz. A nyers ok (`detail`) MELLE megy, nem helyette. */
function failureMessage(code: WebSearchErrorCode, detail: string, lang: 'hu' | 'en'): string {
  if (code === 'web_search_not_configured') return notConfiguredMessage(lang)
  const hu: Record<string, string> = {
    web_search_timeout: 'A keresőszolgáltatás nem válaszolt időben. Ez nem azt jelenti, hogy nincs találat: próbáld újra kicsit később.',
    web_search_unauthorized: 'A keresőszolgáltatás nem fogadta el a kulcsot. Nézd meg a Munkapad oldalon („Mi működik ezen a gépen?” > Webkeresés), jó kulcs van-e beírva.',
    web_search_rate_limited: 'Elfogyott a keresőszolgáltatás kerete (túl sok keresés rövid idő alatt, vagy a havi keret). Később újra működik.',
    web_search_http_error: 'A keresőszolgáltatás hibát adott vissza.',
    web_search_network_error: 'A keresőszolgáltatást nem sikerült elérni (hálózati hiba).',
    web_search_bad_response: 'A keresőszolgáltatás válaszát nem sikerült értelmezni.',
  }
  const en: Record<string, string> = {
    web_search_timeout: 'The search service did not answer in time. This does not mean there are no results: try again a little later.',
    web_search_unauthorized: 'The search service did not accept the key. Check the key on the Workbench page ("What works on this machine?" > Web search).',
    web_search_rate_limited: 'The search service quota is used up (too many searches in a short time, or the monthly quota). It works again later.',
    web_search_http_error: 'The search service returned an error.',
    web_search_network_error: 'The search service could not be reached (network error).',
    web_search_bad_response: 'The answer of the search service could not be read.',
  }
  const base = (lang === 'en' ? en : hu)[code] || code
  return detail ? `${base} (${detail})` : base
}

/**
 * A `web.search` tool. A talalatok EGY `<untrusted>` blokkban mennek a modell
 * ele (`wrapUntrustedFetch`, a keres cimevel es egy nonce-szal), hogy egy
 * talalat szovegebe rejtett utasitas se latsszon a mi utasitasunknak.
 */
export async function webSearch(input: Record<string, unknown>, lang: 'hu' | 'en'): Promise<ToolResult> {
  const query = String(input.query ?? '').replace(/\s+/g, ' ').trim()
  if (!query) return { ok: false, code: 'query_missing', detail: 'no search phrase was given (query)' }
  if (query.length > WEB_SEARCH_MAX_QUERY) {
    return { ok: false, code: 'query_too_long', detail: `the search phrase is ${query.length} characters; at most ${WEB_SEARCH_MAX_QUERY} are allowed` }
  }
  const p = activeWebSearchProvider()
  if (!p.configured()) return { ok: false, code: 'web_search_not_configured', detail: notConfiguredMessage(lang) }
  const out = await p.search(query, { count: clampCount(input.count), timeoutMs: WEB_SEARCH_TIMEOUT_MS })
  if (!out.ok) return { ok: false, code: out.code, detail: failureMessage(out.code, out.detail, lang) }
  if (out.hits.length === 0) {
    // Megkerdeztuk, es tenyleg nincs talalat -- ez NEM hiba, de kimondjuk.
    return { ok: true, data: { provider: out.provider, query, count: 0, note: 'the search ran and found no result for this phrase; try other words' } }
  }
  // Az orchestrator a tool-eredmenyt 6000 karakternel levagja; ha a blokk ennel
  // hosszabb volna, a zaro `</untrusted>` tag esne le. Ezert a talalatokat
  // eleve a keret ala fogjuk: ami nem fer bele, az kimarad (es a `count` ezt mutatja).
  const lines: string[] = []
  let used = 0
  for (const h of out.hits) {
    const line = `${lines.length + 1}. ${h.title || '(no title)'}\n   ${h.url}\n   ${h.snippet || '(no excerpt)'}`
    if (lines.length > 0 && used + line.length + 1 > RESULTS_TEXT_MAX) break
    lines.push(line.slice(0, RESULTS_TEXT_MAX))
    used += line.length + 1
  }
  const text = lines.join('\n')
  return {
    ok: true,
    data: {
      provider: out.provider,
      query,
      count: lines.length,
      results: wrapUntrustedFetch(p.endpoint, text, generateFetchNonce()),
    },
  }
}
