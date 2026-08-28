import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { raktarMeres, raktarRows, driveSyncRows, type RaktarMeres } from '../web/system-health.js'

/**
 * A RAKTAR NEMA HIBAJA.
 *
 * A mero eset (2026-08-27): az Attekintes onellenorzese a raktar
 * elerhetoseget KIZAROLAG a Drive-mentesen keresztul vizsgalta, az a blokk
 * viszont ures listaval kilep, ha nincs bekotott Drive-mappa. Akinek tehat
 * raktara van, de Drive-ja nincs, annal a lemez leszakadasa NEM latszott
 * sehol -- pedig a raktar alatt all a Fotok, az Eletfa es az Intezo is, es a
 * leszakadas ezen a gepen MERT esemeny (2026-08-26, a WSL 9p csatornaja).
 *
 * Amit ezek a tesztek orizni akarnak, az nem egy szoveg, hanem egy
 * megkulonboztetes: a NULLA KET DOLGOT JELENTHET. A csendnek friss
 * telepitesen kell allnia, es CSAK ott.
 */

const ROOT = join(__dirname, '..', '..')
const takaritando: string[] = []
const ideiglenesMappa = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'raktar-teszt-'))
  takaritando.push(d)
  return d
}
afterAll(() => {
  for (const d of takaritando) {
    try { chmodSync(d, 0o700) } catch { /* lehet, hogy mar nincs meg */ }
    rmSync(d, { recursive: true, force: true })
  }
})

/** Egy kezzel osszerakott meres -- a dontesi logika fs nelkul is vizsgalhato. */
const meres = (x: Partial<RaktarMeres>): RaktarMeres => ({
  configured: true, root: '/mnt/f/Marveen',
  letezik: true, mappa: true, szuloLatszik: true, irhato: true, ...x,
})

describe('a raktar allapota megjelenik az Attekintesen', () => {
  it('friss telepitesen HALLGAT -- nincs beallitva raktar, nincs mirol szolni', () => {
    expect(raktarRows(raktarMeres(null))).toEqual([])
    expect(raktarMeres(null).configured).toBe(false)
  })

  it('a rendben levo raktar ZOLD sort kap, es kiirja az utvonalat', () => {
    // Zold sor nelkul a hallgatas nem lenne megkulonboztetheto attol, hogy az
    // ellenorzes el sem indult. Pontosan ez a csapda vitte el a Drive-mentest.
    const gyoker = ideiglenesMappa()
    const r = raktarRows(raktarMeres(gyoker))
    expect(r.map((x) => x.id)).toEqual(['depot_ok'])
    expect(r[0].status).toBe('ok')
    expect(r[0].params).toMatchObject({ p: gyoker })
  })

  it('az elerhetetlen raktar a leghangosabb sor -- Drive-mappa NELKUL is', () => {
    // EZ a javitott hiba. Nulla bekotott Drive-mappaval a Drive-blokk
    // (helyesen) hallgat; ha a raktar-sor nem lenne, senki nem szolna.
    const szulo = ideiglenesMappa()
    const gyoker = join(szulo, 'nincs-ilyen-lemez', 'Marveen')

    const driveSor = driveSyncRows(Date.now(), { fajta: 'rendben' as const, parok: [] }, { letezik: false, bekapcsolva: false }, false)
    expect(driveSor, 'a Drive-blokk nulla mappaval helyesen hallgat').toEqual([])

    const r = raktarRows(raktarMeres(gyoker))
    expect(r.map((x) => x.id)).toEqual(['depot_unreachable'])
    expect(r[0].status).toBe('bad')
    expect([...driveSor, ...r].length, 'egyutt sem szabad nemanak lennie').toBe(1)
  })

  it('a hianyzo MAPPA nem ugyanaz, mint a nem latott LEMEZ', () => {
    // Mas a kovetkezo lepes: az egyiket letre lehet hozni, a masiknal a
    // csatolassal van dolog. Ha a ketto egy sor lenne, a felhasznalo rossz
    // iranyba indulna.
    const szulo = ideiglenesMappa()
    const hianyzoMappa = raktarRows(raktarMeres(join(szulo, 'Marveen')))
    expect(hianyzoMappa.map((x) => x.id)).toEqual(['depot_missing_dir'])
    expect(hianyzoMappa[0].status).toBe('warn')

    const nemLatottLemez = raktarRows(meres({ letezik: false, mappa: false, szuloLatszik: false }))
    expect(nemLatottLemez.map((x) => x.id)).toEqual(['depot_unreachable'])
    expect(nemLatottLemez[0].status).toBe('bad')
  })

  it('MEGHAJTO-GYOKERNEL sosem mondjuk, hogy "csak a mappa hianyzik"', () => {
    // A `/mnt` mindig letezik, ezert a naiv szulo-vizsgalat azt allitana, hogy
    // a `/mnt/z` nyugodtan letrehozhato. Egy mkdir viszont ilyenkor egy
    // kozonseges linux-mappat csinal a WSL gyokeren, es a Marveen oda irna a
    // fajlokat -- nem a lemezre, hanem a semmibe.
    for (const gyoker of ['/mnt/z', '/mnt/z/']) {
      const m = raktarMeres(gyoker)
      expect(m.szuloLatszik, `${gyoker}: a csatolasi pont szuloje nem bizonyit semmit`).toBe(false)
      expect(raktarRows(m).map((x) => x.id)).toEqual(['depot_unreachable'])
    }
  })

  it('FAJL a mappa helyen sajat sort kap', () => {
    const szulo = ideiglenesMappa()
    const utvonal = join(szulo, 'Marveen')
    writeFileSync(utvonal, 'ez egy fajl')
    const r = raktarRows(raktarMeres(utvonal))
    expect(r.map((x) => x.id)).toEqual(['depot_not_dir'])
    expect(r[0].status).toBe('bad')
  })

  it('az IRHATATLAN raktar bad -- a felig megirt fajl rosszabb a hianyzonal', () => {
    const gyoker = ideiglenesMappa()
    mkdirSync(join(gyoker, 'Rendszer'), { recursive: true })
    chmodSync(gyoker, 0o500)
    const m = raktarMeres(gyoker)
    if (m.irhato) {
      // root-kent futo tesztfutonal a W_OK mindig atmegy: ilyenkor a dontesi
      // logikat magat vizsgaljuk, kulonben a teszt hamis zoldet adna.
      expect(raktarRows(meres({ irhato: false })).map((x) => x.id)).toEqual(['depot_readonly'])
      return
    }
    const r = raktarRows(m)
    expect(r.map((x) => x.id)).toEqual(['depot_readonly'])
    expect(r[0].status).toBe('bad')
  })
})

describe('a sor tenyleg kimegy a felhasznalonak', () => {
  const forras = readFileSync(join(ROOT, 'src', 'web', 'system-health.ts'), 'utf-8')

  it('a systemHealth() be is koti -- a fuggveny magaban nem er semmit', () => {
    expect(forras, 'a raktar-sor nincs bekotve a systemHealth()-be').toContain('...raktarRows(),')
    const raktar = forras.indexOf('...raktarRows(),')
    const drive = forras.indexOf('...driveSyncRows(')
    expect(raktar, 'a raktar az alap: a Drive-mentes ELE tartozik').toBeLessThan(drive)
  })

  it('minden allapotnak van szovege ES teendoje mindket nyelven', () => {
    const idk = [...forras.matchAll(/id: '(depot_[a-z_]+)'/g)].map((m) => m[1])
    expect(new Set(idk).size, 'nem talaltam meg a raktar-sorok azonositoit').toBe(5)
    for (const nyelv of ['hu', 'en']) {
      const sz = readFileSync(join(ROOT, 'web', 'lang', `${nyelv}.js`), 'utf-8')
      for (const id of idk) {
        expect(sz, `${nyelv}: nincs szoveg ehhez: ${id}`).toContain(`'health.${id}':`)
        expect(sz, `${nyelv}: nincs teendo ehhez: ${id}`).toContain(`'health.${id}_action':`)
      }
    }
  })

  it('a hibas soroknal ott az utvonal is -- kulonben nem tudod, MELYIK mappa', () => {
    for (const nyelv of ['hu', 'en']) {
      const sz = readFileSync(join(ROOT, 'web', 'lang', `${nyelv}.js`), 'utf-8')
      for (const id of ['depot_ok', 'depot_unreachable', 'depot_missing_dir', 'depot_not_dir', 'depot_readonly']) {
        const sor = new RegExp(`'health\\.${id}':\\s*'([^']*)'`).exec(sz)
        expect(sor, `${nyelv}: ${id}`).toBeTruthy()
        expect((sor as RegExpExecArray)[1], `${nyelv}: ${id} nem irja ki az utvonalat`).toContain('{p}')
      }
    }
  })
})
