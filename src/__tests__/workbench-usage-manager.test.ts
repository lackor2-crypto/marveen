// AI Munkapad (kanban #336, 2. fazis): a KOZOS 5 oras keret kapuja.
//
// Amit oriz -- ez a spec 0.2 lenyege, es az egesz fazis legkockazatosabb
// pontja: a Munkapad NEM elheti fel kontroll nelkul a flotta keretet.
//
//   1. a kapu a MEGLEVO merest hasznalja (nem uj szamlalo);
//   2. kritikus 5 oras keretnel NEM indul uj hivas;
//   3. a HETI keret SOSE blokkol (rate-limit-gate-fivehour-only);
//   4. "nincs meres" != "0%" -- a hianyzo meres nem tilt le mindent, de
//      kimondjuk, hogy nem latunk oda;
//   5. a foglalas a MOST indulo hivasokat szamolja, amiket a kesve erkezo
//      meres meg nem lat.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getUsage, getWindow, getRemaining, reserve, release, record, recentCalls,
  resetUsageManagerForTest, setUsageSnapshotReader, MAX_CONCURRENT, RESERVATION_TTL_MS, RECENT_KEEP,
} from '../workbench-agent/usage-manager.js'
import { STALE_AFTER_MS } from '../rate-limit-status.js'

const NOW = 1_800_000_000_000

/** Egy statusline-pillanatkep, ahogy a flotta merese adja. */
function snapshot(fiveHourPct: number | null, opts: { measuredAt?: number; resetsAt?: number | null; sevenDayPct?: number } = {}) {
  return () => ({
    fiveHour: fiveHourPct === null ? null : { usedPct: fiveHourPct, resetsAt: opts.resetsAt ?? null },
    sevenDay: opts.sevenDayPct === undefined ? null : { usedPct: opts.sevenDayPct, resetsAt: null },
    measuredAt: opts.measuredAt ?? NOW,
    updatedAt: opts.measuredAt ?? NOW,
  })
}

beforeEach(() => { resetUsageManagerForTest() })
afterEach(() => { setUsageSnapshotReader(null); resetUsageManagerForTest() })

describe('getWindow -- a meglevo merest olvassa', () => {
  it('a mert 5 oras szazalekot adja vissza, a visszaallas idejevel', () => {
    setUsageSnapshotReader(snapshot(42, { resetsAt: NOW + 3600_000 }))
    const w = getWindow('barmelyik', NOW)
    expect(w.usedPct).toBe(42)
    expect(w.resetsAt).toBe(NOW + 3600_000)
    expect(w.source).toBe('snapshot')
    expect(w.stale).toBe(false)
  })

  it('NINCS meres: usedPct null (NEM 0), a forras "none"', () => {
    setUsageSnapshotReader(() => null)
    const w = getWindow('barmelyik', NOW)
    expect(w.usedPct).toBeNull()
    expect(w.usedPct).not.toBe(0)
    expect(w.source).toBe('none')
  })

  it('a regi meres elavultnak latszik, de attol meg meres', () => {
    setUsageSnapshotReader(snapshot(99, { measuredAt: NOW - STALE_AFTER_MS - 1000 }))
    const w = getWindow('barmelyik', NOW)
    expect(w.usedPct).toBe(99)
    expect(w.stale).toBe(true)
  })

  it('egy hibat dobo merest nem enged ki: "nincs meres" lesz belole', () => {
    setUsageSnapshotReader(() => { throw new Error('a pillanatkep serult') })
    expect(getWindow('barmelyik', NOW).usedPct).toBeNull()
  })
})

describe('getRemaining -- szabad-e MOST hivni', () => {
  it('normal keretnel szabad', () => {
    setUsageSnapshotReader(snapshot(40))
    const r = getRemaining('a', NOW)
    expect(r.allowed).toBe(true)
    expect(r.remainingPct).toBe(55) // 95 (kritikus kuszob) - 40
  })

  it('90% (figyelmeztetes) meg nem blokkol', () => {
    setUsageSnapshotReader(snapshot(90))
    expect(getRemaining('a', NOW).allowed).toBe(true)
  })

  it('95% felett (kritikus) NEM indit uj hivast', () => {
    setUsageSnapshotReader(snapshot(96))
    const r = getRemaining('a', NOW)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('limit_critical')
  })

  it('a HETI keret akkor sem blokkol, ha tele van', () => {
    setUsageSnapshotReader(snapshot(10, { sevenDayPct: 100 }))
    expect(getRemaining('a', NOW).allowed).toBe(true)
  })

  it('nincs meres: ENGED, de kimondja hogy nem latunk oda', () => {
    setUsageSnapshotReader(() => null)
    const r = getRemaining('a', NOW)
    expect(r.allowed).toBe(true)
    expect(r.usage.usedPct).toBeNull()
    expect(r.remainingPct).toBeNull()
  })

  it('elavult kritikus meres nem blokkol -- egy regi szam nem bizonyitek', () => {
    setUsageSnapshotReader(snapshot(99, { measuredAt: NOW - STALE_AFTER_MS - 1000 }))
    expect(getRemaining('a', NOW).allowed).toBe(true)
  })
})

describe('reserve / release / record', () => {
  beforeEach(() => { setUsageSnapshotReader(snapshot(10)) })

  it('a foglalas latszik az egyideju hivasok szamaban', () => {
    expect(getUsage('a', NOW).inFlight).toBe(0)
    const r = reserve('a', NOW)
    expect(r.ok).toBe(true)
    expect(getUsage('a', NOW).inFlight).toBe(1)
  })

  it('a felszabaditas visszaadja a helyet', () => {
    const r = reserve('a', NOW)
    if (!r.ok) throw new Error('a foglalasnak sikerulnie kellett')
    expect(release(r.reservation.id)).toBe(true)
    expect(getUsage('a', NOW).inFlight).toBe(0)
  })

  it('tul sok egyideju hivas eseten a foglalas elutasit', () => {
    for (let i = 0; i < MAX_CONCURRENT; i++) expect(reserve('a', NOW).ok).toBe(true)
    const over = reserve('a', NOW)
    expect(over.ok).toBe(false)
    if (over.ok) throw new Error('nem szabadott volna sikerulnie')
    expect(over.reason).toBe('too_many_in_flight')
  })

  it('a beragadt foglalas magatol elevul (egy elszallt keres nem zarja el a Munkapadot)', () => {
    for (let i = 0; i < MAX_CONCURRENT; i++) reserve('a', NOW)
    expect(reserve('a', NOW).ok).toBe(false)
    const later = NOW + RESERVATION_TTL_MS + 1
    expect(reserve('a', later).ok).toBe(true)
  })

  it('a konyveles elengedi a foglalast es megorzi a hivast', () => {
    const r = reserve('a', NOW)
    if (!r.ok) throw new Error('foglalas')
    record(r.reservation.id, { agent: 'a', model: 'teszt-modell', outcome: 'ok', durationMs: 1200, at: NOW })
    expect(getUsage('a', NOW).inFlight).toBe(0)
    const calls = recentCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: 'teszt-modell', outcome: 'ok', durationMs: 1200 })
  })

  it('a konyveles nem no a vegtelensegig', () => {
    for (let i = 0; i < RECENT_KEEP + 10; i++) {
      record(null, { agent: 'a', model: 'm', outcome: 'ok', durationMs: 1, at: NOW + i })
    }
    expect(recentCalls()).toHaveLength(RECENT_KEEP)
  })

  it('kritikus keretnel a foglalas MEG SEM adja ki a helyet', () => {
    setUsageSnapshotReader(snapshot(99))
    const r = reserve('a', NOW)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('nem szabadott volna')
    expect(r.reason).toBe('limit_critical')
    expect(getUsage('a', NOW).inFlight).toBe(0)
  })
})
