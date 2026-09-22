/**
 * A FELIG FELMENT MENTES (#47) -- se nem hiba, se nem "rendben".
 *
 * A raktar-mentes elso feltoltese TOBB EJSZAKA: futasonkent 2000 fajl megy fel
 * (MERVE 2026-08-28: a mentendo ag 9356 fajl). Amig var fajl, NINCS teljes
 * mentes -- aki ilyenkor zold sort lat, azt hiszi, biztonsagban van.
 *
 * Ez a `drive_sync_partial`-tol KULON eset: ott a kep volt csonka (nem is
 * lattuk, mi maradt ki), itt a kep teljes, csak a feltoltes fer bele
 * reszletekben. A ketto mas teendot ad, ezert ket kulon sor.
 */
import { describe, it, expect } from 'vitest'
import { driveSyncRows, varakozoFajlok } from '../web/system-health.js'

const MOST = Date.parse('2026-08-28T12:00:00Z')
const napokkalEzelott = (n: number) => new Date(MOST - n * 86_400_000).toISOString()
const kartya = { letezik: true, bekapcsolva: true }
const rendben = (parok: Array<Record<string, unknown>>) => ({ fajta: 'rendben' as const, parok })

/**
 * Egy akadas a legutobbi futasbol. A `files` a MERT hibaszam: hany fajl akadt
 * el EBBOL az okbol, EBBEN a fiokban -- nem a globalis varakozo-szam.
 */
const akadas = (kind: 'quota' | 'abusive' | 'auth' | 'other', account: string, files: number, at = napokkalEzelott(0), extra: Partial<{ names: string; message: string }> = {}) =>
  ({ kind, account, files, names: extra.names || '', message: extra.message || '', at })

describe('a felig felment mentes nem mutathat zold sort', () => {
  it('varakozo fajloknal SARGA sor jon, a fajlok szamaval', () => {
    const r = driveSyncRows(MOST, rendben([
      { account: 'lackor2', lastRunAt: napokkalEzelott(0), lastResult: 'folyamatban: még 7356 fájl vár feltöltésre', lastPending: 7356 },
    ]), kartya, true)
    const sor = r.find((x) => x.id === 'drive_sync_incomplete')
    expect(sor?.status).toBe('warn')
    expect(sor?.params).toMatchObject({ n: 1, f: 7356 })
  })

  it('a zold "rendben" sor ilyenkor NEM jelenik meg', () => {
    const r = driveSyncRows(MOST, rendben([
      { account: 'lackor2', lastRunAt: napokkalEzelott(0), lastResult: 'rendben' },
      { account: 'usalackor', lastRunAt: napokkalEzelott(0), lastResult: 'folyamatban', lastPending: 12 },
    ]), kartya, true)
    expect(r.some((x) => x.id === 'drive_sync_ok')).toBe(false)
    expect(r.some((x) => x.id === 'drive_sync_incomplete')).toBe(true)
  })

  it('tobb mentes varakozo fajljait OSSZEADJA, es megmondja, hany mentesrol van szo', () => {
    const r = driveSyncRows(MOST, rendben([
      { account: 'a', lastRunAt: napokkalEzelott(0), lastPending: 100 },
      { account: 'b', lastRunAt: napokkalEzelott(0), lastPending: 250 },
      { account: 'c', lastRunAt: napokkalEzelott(0), lastResult: 'rendben' },
    ]), kartya, true)
    expect(r.find((x) => x.id === 'drive_sync_incomplete')?.params).toMatchObject({ n: 2, f: 350 })
  })

  it('ha minden felment, HALLGAT (a kesz mentes nem tema)', () => {
    const r = driveSyncRows(MOST, rendben([
      { account: 'a', lastRunAt: napokkalEzelott(0), lastResult: 'rendben', lastPending: 0 },
    ]), kartya, true)
    expect(r.some((x) => x.id === 'drive_sync_incomplete')).toBe(false)
    // Es a zold sor VISSZAJON, kulonben nem lehetne latni, hogy rendben van.
    expect(r.some((x) => x.id === 'drive_sync_ok')).toBe(true)
  })

  it('a CSONKA masolat sulyosabb, es ott is latszik, hogy meg fel is van uton', () => {
    // A ketto egyutt is elofordulhat: a csonkasag `bad`, a varakozas `warn`.
    // Egyiket sem szabad a masikkal helyettesiteni -- mas a teendo.
    const r = driveSyncRows(MOST, rendben([
      { account: 'a', lastRunAt: napokkalEzelott(0), lastResult: 'részleges: elértük a felső határt', lastPending: 40 },
    ]), kartya, true)
    expect(r.map((x) => x.id)).toContain('drive_sync_partial')
    expect(r.map((x) => x.id)).toContain('drive_sync_incomplete')
    expect(r.some((x) => x.id === 'drive_sync_ok')).toBe(false)
  })
})

describe('hitelesitesi hibanal a "magatol folytatja" sor NEM jelenhet meg', () => {
  it('auth-beragadasnal PIROS auth-sor jon, nem a megnyugtato incomplete', () => {
    const r = driveSyncRows(MOST, rendben([
      { account: 'nyalomapuncidma', lastRunAt: napokkalEzelott(0), lastPending: 518 },
    ]), kartya, true, [akadas('auth', 'nyalomapuncidma', 518)])
    const sor = r.find((x) => x.id === 'drive_sync_auth_stuck')
    expect(sor?.status).toBe('bad')
    expect(sor?.params).toMatchObject({ f: 518, account: 'nyalomapuncidma' })
    // A hazug sor ilyenkor NEM lehet ott.
    expect(r.some((x) => x.id === 'drive_sync_incomplete')).toBe(false)
  })

  it('elavult auth-naplo (azota hibatlan futas volt) nem ad hamis piros sort', () => {
    const r = driveSyncRows(MOST, rendben([
      { account: 'a', lastRunAt: napokkalEzelott(0), lastPending: 10 },
    ]), kartya, true, [akadas('auth', 'a', 10, napokkalEzelott(3))])
    expect(r.some((x) => x.id === 'drive_sync_auth_stuck')).toBe(false)
    expect(r.some((x) => x.id === 'drive_sync_incomplete')).toBe(true)
  })

  it('auth-hiba nelkul (null) a regi incomplete viselkedes marad', () => {
    const r = driveSyncRows(MOST, rendben([
      { account: 'a', lastRunAt: napokkalEzelott(0), lastPending: 10 },
    ]), kartya, true, [])
    expect(r.some((x) => x.id === 'drive_sync_incomplete')).toBe(true)
    expect(r.some((x) => x.id === 'drive_sync_auth_stuck')).toBe(false)
  })

  // A hiba, amit lackor3 talalt (2026-09-16): tobb fioknal az auth-sor a
  // GLOBALIS varakozo-fajlszamot ragasztotta az auth-hibas fiok neve melle,
  // igy egy MASIK, epp toltogeto fiok fajljait az auth-hibas fiokra fogta.
  it('tobb fioknal az auth-sor CSAK a hibas fiok sajat varakozoit szamolja, nem a globalist', () => {
    const r = driveSyncRows(MOST, rendben([
      // Az auth-hibas fiok: sajat 30 fajlja beragadt.
      { account: 'nyalomapuncidma', lastRunAt: napokkalEzelott(0), lastPending: 30 },
      // Egy MASIK, egeszseges fiok: 1125 fajlt tolt fel, magatol halad.
      { account: 'lackor2', lastRunAt: napokkalEzelott(0), lastPending: 1125 },
    ]), kartya, true, [akadas('auth', 'nyalomapuncidma', 30)])
    const auth = r.find((x) => x.id === 'drive_sync_auth_stuck')
    // NEM 1155 (30+1125), csak a hibas fiok sajat 30-a.
    expect(auth?.params).toMatchObject({ f: 30, account: 'nyalomapuncidma' })
    // A masik fiok varakozoi kulon, megnyugtato sorba kerulnek -- nem az auth-sorba.
    const inc = r.find((x) => x.id === 'drive_sync_incomplete')
    expect(inc?.status).toBe('warn')
    expect(inc?.params).toMatchObject({ n: 1, f: 1125 })
  })

  // Boss, 2026-09-22: a kepernyon ez allt: "0 fajl beragadt, mert a Google-fiok
  // (nyalomapuncidma) nem tud belepni". Egy nulla darabszamu riasztas
  // onellentmondas -- es raadasul hamis is volt (a fiok belep). A sor szama
  // mostantol a MERT hibakbol jon, ezert soha nem lehet nulla: ha nincs mert
  // hiba, nincs sor sem.
  it('a sor SOHA nem allithatja, hogy "0 fajl beragadt"', () => {
    const r = driveSyncRows(MOST, rendben([
      // A fiokban nincs varakozo fajl, megis van auth-hiba a naploban.
      { account: 'nyalomapuncidma', lastRunAt: napokkalEzelott(0), lastResult: 'rendben', lastPending: 0 },
      { account: 'lackor2', lastRunAt: napokkalEzelott(0), lastPending: 1125 },
    ]), kartya, true, [akadas('auth', 'nyalomapuncidma', 6)])
    // A mert 6 hibas fajl -- nem a 0 varakozo, es nem a masik fiok 1125-e.
    expect(r.find((x) => x.id === 'drive_sync_auth_stuck')?.params).toMatchObject({ f: 6, account: 'nyalomapuncidma' })
    expect(r.find((x) => x.id === 'drive_sync_incomplete')?.params).toMatchObject({ n: 1, f: 1125 })
    // Nulla mert hiba eseten egyaltalan nincs sor (a nulla nem riasztas).
    const nulla = driveSyncRows(MOST, rendben([
      { account: 'nyalomapuncidma', lastRunAt: napokkalEzelott(0), lastResult: 'rendben', lastPending: 0 },
    ]), kartya, true, [akadas('auth', 'nyalomapuncidma', 0)])
    expect(nulla.some((x) => x.id === 'drive_sync_auth_stuck')).toBe(false)
  })

  it('utolsoFutasAuthHibas: csak a LEGUTOBBI futas auth-hibaja szamit', async () => {
    const mod = await import('../web/system-health.js')
    // Nincs futas -> nincs beragadas (friss telepites csendje).
    expect(mod.utolsoFutasAuthHibas([])).toBeNull()
  })
})

describe('a varakozo szamot a paros sajat mezojebol vesszuk', () => {
  it('a hianyzo, nulla es romlott ertek egyarant "nincs varakozo"', () => {
    expect(varakozoFajlok({})).toBe(0)
    expect(varakozoFajlok({ lastPending: 0 })).toBe(0)
    expect(varakozoFajlok({ lastPending: -5 })).toBe(0)
    expect(varakozoFajlok({ lastPending: Number.NaN })).toBe(0)
    expect(varakozoFajlok({ lastPending: 'sok' as any })).toBe(0)
  })

  it('a valodi szamot megtartja (torttol is egesz szam lesz)', () => {
    expect(varakozoFajlok({ lastPending: 9356 })).toBe(9356)
    expect(varakozoFajlok({ lastPending: 12.7 })).toBe(12)
  })

  it('a REGI, mezo nelkuli mentesek nem gyartanak hamis sargat', () => {
    // Frissiteskor a mar meglevo parosokban nincs `lastPending`. Ha ilyenkor
    // "ismeretlen = valoszinuleg var meg" logikat hasznalnank, mindenki
    // kapna egy sarga sort, amire nincs teendo -- es a sor elvesztene a sulyat.
    const r = driveSyncRows(MOST, rendben([
      { account: 'a', lastRunAt: napokkalEzelott(0), lastResult: 'rendben' },
    ]), kartya, true)
    expect(r.some((x) => x.id === 'drive_sync_incomplete')).toBe(false)
  })
})
