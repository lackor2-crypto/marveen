// A levellista es a mappalista rovid eletu gyorsitotara -- kulon modulban,
// mert ez az a resz, aminek a HATARESETEIT tesztelni kell (lejart-de-meg-jo,
// tulsagosan regi, parhuzamos hatter-frissites), nem a HTTP-utvonalat.
//
// Boss, 2026-08-19: "az emailnal az elso oszlop es masodik oszlop sem
// toltodik be hamar. csak nagyon sokara. sokat kell varni ra." Merve
// ugyanaznap, valodi bongeszo-hullamkeppel: a mappalista 22 ms (cache-bol),
// a levellista 4607 ms. A kulonbseg nem a lekerdezes: MELEG IMAP-kapcsolaton
// egy friss oldal 0,12 mp, HIDEG kapcsolaton 2,3-4,6 mp -- a kapcsolatkezelo
// 5 perc utan elengedi a socketet, es a kovetkezo kattintas fizeti ki a TLS +
// bejelentkezes arat.
//
// Ezert a lejart bejegyzest nem dobjuk el azonnal: kiadjuk valtozatlanul es
// AZONNAL, a frisset pedig a hatterben szedjuk ossze (Boss: "ami nem fontos
// azt a hatterben kesobb is be lehet tolteni").
import { logger } from '../logger.js'

export type CacheEntry<T> = { data: T; expires: number; storedAt: number }

/** A meg ERVENYES bejegyzes. Lejartkor NEM torol -- a lejart bejegyzes epp
 *  az, amit a stale-ag ki fog adni; a takaritas a cacheSet dolga. */
export function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expires) return undefined
  return entry.data
}

/** A lejart, de a stale-ablakon beluli bejegyzes. Az ennel is regebbit itt
 *  dobjuk el: azt mar kiadni sem szabad. */
export function cacheGetStale<T>(cache: Map<string, CacheEntry<T>>, key: string, staleMaxMs: number): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.storedAt > staleMaxMs) { cache.delete(key); return undefined }
  return entry.data
}

/** Beir, es kitakaritja a stale-ablakon TULI sorokat. Amig a lejart
 *  bejegyzes is ertek, valakinek takaritania kell: kulcsonkent (fiok x mappa
 *  x oldal x kereses) maradna egy-egy sor a Map-ben orokre. */
export function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  data: T,
  ttlMs: number,
  staleMaxMs: number,
): void {
  const now = Date.now()
  for (const [k, e] of cache) {
    if (now - e.storedAt > staleMaxMs) cache.delete(k)
  }
  cache.set(key, { data, expires: now + ttlMs, storedAt: now })
}

// Egy kulcshoz egyszerre egy hatter-frissites fut. A dashboard egyetlen
// processzben szolgal ki mindent: ha ot megnyitott ful mind ugyanarra a
// listara inditana egy-egy IMAP-lekerest, epp azt a torlodast csinalnank meg,
// ami elol menekulunk.
const refreshInFlight = new Set<string>()

export function refreshInBackground(key: string, work: () => Promise<void>): void {
  if (refreshInFlight.has(key)) return
  refreshInFlight.add(key)
  void work()
    .catch((err) => logger.warn(`[email] hatter-frissites elhasalt (${key}): ${err}`))
    .finally(() => refreshInFlight.delete(key))
}

/** Csak tesztnek: fut-e eppen hatter-frissites erre a kulcsra. */
export function isRefreshInFlight(key: string): boolean {
  return refreshInFlight.has(key)
}

// UGYANAZT EGYSZER. Ha ket keres (vagy egy keres es az indulas utani
// elomelegites) pontosan ugyanazt az IMAP-lekerest inditana el, a masodik ne
// inditson ujat, hanem varja meg az elsot. Merve 2026-08-19: ujraindulas utan
// az elomelegitessel EGYIDOBEN erkezo betoltes 2,9 / 8,9 mp volt -- ugyanaz a
// betoltes az elomelegites LEFUTASA utan 0,84 / 0,88 mp. A kulonbseg tisztan
// a ketszer elvegzett munka.
const inFlight = new Map<string, Promise<unknown>>()

export function singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined
  if (running) return running
  // A kulcsot a `finally` MINDIG felszabaditja -- hiba eseten is, kulonben egy
  // elszallt lekeres tartosan megmergezne a kovetkezoket.
  const started = (async () => {
    try { return await work() } finally { inFlight.delete(key) }
  })()
  inFlight.set(key, started)
  return started
}

/** Csak tesztnek: fut-e eppen ilyen kulcsu osszevont lekeres. */
export function isInFlight(key: string): boolean {
  return inFlight.has(key)
}
