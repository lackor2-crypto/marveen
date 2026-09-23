/**
 * A 403 NEM EGY DOLOG -- es a felulet nem tanacsolhat ra hamis teendot.
 *
 * Boss, 2026-09-22 (Telegram 1138): "nezd at ezeket a hibakat. jelzeseket. ezek
 * nem veletlenul vanak. valami hiba van. drive nal nem kellfrissiteni a
 * fiokokat. ha jol tudom. fotoknal kell. nem? es mellesleg van hely rajtuk."
 *
 * Igaza volt. A kepernyon ez allt: "A mentes hitelesitesi hibaba utkozik: 0
 * fajl beragadt, mert a Google-fiok (nyalomapuncidma) nem tud belepni." ELO
 * MERES ugyanabban a percben:
 *   - a fiok Drive-ja 4,82 GB / 15 GB, es a fiok ELESBEN listazta a Drive-jat,
 *   - a hat hibas fajl valodi hibaja: "This file has been identified as malware
 *     or spam and cannot be downloaded" (`cannotDownloadAbusiveFile`).
 * Vagyis a fiok belep, az ujralogin semmit nem old meg, es a sor ket dolgot is
 * hazudott: az okot es a darabszamot (nulla).
 *
 * Ket gyokerok volt:
 *   1. a csupasz `\b403\b` mintat auth-hibanak vettuk (ugyanaz a hibaosztaly,
 *      mint a megtelt Drive-nal, #2a268b42),
 *   2. a letoltes CSAK a szamkodot naplozta ("Drive 403"), a Google sajat
 *      mondatat eldobta -- igy az igazi ok nem is derulhetett ki.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { driveErrorKind, driveHibaUzenet, driveVeglegesenElutasitva } from '../drive-error-kind.js'
import { driveSyncRows, utolsoFutasAkadasai, utolsoFutasAuthHibas, kvotaParamok } from '../web/system-health.js'
import { parseStorageQuota } from '../drive-quota.js'

// A ket VALODI valasz, ahogy a Google ma adta (rovidítve, ahogy a naplo tarolja).
const ABUZIV = 'Drive 403: {\n  "error": {\n    "code": 403,\n    "message": "This file has been identified as malware or spam and cannot be downloaded.",\n    "errors": [\n      {\n        "reason": "cannotDownloadAbusiveFile"'
const KVOTA = 'Drive 403: {\n  "error": {\n    "code": 403,\n    "message": "The user\'s Drive storage quota has been exceeded.",\n    "errors": [\n      {'

const MOST = Date.parse('2026-09-22T18:00:00Z')
const napokkalEzelott = (n: number) => new Date(MOST - n * 86_400_000).toISOString()
const kartya = { letezik: true, bekapcsolva: true }
const rendben = (parok: Array<Record<string, unknown>>) => ({ fajta: 'rendben' as const, parok })

describe('a Google 403-at az INDOKLASA sorolja be, nem a szamkod', () => {
  it('a kartekonynak jelolt fajl NEM hitelesitesi hiba', () => {
    expect(driveErrorKind(ABUZIV)).toBe('abusive')
  })

  it('a megtelt tarhely NEM hitelesitesi hiba', () => {
    expect(driveErrorKind(KVOTA)).toBe('quota')
  })

  it('a valodi jogosultsag-hiba viszont az', () => {
    expect(driveErrorKind('Drive 401: {"error":{"message":"Invalid Credentials"}}')).toBe('auth')
    expect(driveErrorKind('Drive 403: {"error":{"errors":[{"reason":"insufficientPermissions"}]}}')).toBe('auth')
    expect(driveErrorKind('invalid_grant: Token has been expired or revoked.')).toBe('auth')
  })

  it('az INDOKLAS NELKULI 403 nem lesz auth -- inkabb "nem tudjuk", mint hamis teendo', () => {
    // Ez a regi naplosorok alakja (a letoltes eldobta a torzset). Ha ezt
    // auth-nak vennenk, ujra ugyanaz a hazugsag allna a kepernyon.
    expect(driveErrorKind('Drive 403')).toBe('other')
  })

  it('a Google sajat mondata kiolvashato a CSONKOLT torzsbol is', () => {
    expect(driveHibaUzenet(ABUZIV)).toBe('This file has been identified as malware or spam and cannot be downloaded.')
    expect(driveHibaUzenet(KVOTA)).toBe("The user's Drive storage quota has been exceeded.")
    // Amit nem tudunk, azt nem találjuk ki.
    expect(driveHibaUzenet('Drive 403')).toBe('')
  })
})

describe('a legutobbi futas akadasai okonkent es fiokonkent allnak ossze', () => {
  const runs = [{ runId: 'r1', at: napokkalEzelott(0), count: 9 }]
  const hibak = [
    { account: 'nyalomapuncidma', phase: 'letöltés', reason: ABUZIV, driveName: 'AutoGraf_en.zip' },
    { account: 'nyalomapuncidma', phase: 'letöltés', reason: ABUZIV, driveName: 'trade manager.rar' },
    { account: 'canadalackor', phase: 'feltöltés', reason: KVOTA, driveName: 'A-Csodak-konyve.pdf' },
    // SZANDEKOS kihagyas: nem akadas, nem is kap sort.
    { account: 'nyalomapuncidma', phase: 'kihagyva', reason: 'két Drive-fájl esne ugyanarra a névre', driveName: 'mqlcache.dat' },
    // Halozati gond HTTP-kod nelkul: nem a Google utasitotta el.
    { account: 'lackor2', phase: 'letöltés', reason: 'fetch failed: ETIMEDOUT', driveName: 'x.bin' },
  ]

  it('kulon sorba kerul a kartekony es a megtelt, a kihagyas es a halozati gond nem', () => {
    const a = utolsoFutasAkadasai(runs, () => hibak as any)
    expect(a.map((x) => `${x.kind}|${x.account}|${x.files}`).sort())
      .toEqual(['abusive|nyalomapuncidma|2', 'quota|canadalackor|1'])
    expect(a.find((x) => x.kind === 'abusive')?.names).toContain('AutoGraf_en.zip')
  })

  it('a hat kartekony fajlbol NEM lesz "a fiok nem tud belepni"', () => {
    expect(utolsoFutasAuthHibas(runs.map((r) => r))).toBeDefined()   // a fuggveny letezik
    const a = utolsoFutasAkadasai(runs, () => hibak as any)
    expect(a.some((x) => x.kind === 'auth')).toBe(false)
  })

  it('futas nelkul (friss telepites) ures -- ez helyes csend, nem "rendben"', () => {
    expect(utolsoFutasAkadasai([], () => hibak as any)).toEqual([])
  })
})

describe('veglegesen elutasitva-e (mehet-e a kihagyando-listara)', () => {
  // Boss, 2026-09-23: "Minden Google-elutasitas egyformán, kevesebb sárga."
  it('a kartekonynak jelolt fajl VEGLEGES', () => {
    expect(driveVeglegesenElutasitva(ABUZIV)).toBe(true)
  })

  it('egy ismeretlen indoku 4xx is VEGLEGES: holnap is ugyanaz lenne a valasz', () => {
    expect(driveVeglegesenElutasitva('Drive 404: {"error":{"message":"File not found"}}')).toBe(true)
    expect(driveVeglegesenElutasitva('Drive 400: {"error":{"message":"The file is in an unsupported state."}}')).toBe(true)
  })

  // EZ A LENYEG: egy 503 a Google sajat uzemzavara, nem elutasitas. Ha ezt
  // veglegesnek vennenk, egy tokeletesen jo fajl tunne el a szinkronbol
  // CSENDBEN, orokre -- pont az a nema kar, amit a NULLA-elv tilt.
  it('az atmeneti uzemzavar (5xx) NEM vegleges: a kovetkezo futas ujraprobalja', () => {
    expect(driveVeglegesenElutasitva('Drive 503: backend error')).toBe(false)
    expect(driveVeglegesenElutasitva('Drive 500: internal error')).toBe(false)
  })

  it('a halozati gond sem vegleges', () => {
    expect(driveVeglegesenElutasitva('connection timed out')).toBe(false)
    expect(driveVeglegesenElutasitva('')).toBe(false)
  })

  // A kvota es az auth NEM egy fajlrol szol, hanem a fiokrol, es van ertelmes
  // teendoje -- azokat nem nemitjuk el egy fajl-lista mogott.
  it('a megtelt tarhely es a hitelesitesi hiba NEM kerul a listara', () => {
    expect(driveVeglegesenElutasitva(KVOTA)).toBe(false)
    expect(driveVeglegesenElutasitva('Drive 401: invalid credentials')).toBe(false)
  })
})

describe('az onellenorzes sorai', () => {
  const parok = rendben([
    { account: 'nyalomapuncidma', lastRunAt: napokkalEzelott(0), lastResult: 'rendben', lastPending: 0 },
  ])
  const abuziv = { kind: 'abusive' as const, account: 'nyalomapuncidma', files: 6, names: 'AutoGraf_en.zip', message: 'malware', at: napokkalEzelott(0) }

  // Boss, 2026-09-23: "ne irja ki azt az onellenorzesnel, hogy ez egy problema.
  // Nincs itt semmi problema, azt nem engedi a Google letolteni". A kartekony
  // fajl kikerult az onellenorzesbol: a Raktar oldal sajat doboza mutatja.
  it('a kartekony fajl EGYALTALAN NEM kap sort -- se abuziv, se auth', () => {
    const r = driveSyncRows(MOST, parok, kartya, true, [abuziv])
    expect(r.some((x) => x.id === 'drive_sync_abusive')).toBe(false)
    expect(r.some((x) => x.id === 'drive_sync_auth_stuck')).toBe(false)
  })

  it('a kartekony fajl NEM nemitja el a zold sort: a mentes tobbi resze rendben van', () => {
    const r = driveSyncRows(MOST, parok, kartya, true, [abuziv])
    expect(r.some((x) => x.id === 'drive_sync_ok')).toBe(true)
  })

  // Boss, 2026-09-23: "Ez is keruljon ki az onellenorzesbol, a Raktar-listaba
  // -- mint a kartekony fajlok. Minden Google-elutasitas egyformán, kevesebb
  // sárga."
  it('a besorolatlan elutasitas SEM kap sort -- az is a Raktar-listaba megy', () => {
    const r = driveSyncRows(MOST, parok, kartya, true, [
      { kind: 'other' as const, account: 'lackor2', files: 2, names: 'a.txt', message: 'The file is in an unsupported state.', at: napokkalEzelott(0) },
    ])
    expect(r.some((x) => x.id === 'drive_sync_refused')).toBe(false)
    expect(r.some((x) => x.id === 'drive_sync_auth_stuck')).toBe(false)
  })

  it('a besorolatlan elutasitas NEM nemitja el a zold sort', () => {
    const r = driveSyncRows(MOST, parok, kartya, true, [
      { kind: 'other' as const, account: 'lackor2', files: 2, names: 'a.txt', message: 'The file is in an unsupported state.', at: napokkalEzelott(0) },
    ])
    expect(r.some((x) => x.id === 'drive_sync_ok')).toBe(true)
  })

  // A KVOTA es az AUTH sor MEGMARAD: azok nem egy fajlrol szolnak, hanem az
  // egesz fiokrol, es van ertelmes teendojuk. Ez a hatar a szabaly lenyege --
  // nem "minden sarga tunjon el", hanem "amin a felhasznalo nem tud segiteni".
  it('a valodi hitelesitesi hiba TOVABBRA is kap sort', () => {
    const r = driveSyncRows(MOST, parok, kartya, true, [
      { kind: 'auth' as const, account: 'lackor2', files: 3, names: '', message: '', at: napokkalEzelott(0) },
    ])
    expect(r.find((x) => x.id === 'drive_sync_auth_stuck')?.status).toBe('bad')
  })

  it('a megtelt Drive sora a MERT szamokat viszi, ha van meres', () => {
    const quotas = { canadalackor: { limit: 16106127360, usage: 16106127307, trash: 898069337 } }
    const r = driveSyncRows(MOST, rendben([
      { account: 'canadalackor', lastRunAt: napokkalEzelott(0), lastPending: 474 },
    ]), kartya, true, [{ kind: 'quota' as const, account: 'canadalackor', files: 329, names: '', message: '', at: napokkalEzelott(0) }], quotas)
    expect(r.find((x) => x.id === 'drive_sync_quota_full')?.params).toMatchObject({
      f: 329, account: 'canadalackor', limitB: 16106127360, usedB: 16106127307, trashB: 898069337, freeB: 53,
    })
  })

  // ONKORREKCIO. Boss kepernyofotoja (2026-09-23 13:22): a Google sajat
  // felulete 13,1 GB / 15 GB-ot mutatott, a Marveen tarolt merese viszont
  // 03:30-as volt (14,65 GB). A sor azert ragadt be, mert a meres CSAK a hiba
  // pillanataban frissult -- hiba nelkul sosem.
  it('ha az elutasitas OTA mertunk es van szabad hely, a sor ELTUNIK', () => {
    const quotas = {
      canadalackor: {
        limit: 16106127360, usage: 14066127360, trash: 0,
        at: new Date(MOST).toISOString(),                 // a meres MOST kesz
      },
    }
    const r = driveSyncRows(MOST, rendben([
      { account: 'canadalackor', lastRunAt: napokkalEzelott(0), lastPending: 0 },
    ]), kartya, true, [{
      kind: 'quota' as const, account: 'canadalackor', files: 92, names: '', message: '',
      at: new Date(MOST - 3_600_000).toISOString(),       // az elutasitas EGY ORAJA
    }], quotas)
    expect(r.some((x) => x.id === 'drive_sync_quota_full')).toBe(false)
  })

  it('de ha a meres REGEBBI az elutasitasnal, a sor MARAD -- nem latunk oda', () => {
    const quotas = {
      canadalackor: {
        limit: 16106127360, usage: 14066127360, trash: 0,
        at: new Date(MOST - 7_200_000).toISOString(),     // a meres KET ORAJA
      },
    }
    const r = driveSyncRows(MOST, rendben([
      { account: 'canadalackor', lastRunAt: napokkalEzelott(0), lastPending: 0 },
    ]), kartya, true, [{
      kind: 'quota' as const, account: 'canadalackor', files: 92, names: '', message: '',
      at: new Date(MOST - 3_600_000).toISOString(),       // az elutasitas EGY ORAJA -> UJABB
    }], quotas)
    expect(r.some((x) => x.id === 'drive_sync_quota_full')).toBe(true)
  })

  it('friss meres, de NULLA szabad hely: a sor MARAD -- tenyleg megtelt', () => {
    const quotas = {
      canadalackor: {
        limit: 16106127360, usage: 16106127360, trash: 0,
        at: new Date(MOST).toISOString(),
      },
    }
    const r = driveSyncRows(MOST, rendben([
      { account: 'canadalackor', lastRunAt: napokkalEzelott(0), lastPending: 0 },
    ]), kartya, true, [{
      kind: 'quota' as const, account: 'canadalackor', files: 92, names: '', message: '',
      at: new Date(MOST - 3_600_000).toISOString(),
    }], quotas)
    expect(r.some((x) => x.id === 'drive_sync_quota_full')).toBe(true)
  })

  it('meres NELKUL (friss telepites) nem talal ki szamot: a bajt-mezok egyszeruen nincsenek ott', () => {
    const r = driveSyncRows(MOST, rendben([
      { account: 'canadalackor', lastRunAt: napokkalEzelott(0), lastPending: 474 },
    ]), kartya, true, [{ kind: 'quota' as const, account: 'canadalackor', files: 329, names: '', message: '', at: napokkalEzelott(0) }], {})
    const p = r.find((x) => x.id === 'drive_sync_quota_full')?.params || {}
    expect('usedB' in p).toBe(false)
    expect(p).toMatchObject({ f: 329 })
  })

  it('kvotaParamok: meres nelkul ures, korlatlan tarhelynel is ures', () => {
    expect(kvotaParamok('x', {})).toEqual({})
    expect(kvotaParamok('x', { x: { limit: 0, usage: 5, trash: 0 } } as any)).toEqual({})
  })
})

describe('a tarhely-meres a Google sajat valaszabol jon', () => {
  it('a hianyzo mezokbol nem lesz kitalalt szam', () => {
    expect(parseStorageQuota('a', {})).toBeNull()
    const s = parseStorageQuota('a', { storageQuota: { limit: '16106127360', usage: '16106127307', usageInDriveTrash: '898069337' } })
    expect(s).toMatchObject({ account: 'a', limit: 16106127360, usage: 16106127307, trash: 898069337 })
    // Korlatlan tarhelynel a Google el sem kuldi a `limit`-et.
    expect(parseStorageQuota('a', { storageQuota: { usage: '5' } })).toMatchObject({ limit: 0, usage: 5 })
  })
})

describe('a naplo megorzi a Google indoklasat, a felulet pedig ket nyelven beszel', () => {
  const gyoker = process.cwd()

  it('a letoltes a valasz TORZSET is feljegyzi, nem csak a szamkodot', () => {
    const src = readFileSync(join(gyoker, 'src/web/routes/drive-sync.ts'), 'utf-8')
    const i = src.indexOf('async function downloadTo(')
    expect(i).toBeGreaterThan(0)
    const blokk = src.slice(i, i + 1600)
    expect(blokk).toContain('await res.text()')
    expect(blokk).toContain('Drive ${res.status}: ${szoveg}')
  })

  it('a kvota-hiba pillanataban megmerjuk a tarhelyet', () => {
    const src = readFileSync(join(gyoker, 'src/web/routes/drive-sync.ts'), 'utf-8')
    expect(src).toContain("driveErrorKind(indok) === 'quota'")
    expect(src).toContain('merdAKvotat')
  })

  // A hibanal merni KEVES: egy felszabaditas utan epp az a helyzet, hogy nincs
  // hiba, tehat a szam sosem frissulne. Merve 2026-09-23: a tarolt meres 10
  // oras volt, mikozben Boss mar 1,5 GB-ot felszabaditott.
  it('a tarhelyet a futas ELEJEN is megmerjuk, nem csak hibanal', () => {
    const src = readFileSync(join(gyoker, 'src/web/routes/drive-sync.ts'), 'utf-8')
    const i = src.indexOf('async function syncPair')
    expect(i).toBeGreaterThan(0)
    expect(src.slice(i, i + 3000)).toContain('await merdAKvotat(pair.account, token)')
  })

  it('kezzel is megmerheto a felulerol: van vegpont es van gomb', () => {
    const src = readFileSync(join(gyoker, 'src/web/routes/drive-sync.ts'), 'utf-8')
    expect(src).toContain("'/api/drive/quota/measure'")
    const app = readFileSync(join(gyoker, 'web/app.js'), 'utf-8')
    expect(app).toContain('/api/drive/quota/measure')
  })

  // "Innentol kezdve azt nem is probalja meg leszinkronizalni." (Boss)
  it('amit a Google szabalybol nem ad ki, azt felvesszuk a kihagyando-listara', () => {
    const src = readFileSync(join(gyoker, 'src/web/routes/drive-sync.ts'), 'utf-8')
    expect(src).toContain('driveVeglegesenElutasitva(indok)')
    expect(src).toContain('recordDriveSkip(')
    expect(src).toContain('isDriveSkipped(pair.account, f.id, kihagyando)')
  })

  it('minden uj sornak van magyar ES angol szovege', () => {
    const hu = readFileSync(join(gyoker, 'web/lang/hu.js'), 'utf-8')
    const en = readFileSync(join(gyoker, 'web/lang/en.js'), 'utf-8')
    for (const k of [
      'drive.quota_meres', 'drive.refused_no_msg',
      // A kartekony fajl mar NEM onellenorzo sor, hanem a Raktar sajat doboza.
      'drive.blocked_title', 'drive.blocked_intro', 'drive.blocked_empty',
      'drive.blocked_retry_all', 'drive.blocked_retry_one', 'drive.quota_measure_now',
    ]) {
      expect(hu).toContain(`'${k}':`)
      expect(en).toContain(`'${k}':`)
    }
  })

  it('a szovegtoredek NEM a `health.` nevterbe megy', () => {
    // A `health.<id>` kulcs egy SOR az onellenorzesen, es a selfcheck-guide-ui
    // teszt minden ilyenhez kovetel `_action` parjat. A beillesztendo darabnak
    // (meres-mondat, hianyzo indoklas) nincs es nem is lehet teendoje -- ezert
    // a `drive.` nevterben all. Ez a CI-n 2026-09-22-en meg is bukott egyszer.
    const hu = readFileSync(join(gyoker, 'web/lang/hu.js'), 'utf-8')
    expect(hu).not.toContain("'health.drive_quota_meres':")
    expect(hu).not.toContain("'health.drive_refused_no_msg':")
  })

  it('a bajtbol a felulet nyelven lesz emberi szam, es a sorok a Raktarra visznek', () => {
    const app = readFileSync(join(gyoker, 'web/app.js'), 'utf-8')
    expect(app).toContain('function bajtParamok')
    expect(app).toContain('function _emberiBajt')
    // A megtelt Drive sora MEGMARAD, es tovabbra is a Raktarra visz.
    const i = app.indexOf("h.id === 'drive_sync_quota_full'")
    expect(i).toBeGreaterThan(0)
    expect(app.slice(i, i + 120)).toContain("switchPage('drive')")
    // Amit a Google nem ad ki, annak MAR NINCS sora (Boss 2026-09-23), tehat
    // kattintasi aga sem lehet -- se a kartekonynak, se a besorolatlannak.
    expect(app).not.toContain("h.id === 'drive_sync_abusive'")
    expect(app).not.toContain("h.id === 'drive_sync_refused'")
  })
})
