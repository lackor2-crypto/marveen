import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { driveSyncRows, reszlegesEredmeny, csonkaOsztaly, csonkaIndok, kvotaParamok, DRIVE_SYNC_STALE_DAYS } from '../web/system-health.js'
import { MAX_FOLDERS, MAX_FILES } from '../drive-sync-limits.js'

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

/**
 * Egy akadas a legutobbi futasbol (a hibanaplobol szarmaztatva). A `files` a
 * MERT hibaszam, nem a globalis varakozo-szam.
 */
const akadas = (kind: 'quota' | 'abusive' | 'auth' | 'other', account: string, files: number, at = napokkalEzelott(0), extra: Partial<{ names: string; message: string }> = {}) =>
  ({ kind, account, files, names: extra.names || '', message: extra.message || '', at })

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
      driveSyncRows(MOST, rendben([{ account: 'usalackor', lastRunAt: napokkalEzelott(0), lastResult: 'kész', lastPending: 200 }]), kartya(true), true, []),
      driveSyncRows(MOST, rendben([{ account: 'canadalackor', name: 'A teljes raktár', backup: true, lastRunAt: napokkalEzelott(1), lastResult: 'vészfék: 1531 fájl hiányzik a gépedről, ezért fent semmit nem töröltem', lastPending: 518 }]), kartya(true), true, []),
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

  it('a tukor-mentes vészféke sajat, oszinte sort kap es MEGNEVEZI a parost', () => {
    const parok = rendben([
      {
        account: 'canadalackor', name: 'A teljes raktár', backup: true,
        lastRunAt: napokkalEzelott(1),
        lastResult: 'vészfék: 1531 fájl hiányzik a gépedről, ezért fent semmit nem töröltem',
        lastPending: 518,
      },
    ])
    const r = driveSyncRows(MOST, parok, kartya(true), true, [])
    const sor = r.find((x) => x.id === 'drive_sync_backup_brake')
    expect(sor).toBeTruthy()
    expect(sor?.status).toBe('warn')
    // A drive/paros neve BENNE van (Boss: "melyik drive? hiszen van 10!").
    expect(sor?.params).toMatchObject({ account: 'canadalackor', name: 'A teljes raktár', missing: 1531 })
    // Egy vészfékes parosra NEM keletkezik megteveszto "magatol folytatja"
    // (incomplete) sor: az ket ellentetes uzenetet adna.
    expect(r.find((x) => x.id === 'drive_sync_incomplete')).toBeFalsy()
  })

  it('a vészfék sor akkor is megjelenik, ha a darabszam nem olvashato ki (allapot > szam)', () => {
    const parok = rendben([
      { account: 'x', name: 'tukor', backup: true, lastRunAt: napokkalEzelott(1), lastResult: 'vészfék: fájlok hiányoznak', lastPending: 9 },
    ])
    const r = driveSyncRows(MOST, parok, kartya(true), true, [])
    const sor = r.find((x) => x.id === 'drive_sync_backup_brake')
    expect(sor).toBeTruthy()
    expect(sor?.params).toMatchObject({ missing: 0 })
  })

  it('a vészfék a SIMA parost is fekezi -- nem esik a hazug incomplete sorba', () => {
    const parok = rendben([
      { account: 'sima', lastRunAt: napokkalEzelott(0), lastResult: 'vészfék: 5 fájl hiányzik', lastPending: 42 },
    ])
    const r = driveSyncRows(MOST, parok, kartya(true), true, [])
    const sor = r.find((x) => x.id === 'drive_sync_backup_brake')
    expect(sor).toBeTruthy()
    // nev nelkul a fiok neve all a helyen, ne ures idezojel
    expect(sor?.params).toMatchObject({ account: 'sima', name: 'sima', missing: 5 })
    expect(r.find((x) => x.id === 'drive_sync_incomplete')).toBeFalsy()
  })

  it('a vészfék-szoveg nem igér nem letezo feloldo kapcsolot', () => {
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const t = readFileSync(join(process.cwd(), f), 'utf-8')
      const sor = t.split('\n').find((l) => l.includes("'health.drive_sync_backup_brake_action'")) || ''
      expect(sor).not.toMatch(/engedélyezd a törlést|allow deletions/)
    }
    expect(readFileSync(join(process.cwd(), 'web/lang/hu.js'), 'utf-8')).toContain('KAPCSOLD KI')
  })

  it('az incomplete sor MEGNEVEZI, melyik fioknal var fajl', () => {
    const parok = rendben([
      { account: 'usalackor', lastRunAt: napokkalEzelott(0), lastResult: 'kész', lastPending: 200 },
    ])
    const r = driveSyncRows(MOST, parok, kartya(true), true, [])
    const sor = r.find((x) => x.id === 'drive_sync_incomplete')
    expect(sor?.params).toMatchObject({ names: 'usalackor' })
  })

  it('a felulet a vészfék sort a Raktarra, az auth-sort a Fiokokra vezeti', () => {
    const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf-8')
    expect(app).toContain("h.id === 'drive_sync_backup_brake'")
    expect(app).toContain("switchPage('drive')")
    expect(app).toContain("h.id === 'drive_sync_auth_stuck'")
    expect(app).toContain("switchPage('accounts')")
  })

  // MEGTELT DRIVE (403 storage quota) -- NEM bejelentkezesi hiba (Boss, 2026-09-21:
  // canadalackor megtelt, 321 fajl 403 "storage quota exceeded", kozben a fiok
  // elesben belepett; a felulet tevesen ujralogint tanacsolt).
  it('a megtelt Drive (quota 403) SAJAT sort kap, NEM az auth "jelentkezz be ujra" sort', () => {
    const parok = rendben([
      { account: 'canadalackor', name: 'A teljes raktár', backup: true, lastRunAt: napokkalEzelott(0), lastResult: '321 fájl nem ment fel', lastPending: 474 },
    ])
    const r = driveSyncRows(MOST, parok, kartya(true), true, [akadas('quota', 'canadalackor', 321)])
    const sor = r.find((x) => x.id === 'drive_sync_quota_full')
    expect(sor?.status).toBe('bad')
    // A szam a MERT hibakbol jon (321 elutasitott fajl a legutobbi futasban),
    // nem a globalis varakozo-szambol (474): az utobbi mast jelent, es pont ez
    // tette ertelmezhetetlenne a sort (Boss, 2026-09-22).
    expect(sor?.params).toMatchObject({ account: 'canadalackor', f: 321 })
    // NEM az auth-sor (az ujralogin nem segit) es NEM a megnyugtato incomplete.
    expect(r.find((x) => x.id === 'drive_sync_auth_stuck')).toBeFalsy()
    expect(r.find((x) => x.id === 'drive_sync_incomplete')).toBeFalsy()
  })

  it('ugyanarra a fiokra a quota ELVISZI az autot: nem lesz ket ellentetes sor', () => {
    const parok = rendben([
      { account: 'canadalackor', lastRunAt: napokkalEzelott(0), lastResult: 'hiba', lastPending: 100 },
    ])
    const r = driveSyncRows(MOST, parok, kartya(true), true,
      [akadas('auth', 'canadalackor', 5), akadas('quota', 'canadalackor', 100)])
    expect(r.find((x) => x.id === 'drive_sync_quota_full')).toBeTruthy()
    expect(r.find((x) => x.id === 'drive_sync_auth_stuck')).toBeFalsy()
  })

  it('egy MASIK egeszseges fiok varakozoi kulon incomplete sorba mennek, nem a megtelt melle', () => {
    const parok = rendben([
      { account: 'canadalackor', lastRunAt: napokkalEzelott(0), lastResult: 'hiba', lastPending: 474 },
      { account: 'usalackor', lastRunAt: napokkalEzelott(0), lastResult: 'kész', lastPending: 30 },
    ])
    const r = driveSyncRows(MOST, parok, kartya(true), true, [akadas('quota', 'canadalackor', 474)])
    expect(r.find((x) => x.id === 'drive_sync_quota_full')?.params).toMatchObject({ account: 'canadalackor', f: 474 })
    expect(r.find((x) => x.id === 'drive_sync_incomplete')?.params).toMatchObject({ names: 'usalackor', f: 30 })
  })

  it('elavult quota-jel (regebbi mint a legutobbi futas - 1 nap) NEM ragaszt quota sort', () => {
    const parok = rendben([
      { account: 'canadalackor', lastRunAt: napokkalEzelott(0), lastResult: 'kész', lastPending: 474 },
    ])
    const r = driveSyncRows(MOST, parok, kartya(true), true, [akadas('quota', 'canadalackor', 474, napokkalEzelott(5))])
    expect(r.find((x) => x.id === 'drive_sync_quota_full')).toBeFalsy()
    expect(r.find((x) => x.id === 'drive_sync_incomplete')).toBeTruthy()
  })

  it('a felulet a megtelt-Drive sort a Raktarra vezeti (nem a Fiokokra)', () => {
    const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf-8')
    expect(app).toContain("h.id === 'drive_sync_quota_full'")
    const idx = app.indexOf("h.id === 'drive_sync_quota_full'")
    expect(app.slice(idx, idx + 120)).toContain("switchPage('drive')")
  })

  it('a megtelt-Drive sornak van magyar ES angol felirata + teendo', () => {
    for (const nyelv of ['hu', 'en']) {
      const forras = readFileSync(join(process.cwd(), 'web/lang', nyelv + '.js'), 'utf-8')
      expect(forras).toContain("'health.drive_sync_quota_full'")
      expect(forras).toContain("'health.drive_sync_quota_full_action'")
    }
  })
})

/**
 * A JELZES NE TALALJON KI OKOT (kanban 284044a2).
 *
 * Boss, 2026-09-23: "nezd at ezeket a hibakat. jelzeseket. ezek nem veletlenul
 * vanak. valami hiba van. [...] es mellesleg van hely rajtuk. mi az hogy nincs
 * hely? hiba van az tuti."
 *
 * Harom MERT hiba volt a kepernyon:
 *  1. a csonka mentes sora EGYETLEN okot allitott (bejarasi plafon), holott a
 *     paros sajat mert indoka "nem tudtam kiolvasni" volt (7 mappa `fetch
 *     failed`, nyalomapuncidma, runId mudebqo6-jhcg2z);
 *  2. ugyanez a szoveg a REGI hatarszamokat irta ki (500 / 5000), mikozben a
 *     kod mar 5000-nel es 50 000-nel jart;
 *  3. a "megtelt" sor ugyanabban a mondatban allitotta, hogy megtelt ES hogy
 *     359 MB szabad, es egy 0 bajtos Kuka uriteset tanacsolta.
 */
describe('a Drive-jelzes a MERT okot mondja, nem talal ki egyet', () => {
  it('a csonka ok osztalyozasa a szinkron sajat harom mondatat koveti', () => {
    expect(csonkaOsztaly('részleges: elértük a(z) 5000 mappás felső határt – a többi kimaradt')).toBe('plafon')
    expect(csonkaOsztaly('részleges: elértük a(z) 50000 fájlos felső határt – a többi kimaradt')).toBe('plafon')
    expect(csonkaOsztaly('részleges: egy vagy több mappát nem tudtam kiolvasni a Drive-ról – a többi kimaradt')).toBe('olvashatatlan')
    // Vegyes: KET teendo tartozna hozza, tehat egyiket sem allitjuk a masik helyett.
    expect(csonkaOsztaly('részleges: elértük a(z) 5000 mappás felső határt; egy vagy több mappát nem tudtam kiolvasni a Drive-ról')).toBe('ismeretlen')
    expect(csonkaOsztaly('részleges: valami egészen más')).toBe('ismeretlen')
    expect(csonkaOsztaly(undefined)).toBe('ismeretlen')
  })

  it('az idezheto indok a "részleges:" prefix nelkul jon, es nem talal ki szoveget', () => {
    expect(csonkaIndok('részleges: egy vagy több mappát nem tudtam kiolvasni a Drive-ról – a többi kimaradt'))
      .toBe('egy vagy több mappát nem tudtam kiolvasni a Drive-ról – a többi kimaradt')
    expect(csonkaIndok('kész')).toBe('')
    expect(csonkaIndok(undefined)).toBe('')
  })

  // A MERT ESET: a nyalomapuncidma paros eredmeny-sora szo szerint ez volt.
  it('ki nem olvashato mappanal NEM a plafon-sor jon, es a plafon-teendo nem jelenik meg', () => {
    const parok = [
      { account: 'nyalomapuncidma', lastRunAt: napokkalEzelott(0), lastResult: 'részleges: egy vagy több mappát nem tudtam kiolvasni a Drive-ról – a többi kimaradt' },
    ]
    const r = driveSyncRows(MOST, rendben(parok), kartya(true), true)
    expect(r.find((x) => x.id === 'drive_sync_partial')).toBeFalsy()
    const sor = r.find((x) => x.id === 'drive_sync_partial_unread')
    expect(sor?.status).toBe('bad')
    expect(sor?.params).toMatchObject({ n: 1, all: 1, names: 'nyalomapuncidma' })
    expect(String(sor?.params?.indok)).toContain('nem tudtam kiolvasni')
  })

  it('a plafon-sor a KODBOL veszi a hatarszamokat, nem a szovegbe egetve', () => {
    const parok = [
      { account: 'lackor2', lastRunAt: napokkalEzelott(0), lastResult: `részleges: elértük a(z) ${MAX_FOLDERS} mappás felső határt – a többi kimaradt` },
    ]
    const sor = driveSyncRows(MOST, rendben(parok), kartya(true), true).find((x) => x.id === 'drive_sync_partial')
    expect(sor?.params).toMatchObject({ maxF: MAX_FOLDERS, maxFiles: MAX_FILES })
    // A regi, elavult szamok nem allhatnak a felulet szovegeben.
    for (const nyelv of ['hu', 'en']) {
      const forras = readFileSync(join(process.cwd(), 'web/lang', nyelv + '.js'), 'utf-8')
      const sorok = forras.split('\n').filter((l) => l.includes('drive_sync_partial'))
      expect(sorok.length).toBeGreaterThan(0)
      expect(sorok.join('\n')).not.toContain('500 mappa')
      expect(sorok.join('\n')).not.toContain('500 folders')
    }
  })

  it('vegyes/ismeretlen indoknal a sor IDEZ, es nem valaszt okot helyettunk', () => {
    const parok = [
      { account: 'lackor2', lastRunAt: napokkalEzelott(0), lastResult: 'részleges: elértük a(z) 5000 mappás felső határt; egy vagy több mappát nem tudtam kiolvasni a Drive-ról' },
    ]
    const sor = driveSyncRows(MOST, rendben(parok), kartya(true), true).find((x) => x.id === 'drive_sync_partial_unknown')
    expect(sor?.status).toBe('bad')
    expect(String(sor?.params?.indok)).toContain('felső határt')
    expect(String(sor?.params?.indok)).toContain('nem tudtam kiolvasni')
  })

  it('kulonbozo okok KULON sorba mennek, nem egy sorba osszemosva', () => {
    const parok = [
      { account: 'lackor2', lastRunAt: napokkalEzelott(0), lastResult: 'részleges: elértük a(z) 5000 mappás felső határt' },
      { account: 'nyalomapuncidma', lastRunAt: napokkalEzelott(0), lastResult: 'részleges: egy vagy több mappát nem tudtam kiolvasni a Drive-ról' },
    ]
    const r = driveSyncRows(MOST, rendben(parok), kartya(true), true)
    expect(r.find((x) => x.id === 'drive_sync_partial')?.params).toMatchObject({ names: 'lackor2', n: 1 })
    expect(r.find((x) => x.id === 'drive_sync_partial_unread')?.params).toMatchObject({ names: 'nyalomapuncidma', n: 1 })
  })

  it('mindharom csonka-sornak van magyar ES angol felirata + teendo', () => {
    for (const nyelv of ['hu', 'en']) {
      const forras = readFileSync(join(process.cwd(), 'web/lang', nyelv + '.js'), 'utf-8')
      for (const id of ['drive_sync_partial', 'drive_sync_partial_unread', 'drive_sync_partial_unknown']) {
        expect(forras).toContain("'health." + id + "'")
        expect(forras).toContain("'health." + id + "_action'")
      }
    }
  })

  // ---- A MEGTELT-SOR ELLENTMONDASA ----
  it('a kvota-parameterek kozott ott a meres IDOPONTJA is', () => {
    const p = kvotaParamok('canadalackor', {
      canadalackor: { limit: 16106127360, usage: 15730067146, trash: 0, at: '2026-09-23T01:30:44.512Z', account: 'canadalackor' },
    } as any)
    expect(p).toMatchObject({ limitB: 16106127360, trashB: 0, freeB: 376060214, meresAt: '2026-09-23T01:30:44.512Z' })
    expect(p.usedB).toBe(15730067146)
  })

  it('meres nelkul NEM keletkezik kitalalt szam', () => {
    expect(kvotaParamok('canadalackor', {} as any)).toEqual({})
  })

  it('a megtelt-sor viszi magaval az ELUTASITAS idejet is (a ket idopont kulon van)', () => {
    const parok = rendben([
      { account: 'canadalackor', lastRunAt: napokkalEzelott(0), lastResult: 'hiba', lastPending: 92 },
    ])
    const r = driveSyncRows(MOST, parok, kartya(true), true,
      [akadas('quota', 'canadalackor', 92, '2026-08-27T01:44:40.363Z')],
      { canadalackor: { limit: 16106127360, usage: 15730067146, trash: 0, at: '2026-08-27T01:30:44.512Z' } } as any)
    const sor = r.find((x) => x.id === 'drive_sync_quota_full')
    expect(sor?.params).toMatchObject({
      account: 'canadalackor', f: 92, trashB: 0, freeB: 376060214,
      meresAt: '2026-08-27T01:30:44.512Z', hibaAt: '2026-08-27T01:44:40.363Z',
    })
  })

  it('a felulet a Kuka-teendot a MERT Kuka-merettol teszi fuggove (0 bajtnal nem azzal kezd)', () => {
    const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf-8')
    expect(app).toContain("drive.quota_teendo_kuka")
    expect(app).toContain("drive.quota_teendo_nincs_kuka")
    expect(app).toContain("Number(p.trashB) > 0")
    // A megtelt-sor teendo-szovege a Kukat mar nem allitja fixen: a
    // `{teendo}` helyorzon keresztul jon, es a 0 bajtos Kukat kimondja.
    const hu = readFileSync(join(process.cwd(), 'web/lang/hu.js'), 'utf-8')
    const teendoSor = hu.split('\n').find((l) => l.includes("'health.drive_sync_quota_full_action'")) || ''
    expect(teendoSor).toContain('{teendo}')
    expect(teendoSor).not.toContain('ÜRÍTSD A KUKÁT')
  })

  it('ha maradt szabad hely, a sor KIMONDJA az ellentmondast, nem hallgatja el', () => {
    const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf-8')
    expect(app).toContain("Number(p.freeB) > 0")
    expect(app).toContain("drive.quota_ellentmondas")
    for (const nyelv of ['hu', 'en']) {
      const forras = readFileSync(join(process.cwd(), 'web/lang', nyelv + '.js'), 'utf-8')
      expect(forras).toContain("'drive.quota_ellentmondas'")
      expect(forras).toContain("'drive.quota_ellentmondas_ido'")
      expect(forras).toContain("'drive.quota_meres_mikor'")
      expect(forras).toContain("'drive.quota_teendo_nincs_meres'")
    }
  })

  it('a ket bejarasi hatar EGY helyrol jon (a szinkron es az onellenorzes ugyanazt mondja)', () => {
    const forras = readFileSync(join(process.cwd(), 'src/web/routes/drive-sync.ts'), 'utf-8')
    expect(forras).toContain("from '../../drive-sync-limits.js'")
    // Nem all vissza ket kulon definicio.
    expect(forras).not.toMatch(/^const MAX_FOLDERS = /m)
    expect(forras).not.toMatch(/^const MAX_FILES = /m)
  })
})
