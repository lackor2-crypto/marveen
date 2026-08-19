// A ket email-oszlop VARAKOZASA.
//
// Boss, 2026-08-19: "az emailnal az elso oszlop es masodik oszlop sem
// toltodik be hamar. csak nagyon sokara. sokat kell varni ra."
//
// MERVE ugyanaznap, valodi bongeszo-hullamkeppel (Playwright, eles dashboard):
//   1. oszlop (mappak):  2048 ms
//   2. oszlop (levelek): 7452 ms
//   /api/email/mailboxes:   22 ms   <- cache-bol
//   /api/email/envelopes: 4607 ms   <- ez a varakozas
// ...es a kulcs merés: ugyanaz a lekeres MELEG IMAP-kapcsolaton 0,12 mp,
// HIDEG kapcsolaton 2,3-4,6 mp. Vagyis nem a lekerdezes lassu, hanem az
// 5 perces tetlensegi bontas utani ujrakapcsolodas.
//
// Amit ez a fajl ved: a lejart bejegyzes NE vesszen el, mert epp az a
// valasz, amit azonnal ki lehet adni; a tul regi viszont igen; es egy
// kulcsra egyszerre csak EGY hatter-frissites fusson (kulonben minden
// megnyitott ful sajat IMAP-kerest inditana ugyanarra a listara).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { cacheGet, cacheGetStale, cacheSet, refreshInBackground, isRefreshInFlight } from '../web/email-list-cache.js'
import type { CacheEntry } from '../web/email-list-cache.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTE = readFileSync(join(__dirname, '..', 'web', 'routes', 'email.ts'), 'utf8')

const TTL = 20_000
const STALE = 30 * 60_000

afterEach(() => { vi.useRealTimers() })

function freshCache(): Map<string, CacheEntry<unknown[]>> {
  return new Map<string, CacheEntry<unknown[]>>()
}

describe('a lejart lista nem vesz el', () => {
  it('a TTL-en belul friss valaszt ad', () => {
    const c = freshCache()
    cacheSet(c, 'k', [1], TTL, STALE)
    expect(cacheGet(c, 'k')).toEqual([1])
  })

  it('a TTL utan nem ad friss valaszt, de NEM is dobja el', () => {
    vi.useFakeTimers()
    const c = freshCache()
    cacheSet(c, 'k', [1], TTL, STALE)
    vi.advanceTimersByTime(TTL + 1)
    expect(cacheGet(c, 'k')).toBeUndefined()
    // Ez a lenyeg: a torles utan mar nem lenne mit azonnal kiadni, es a
    // felhasznalo megint kifizetne a hideg kapcsolat 2-4 masodpercet.
    expect(cacheGetStale(c, 'k', STALE)).toEqual([1])
  })

  it('a stale-ablakon TUL mar nem adja ki, es el is dobja', () => {
    vi.useFakeTimers()
    const c = freshCache()
    cacheSet(c, 'k', [1], TTL, STALE)
    vi.advanceTimersByTime(STALE + 1)
    expect(cacheGetStale(c, 'k', STALE)).toBeUndefined()
    expect(c.has('k')).toBe(false)
  })

  it('iras kozben kitakaritja a tul regi sorokat', () => {
    vi.useFakeTimers()
    const c = freshCache()
    cacheSet(c, 'regi', [1], TTL, STALE)
    vi.advanceTimersByTime(STALE + 1)
    cacheSet(c, 'uj', [2], TTL, STALE)
    expect(c.has('regi')).toBe(false)
    expect(cacheGet(c, 'uj')).toEqual([2])
  })

  it('a stale-ablakon BELULI masik sort nem takaritja ki', () => {
    vi.useFakeTimers()
    const c = freshCache()
    cacheSet(c, 'a', [1], TTL, STALE)
    vi.advanceTimersByTime(TTL + 1)
    cacheSet(c, 'b', [2], TTL, STALE)
    expect(cacheGetStale(c, 'a', STALE)).toEqual([1])
  })
})

describe('egy kulcsra egyszerre egy hatter-frissites', () => {
  it('a masodik hivast eldobja, amig az elso fut', async () => {
    let futasok = 0
    let engedd: () => void = () => {}
    const blokkolo = new Promise<void>(r => { engedd = r })
    refreshInBackground('kulcs-1', async () => { futasok++; await blokkolo })
    refreshInBackground('kulcs-1', async () => { futasok++ })
    expect(futasok).toBe(1)
    expect(isRefreshInFlight('kulcs-1')).toBe(true)
    engedd()
    await vi.waitFor(() => expect(isRefreshInFlight('kulcs-1')).toBe(false))
    refreshInBackground('kulcs-1', async () => { futasok++ })
    expect(futasok).toBe(2)
  })

  it('elhasalt frissites utan sem ragad be a kulcs', async () => {
    refreshInBackground('kulcs-2', async () => { throw new Error('IMAP nem valaszol') })
    await vi.waitFor(() => expect(isRefreshInFlight('kulcs-2')).toBe(false))
    let futott = false
    refreshInBackground('kulcs-2', async () => { futott = true })
    expect(futott).toBe(true)
  })
})

describe('a ket lista-vegpont tenyleg igy valaszol', () => {
  it('a levellista elavult valasza azonnal megy ki, es jelzi is magat', () => {
    const blokk = ROUTE.slice(ROUTE.indexOf("if (path === '/api/email/envelopes'"))
    expect(blokk).toContain('cacheGetStale(envelopeListCache, envelopeCacheKey, ENVELOPE_STALE_MAX_MS)')
    expect(blokk).toContain("{ 'X-Marveen-Stale': '1' }")
    expect(blokk).toContain('refreshInBackground(')
  })

  it('a mappalista ugyanigy', () => {
    const blokk = ROUTE.slice(ROUTE.indexOf("if (path === '/api/email/mailboxes' && method === 'GET')"))
    expect(blokk).toContain('cacheGetStale(mailboxListCache, account as string, MAILBOX_STALE_MAX_MS)')
    expect(blokk).toContain("{ 'X-Marveen-Stale': '1' }")
  })

  it('a hatter-frissites UGYANAZT a lekerot hasznalja, mint a blokkolo ag', () => {
    // Ha a ketto kulon kodon menne, a hatterben mas lista allna elo, mint
    // amit a varakoztato ag ad -- olyan elteres, amit senki sem venne eszre.
    expect(ROUTE.match(/fetchEnvelopeList\(/g)?.length).toBeGreaterThanOrEqual(3) // deklaracio + ket hivas
    expect(ROUTE.match(/fetchMailboxList\(/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('a valasz TESTE valtozatlanul csupasz tomb marad', () => {
    // Minden fogyaszto (frontend, tesztek) tombot var: a stale-jelzes ezert
    // fejlecben megy, nem a JSON-ban.
    expect(ROUTE).toContain('json(res, staleEnvelopes, 200,')
    expect(ROUTE).not.toContain('json(res, { stale: true')
  })
})
