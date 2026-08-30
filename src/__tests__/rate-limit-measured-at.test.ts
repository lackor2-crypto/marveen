// A keret-figyelo kora: mikor MERTUK a szazalekot, es nem mikor irtuk a fajlt.
//
// A valos eset (Boss, 2026-08-15, kepernyokep): a VS Code Claude Code 81%-os
// 5 oras keretet mutatott az usalackor fiokra, a Marveen ugyanarra a fiokra
// 11%-ot -- es semmi nem arulta el, hogy az a 11% harom oras meres. Ket
// kulon hiba talalkozott:
//   1) a statusline megtartja a regi szazalekokat, ha az adott frissitesben
//      nem jott `rate_limits` -- es kozben az `updatedAt` frissul, tehat egy
//      sokat rajzolo agens vegtelensegig FRISSNEK latszott;
//   2) a `windowsUpdatedAt` mezot (mikor valtoztak a szamok) a TS oldal
//      egyaltalan nem olvasta be.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isStale, STALE_AFTER_MS } from '../rate-limit-status.js'

const ROOT = join(__dirname, '..', '..')
const SL = join(ROOT, 'scripts', 'hooks', 'statusline.py')
let tmp = ''

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'keret-teszt-')) })
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* mar nincs */ } })

function runStatusline(payload: unknown, args: string[] = []): string {
  return execFileSync('/usr/bin/python3', [SL, ...args], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 10_000,
  })
}

const PAYLOAD = {
  model: { display_name: 'Opus 5' },
  cwd: 'D:\\Tozsde_telepitesi_mappa',
  context_window: { used_percentage: 20 },
  rate_limits: {
    five_hour: { used_percentage: 81, resets_at: 1786800000 },
    seven_day: { used_percentage: 69, resets_at: 1787248800 },
  },
}

describe('a Windowson futo Claude Code is tud jelenteni', () => {
  it('kapcsolok nelkul -- ahogy eddig volt -- semmit nem ir', () => {
    // Ez maga a hiba: a VS Code-os munkakonyvtar nincs a Marveen fajan belul,
    // tehat a "kapaszkodj felfele a .env-ig" keresés nem talal semmit.
    const out = runStatusline(PAYLOAD)
    expect(out.trim()).toContain('5h 81%')     // a felhasznalonak azert kiirja
    // de a Marveenbe semmi nem kerul: nincs hova
  })

  it('--agent + --project-root mellett a pillanatkep a helyere kerul', () => {
    const dir = join(tmp, 'store', 'rate-limit-status')
    mkdirSync(dir, { recursive: true })
    runStatusline(PAYLOAD, ['--agent', 'usalackor', '--project-root', tmp])
    const snap = JSON.parse(readFileSync(join(dir, 'usalackor.json'), 'utf8'))
    expect(snap.agent).toBe('usalackor')
    expect(snap.fiveHour.usedPct).toBe(81)
    expect(snap.sevenDay.usedPct).toBe(69)
    // A Claude masodpercben adja meg, a felulet ezredmasodpercben szamol.
    expect(snap.fiveHour.resetsAt).toBe(1786800000 * 1000)
  })

  it('a fiok-nev nem tud kilepni a mappajabol', () => {
    const dir = join(tmp, 'store', 'rate-limit-status')
    mkdirSync(dir, { recursive: true })
    runStatusline(PAYLOAD, ['--agent', '../../../gonosz', '--project-root', tmp])
    expect(() => readFileSync(join(tmp, 'gonosz.json'), 'utf8')).toThrow()
    expect(() => readFileSync(join(tmp, '..', 'gonosz.json'), 'utf8')).toThrow()
  })

  it('hianyzo ertek a kapcsolo utan sem torolheti le a statuszsort', () => {
    // Egy elszallo statusline kiuriti a felhasznalo statuszsorat -- sosem
    // szabad kivetellel vegzodnie.
    expect(runStatusline(PAYLOAD, ['--agent']).trim()).toContain('Opus 5')
    expect(runStatusline(PAYLOAD, ['--project-root']).trim()).toContain('Opus 5')
    expect(runStatusline(PAYLOAD, ['--ismeretlen', 'x']).trim()).toContain('Opus 5')
  })
})

describe('a szamok kora, nem a fajl kora', () => {
  it('megtartott szazaleknal a meres ideje NEM frissul', () => {
    const dir = join(tmp, 'store', 'rate-limit-status')
    mkdirSync(dir, { recursive: true })
    // 1) valodi meres
    runStatusline(PAYLOAD, ['--agent', 'a', '--project-root', tmp])
    const first = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))
    // 2) kesobbi frissites, amiben NINCS rate_limits (tetlen agens)
    const { rate_limits, ...noLimits } = PAYLOAD as any
    runStatusline(noLimits, ['--agent', 'a', '--project-root', tmp])
    const second = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))

    expect(second.fiveHour.usedPct).toBe(81)                    // az ertek megmarad
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)  // a fajl friss
    expect(second.windowsUpdatedAt).toBe(first.windowsUpdatedAt)      // a MERES nem
  })

  it('a beolvaso atveszi a meres idejet', async () => {
    const { readRateLimitSnapshot } = await import('../web/rate-limit-status-io.js')
    // A beolvaso a projekt sajat store-jabol dolgozik, ezert itt csak a
    // mezo-lekepezest ellenorizzuk forrasbol: a valodi I/O-t a fenti
    // statusline-teszt fedi le.
    const io = readFileSync(join(ROOT, 'src', 'web', 'rate-limit-status-io.ts'), 'utf8')
    expect(io).toContain('measuredAt:')
    expect(io).toContain('raw.windowsUpdatedAt')
    expect(typeof readRateLimitSnapshot).toBe('function')
  })

  it('regi pillanatkep (meg windowsUpdatedAt nelkul) nem lesz "ohkori"', () => {
    // Visszaeses az updatedAt-re, nem 0-ra: kulonben minden korabbi fajl
    // azonnal elavultra valtana, es eltunnenek a meg ervenyes szazalekok.
    const io = readFileSync(join(ROOT, 'src', 'web', 'rate-limit-status-io.ts'), 'utf8')
    expect(io).toMatch(/measuredAt:[\s\S]{0,400}Number\.isFinite\(raw\.updatedAt\) \? raw\.updatedAt : 0/)
  })

  it('az attekintes a meres korat nezi, nem a fajlet', () => {
    const ov = readFileSync(join(ROOT, 'src', 'web', 'routes', 'overview.ts'), 'utf8')
    expect(ov).toContain('isStale(rlSnapshot.measuredAt, Date.now())')
    expect(ov).toContain('isStale(snap.measuredAt, Date.now())')
    // Es tovabb is adja, hogy a felulet ki tudja irni, mennyire regi.
    // (2026-08-30 ota zarojelben all, mert elo panel-leolvasasnal a MOSTANI
    // ido lep a helyebe -- a mezo maga es a jelentese valtozatlan.)
    expect(ov).toContain('rlSnapshot?.measuredAt ?? null')
  })

  it('a felulet MINDIG kiirja a meres korat, ha van mit', () => {
    // Boss, 2026-08-17 (Telegram 370, "jah. lassuk mindig"): eredetileg csak
    // ELAVULT meresnel irtuk ki a kort. Boss ezt megforditotta -- friss adatnal
    // is latni akarja, mikor mertuk --, ezert az egyetlen feltetel az, hogy
    // legyen meresi ido. A teszt szandekosan lett a kod ala igazitva: a regi
    // `!acc.stale ||` agat NEM visszaallitani kell, hanem tavol tartani.
    const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
    expect(app).toContain('overview.ratelimit.measured_hours')
    expect(app).toContain('overview.ratelimit.measured_mins')
    expect(app).toMatch(/if \(!acc\.measuredAt\) return ''/)
    // Amirol nincs adat, arrol ne irjunk oda semmit: ures cimke ne foglaljon
    // helyet a fiok neve mellett.
    expect(app).not.toMatch(/if \(!acc\.stale \|\| !acc\.measuredAt\)/)
  })

  it('a 30 perces kuszob valtozatlan', () => {
    expect(STALE_AFTER_MS).toBe(30 * 60_000)
    const now = Date.now()
    expect(isStale(now - 29 * 60_000, now)).toBe(false)
    expect(isStale(now - 31 * 60_000, now)).toBe(true)
  })
})
