import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { driveSyncRows, reszlegesEredmeny, DRIVE_SYNC_STALE_DAYS } from '../web/system-health.js'

/**
 * A Drive-mentes NEMA hibai.
 *
 * A mero eset: 2026-08-27-en a mentes 11 napja allt, es a fo fiok masolata
 * "reszleges" volt. Egyik sem latszott sehol. Ezek a tesztek pontosan azt
 * ellenorzik, hogy MOST latszana-e -- es hogy a csend tovabbra is csend marad
 * ott, ahol a csend a helyes valasz.
 */

const MOST = Date.parse('2026-08-27T12:00:00Z')
const napokkalEzelott = (n: number) => new Date(MOST - n * 86_400_000).toISOString()
const kartya = (letezik: boolean, bekapcsolva = true) => ({ letezik, bekapcsolva })
const rendben = (parok: Array<Record<string, unknown>>) => ({ fajta: 'rendben' as const, parok })

describe('a Drive-mentes megall vagy megcsonkul, es errol szolni kell', () => {
  it('friss telepitesen HALLGAT (nulla paros = meg nincs, nem baj)', () => {
    expect(driveSyncRows(MOST, { fajta: 'hianyzik', parok: [] }, kartya(false), null)).toEqual([])
    expect(driveSyncRows(MOST, rendben([]), kartya(false), null)).toEqual([])
  })

  it('olvashatatlan beallitas-fajl NEM ugyanaz, mint a nulla paros', () => {
    const r = driveSyncRows(MOST, { fajta: 'olvashatatlan', parok: [] }, kartya(true), true)
    expect(r.map((x) => x.id)).toEqual(['drive_sync_unreadable'])
    expect(r[0].status).toBe('bad')
  })

  it('elerhetetlen depo eseten AZ a hiba, nem a "hany napja"', () => {
    const parok = [{ account: 'lackor2', lastRunAt: napokkalEzelott(40) }]
    const r = driveSyncRows(MOST, rendben(parok), kartya(true), false)
    expect(r.map((x) => x.id)).toEqual(['drive_sync_depot_unreachable'])
    expect(r[0].params).toMatchObject({ n: 1 })
  })

  it('a csonka masolat "bad", es megnevezi a fiokot', () => {
    const parok = [
      { account: 'lackor2', lastRunAt: napokkalEzelott(0), lastResult: 'részleges: elértük a felső határt (500 mappa / 5000 fájl), a többi kimaradt' },
      { account: 'usalackor', lastRunAt: napokkalEzelott(0), lastResult: 'kész' },
    ]
    const r = driveSyncRows(MOST, rendben(parok), kartya(true), true)
    const sor = r.find((x) => x.id === 'drive_sync_partial')
    expect(sor?.status).toBe('bad')
    expect(sor?.params).toMatchObject({ n: 1, all: 2, names: 'lackor2' })
    // A friss futas NEM nyomhatja el a csonkasagot zold sorral.
    expect(r.some((x) => x.id === 'drive_sync_ok')).toBe(false)
  })

  it('a "reszleges" felismerese a szinkron sajat szovegehez igazodik', () => {
    expect(reszlegesEredmeny('részleges: elértük a felső határt')).toBe(true)
    expect(reszlegesEredmeny('Részleges: ...')).toBe(true)
    expect(reszlegesEredmeny('kész')).toBe(false)
    expect(reszlegesEredmeny(undefined)).toBe(false)
  })

  it('az elavulas sargarol pirosra valt, ahogy no', () => {
    const p = (n: number) => rendben([{ account: 'a', lastRunAt: napokkalEzelott(n) }])
    expect(driveSyncRows(MOST, p(DRIVE_SYNC_STALE_DAYS), kartya(true), true).map((x) => x.id)).toEqual(['drive_sync_ok'])
    expect(driveSyncRows(MOST, p(5), kartya(true), true).find((x) => x.id === 'drive_sync_stale')?.status).toBe('warn')
    // 11 nap: pontosan a mert eset.
    expect(driveSyncRows(MOST, p(11), kartya(true), true).find((x) => x.id === 'drive_sync_stale')?.status).toBe('warn')
    expect(driveSyncRows(MOST, p(30), kartya(true), true).find((x) => x.id === 'drive_sync_stale')?.status).toBe('bad')
  })

  it('bekotott mappa + hianyzo vagy kikapcsolt utemezes = szol', () => {
    const parok = rendben([{ account: 'a', lastRunAt: napokkalEzelott(0) }])
    expect(driveSyncRows(MOST, parok, kartya(false), true).map((x) => x.id)).toContain('drive_sync_no_task')
    const ki = driveSyncRows(MOST, parok, kartya(true, false), true)
    expect(ki.find((x) => x.id === 'drive_sync_task_disabled')?.status).toBe('bad')
  })

  it('bekotott mappa, de meg soha nem futott', () => {
    const r = driveSyncRows(MOST, rendben([{ account: 'a' }]), kartya(true), true)
    expect(r.map((x) => x.id)).toContain('drive_sync_never')
  })

  it('ha minden rendben, ZOLD sor all ott -- a hallgatas nem bizonyitek', () => {
    const r = driveSyncRows(MOST, rendben([{ account: 'a', lastRunAt: napokkalEzelott(1), lastResult: 'kész' }]), kartya(true), true)
    expect(r.map((x) => x.id)).toEqual(['drive_sync_ok'])
    expect(r[0].params).toMatchObject({ n: 1, d: 1 })
  })

  it('MINDEN sorazonositohoz van magyar ES angol felirat + teendo', () => {
    const gyujto = new Set<string>()
    const ossz = [
      driveSyncRows(MOST, { fajta: 'olvashatatlan', parok: [] }, kartya(true), true),
      driveSyncRows(MOST, rendben([{ account: 'a' }]), kartya(true), false),
      driveSyncRows(MOST, rendben([{ account: 'a' }]), kartya(false), true),
      driveSyncRows(MOST, rendben([{ account: 'a', lastRunAt: napokkalEzelott(0) }]), kartya(true, false), true),
      driveSyncRows(MOST, rendben([{ account: 'a', lastRunAt: napokkalEzelott(0), lastResult: 'részleges: x' }]), kartya(true), true),
      driveSyncRows(MOST, rendben([{ account: 'a', lastRunAt: napokkalEzelott(30) }]), kartya(true), true),
      driveSyncRows(MOST, rendben([{ account: 'a', lastRunAt: napokkalEzelott(1) }]), kartya(true), true),
    ]
    for (const r of ossz) for (const sor of r) gyujto.add(sor.id)
    expect(gyujto.size).toBeGreaterThanOrEqual(7)
    for (const nyelv of ['hu', 'en']) {
      const forras = readFileSync(join(process.cwd(), 'web/lang', nyelv + '.js'), 'utf-8')
      for (const id of gyujto) {
        expect(forras, nyelv + ' / ' + id).toContain("'health." + id + "'")
        expect(forras, nyelv + ' / ' + id + '_action').toContain("'health." + id + "_action'")
      }
    }
  })

  it('a zold sor a felulet zold listajaba is bekerul', () => {
    const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf-8')
    expect(app).toContain("h.id === 'drive_sync_ok'")
  })
})
