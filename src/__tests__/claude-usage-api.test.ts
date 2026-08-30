// Az ELO keret-lekerdezes (src/web/claude-usage-api.ts).
//
// A valos eset (Boss, 2026-08-30): "ha a vscode dolgozik, es a marveen nem,
// ugyanazzal a claude fiokkal, akkor a marveen nal lehet hogy 6% van, es
// sohasem frissul es kozben a vscode nal meg 98% van!" -- a pillanatkep egy
// AGENS utolso jelenteset merte, nem a FIOK allapotat. A VS Code bovitmeny
// ugyanezt a vegpontot kerdezi, ezert most mi is.
//
// Amit ez a fajl vedelmez: (1) a keres alakja (URL/fejlecek) ne csusszon el;
// (2) a hiba oka a TENYLEGES valaszbol jojjon, sose talalgatasbol; (3) egy
// 200-as, de ertelmezhetetlen valasz NE nulla szazaleknak latsszon.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_USAGE_URL, CLAUDE_OAUTH_BETA,
  readAccountAccessToken, readFleetToken,
  fetchLiveUsage, liveUsageForAccount, clearLiveUsageCacheForTest,
} from '../web/claude-usage-api.js'

let tmp = ''
const realFetch = globalThis.fetch

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'usage-api-')); clearLiveUsageCacheForTest() })
afterEach(() => {
  globalThis.fetch = realFetch
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* mar nincs */ }
})

const json = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }))

describe('a fiok tokenje', () => {
  it('a sajat config-konyvtarabol jon', () => {
    writeFileSync(join(tmp, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-x' } }))
    expect(readAccountAccessToken(tmp)).toBe('sk-x')
  })

  it('hianyzo vagy ures tokennel null -- NEM esik at masik fiokra', () => {
    // Egy masik fiok tokenjevel lekerdezve egy MASIK fiok szamait irnank ki
    // ennek a sornak a melle: az rosszabb, mint az ures cella.
    expect(readAccountAccessToken(tmp)).toBeNull()
    writeFileSync(join(tmp, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '' } }))
    expect(readAccountAccessToken(tmp)).toBeNull()
    writeFileSync(join(tmp, '.credentials.json'), 'nem json')
    expect(readAccountAccessToken(tmp)).toBeNull()
  })

  it('a flotta-token fajlbol jon, korulvagva', () => {
    const p = join(tmp, 'tok')
    writeFileSync(p, '  sk-fleet\n')
    expect(readFleetToken(p)).toBe('sk-fleet')
    expect(readFleetToken(join(tmp, 'nincs-ilyen'))).toBeNull()
  })
})

describe('a lekerdezes', () => {
  it('a VS Code bovitmennyel azonos vegpontot es fejleceket hasznal', async () => {
    const f = json(200, { five_hour: { utilization: 88, resets_at: '2026-08-30T18:00:00Z' } })
    globalThis.fetch = f as unknown as typeof fetch
    await fetchLiveUsage('sk-x')
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(CLAUDE_USAGE_URL)
    const h = (init.headers ?? {}) as Record<string, string>
    expect(h.Authorization).toBe('Bearer sk-x')
    expect(h['anthropic-beta']).toBe(CLAUDE_OAUTH_BETA)
  })

  it('mindket ablakot beolvassa, a resets_at ezredmasodpercre valt', async () => {
    globalThis.fetch = json(200, {
      five_hour: { utilization: 88, resets_at: '2026-08-30T18:00:00Z' },
      seven_day: { utilization: 90, resets_at: null },
    }) as unknown as typeof fetch
    const r = await fetchLiveUsage('sk-x', 1_000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.usage.fiveHour?.usedPct).toBe(88)
    expect(r.usage.fiveHour?.resetsAt).toBe(Date.parse('2026-08-30T18:00:00Z'))
    expect(r.usage.sevenDay?.usedPct).toBe(90)
    expect(r.usage.sevenDay?.resetsAt).toBeNull()   // nem mondta meg: nem talalgatunk
    expect(r.usage.measuredAt).toBe(1_000)
  })

  it('a hiba oka a TENYLEGES valaszbol jon, nem talalgatasbol', async () => {
    globalThis.fetch = json(401, {}) as unknown as typeof fetch
    expect(await fetchLiveUsage('sk-x')).toMatchObject({ ok: false, reason: 'expired-login', detail: 'HTTP 401' })

    globalThis.fetch = json(500, {}) as unknown as typeof fetch
    expect(await fetchLiveUsage('sk-x')).toMatchObject({ ok: false, reason: 'unknown-answer', detail: 'HTTP 500' })

    globalThis.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as unknown as typeof fetch
    expect(await fetchLiveUsage('sk-x')).toMatchObject({ ok: false, reason: 'network', detail: 'getaddrinfo ENOTFOUND' })
  })

  it('ertelmezhetetlen 200-as valasz NEM nulla szazalek', async () => {
    // A nulla ket dolgot jelenthet: "nincs elhasznalva" vagy "nem latok oda".
    // Ez a masodik -- es kulon kell tudni tole.
    globalThis.fetch = json(200, { valami_mas: true }) as unknown as typeof fetch
    const r = await fetchLiveUsage('sk-x')
    expect(r).toMatchObject({ ok: false, reason: 'unknown-answer' })
  })
})

describe('a gyorsitotar', () => {
  it('token nelkul meg csak meg sem probalja', async () => {
    const f = vi.fn()
    globalThis.fetch = f as unknown as typeof fetch
    expect(await liveUsageForAccount('a', null)).toMatchObject({ ok: false, reason: 'no-credential' })
    expect(f).not.toHaveBeenCalled()
  })

  it('rendes koron belul egyszer kerdez, a bongeszo-frissites atlepi', async () => {
    const f = json(200, { five_hour: { utilization: 10, resets_at: null } })
    globalThis.fetch = f as unknown as typeof fetch
    await liveUsageForAccount('a', 'sk-x', { now: 1_000 })
    await liveUsageForAccount('a', 'sk-x', { now: 6_000 })            // TTL-en belul
    expect(f).toHaveBeenCalledTimes(1)
    await liveUsageForAccount('a', 'sk-x', { now: 6_001, force: true }) // F5
    expect(f).toHaveBeenCalledTimes(2)
    // ...de egy F5-sorozat sem indithat tetszoleges szamu kerest
    await liveUsageForAccount('a', 'sk-x', { now: 6_500, force: true })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('a fiokok nem latjak egymas valaszat', async () => {
    const f = json(200, { five_hour: { utilization: 10, resets_at: null } })
    globalThis.fetch = f as unknown as typeof fetch
    await liveUsageForAccount('a', 'sk-a', { now: 1_000 })
    await liveUsageForAccount('b', 'sk-b', { now: 1_000 })
    expect(f).toHaveBeenCalledTimes(2)
  })
})
