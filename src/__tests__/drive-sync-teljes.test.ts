/**
 * TELJES SZINKRON: az egesz Drive egyben, azonos fa-szerkezettel.
 *
 * Boss, 2026-08-15:
 *   "sot. ha szinkronizalasrol van szo akkor az egeszet egyben kellene
 *    szinkronizalni. es nem csak egy egy mappat."
 *   "total szinkron. meg a fa struktura is ugyanaz legyen."
 *   "magyaran a drive a neten egy biztonsagi mentes."
 *   "a gepeden ez legyen a mappa neve -- na az sem kell. legyen csak ugyanaz
 *    mint fent a neten. a lackor2 legyen lackor2. igy nincs keveredes."
 *
 * Amit ez a fajl orzii:
 *   1. A gyoker (`root`) parosahoz NEM kell mappanev -- mashoz viszont igen.
 *   2. Ures nevnel a cel MAGA a fiok mappaja: nincs fole huzott extra szint,
 *      vagyis a fa pontosan ugyanaz, mint a Drive-on.
 *   3. A `safeSegment('')` `nevtelen`-t ad -- ezt az utat ki KELL kerulni,
 *      kulonben egy `nevtelen` nevu mappa jelenne meg a fiok mappaja alatt.
 *   4. A teljes Drive a kepernyon nem ures cellakent latszik.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { safeSegment, pairLabel } from '../web/routes/drive-sync.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'drive-sync.ts'), 'utf8')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')

describe('a gyokerhez nem kell mappanev', () => {
  it('a hianyzo nev csak NEM-gyokernel hiba', () => {
    expect(route).toContain("if (!name && folderId !== 'root')")
    // A fiok viszont tovabbra is kotelezo: enelkul nem tudjuk, kihez tartozik.
    expect(route).toContain("if (!account) { json(res, { error: 'hiányzik a fiók' }, 400); return true }")
  })

  it('a mappa-azonosito kapuja valtozatlanul ott van (a `root` atmegy rajta)', () => {
    // Sorrend: eloszor a nev-szabaly, aztan az azonosito -- de mindketto a
    // parositas ELOTT. Egy ervenytelen azonosito sose kerulhessen a listaba.
    expect(route).toContain('if (!isSafeFolderId(folderId))')
    expect(route.indexOf('isSafeFolderId(folderId)')).toBeLessThan(route.indexOf('cfg.pairs.push(pair)'))
  })
})

describe('ures nev = a fiok mappaja MAGA a cel (azonos fa)', () => {
  it('a bejaras nem hivja a safeSegment-et ures nevre', () => {
    // Ez a csapda: safeSegment('') === 'nevtelen', vagyis egy `nevtelen` nevu
    // mappa jonne letre, es a fa NEM lenne ugyanaz, mint a Drive-on.
    expect(safeSegment('')).toBe('nevtelen')
    expect(route).toContain("const gyoker = pair.name ? safeSegment(pair.name) : ''")
    expect(route).toContain('[{ id: pair.folderId, rel: gyoker }]')
    expect(route).not.toContain('rel: safeSegment(pair.name)')
  })

  it('a kiirt helyi mappa is a fiok mappaja, nem `nevtelen`', () => {
    expect(route).toContain('p.name ? join(depotAccountDir(p.account, DEPOT_DRIVE)!, safeSegment(p.name)) : depotAccountDir(p.account, DEPOT_DRIVE)!')
  })

  it('a `join(base, "")` tenyleg a base marad (ezen all az egesz)', () => {
    expect(join('/depo/drive/lackor2', '')).toBe('/depo/drive/lackor2')
    expect(join('', 'Fotok')).toBe('Fotok')
  })
})

describe('a teljes Drive-nak NEVE van a kepernyon', () => {
  it('ures nev helyett emberi szoveg all', () => {
    expect(pairLabel({ name: '' })).toBe('a teljes Drive')
    expect(pairLabel({})).toBe('a teljes Drive')
    expect(pairLabel({ name: 'Szamlak' })).toBe('Szamlak')
  })

  it('a futas allapotsora es a hibauzenet is ezt hasznalja', () => {
    // Kulonben "epp ezen dolgozom: " allna ott, ures hellyel.
    expect(route).toContain('job.pair = pairLabel(pair)')
    // A hibauzenet 2026-08-16 ota a `gond()` strukturalt bejelentojen megy at
    // (nem kozvetlen `errors.push`), hogy a hibalista gepi mezoket is kapjon --
    // a NEV azonban tovabbra is a `pairLabel`, kulonben ": Drive 403" allna ott.
    expect(route).toContain('driveName: pairLabel(pair)')
    expect(route).toContain('az egész páros elhasalt: ${pair.lastResult}')
  })
})

describe('ket paros ugyanarra a fiokra nem fedhet at', () => {
  it('a teljes Drive masodszori felvetele nem "ez a mappa" szoveget ad', () => {
    // A fo uton EGY gomb van: a leggyakoribb hiba a masodik kattintas. Ott a
    // "ez a mappa mar szinkronizalva van" ertelmetlen -- nem mappat valasztott.
    expect(route).toContain("folderId === 'root'")
    expect(route).toContain('teljes Drive-ja már szinkronizálva van.')
  })

  it('a teljes Drive mellé nem kerulhet be egy azon beluli mappa', () => {
    // Kulonben ugyanazok a bajtok ketszer jonnenek le, UGYANODA -- es a masodik
    // paros minden futasban ujra, mert a `needsDownload` `!known` aga mindig igaz.
    expect(route).toContain("if (folderId !== 'root' && cfg.pairs.some((p) => p.account === account && p.folderId === 'root'))")
    expect(route).toContain("code: 'whole_drive_exists'")
    // A kapu a felvetel ELOTT all.
    expect(route.indexOf("code: 'whole_drive_exists'")).toBeLessThan(route.indexOf('cfg.pairs.push(pair)'))
  })

  it('a gyoker hibauzenete elott nem all ures nev', () => {
    // A `rel` a legfelso szinten ures: ": Drive 403" lenne belole. A nev azota
    // sajat mezobe kerult (`driveName`) a szovegbe olvasztas helyett, de a
    // helyettesito szoveg ugyanaz -- ez az, amit a felhasznalo lat.
    expect(route).toContain("driveName: cur.rel || 'a Drive gyökere'")
  })
})

describe('a listaban latszik, HOVA kerul a gepen', () => {
  it('a helyi utvonal sajat oszlopban all -- nem kell kitalalni', () => {
    // Boss: "a lackor2 legyen lackor2. igy nincs keveredes." Ezt csak akkor
    // lehet ELLENORIZNI, ha a kepernyon is ott van, nem csak a kodban.
    expect(app).toContain('<th>Hol a gépeden</th>')
    expect(app).toContain("p.localDir ? '<code>' + escapeHtml(p.localDir) + '</code>'")
    // Depo nelkul nem ures cella all ott, hanem kimondjuk, mi a helyzet.
    // A mondat 2026-08-27 ota kulcson at jon (angolul is ki kell mondani),
    // ezert a hivast ES a ket forditast is ellenorizzuk -- kulonben egy ures
    // kulcs ugyanugy ures cellat adna, csak most csendben.
    expect(app).toContain("t('dsync.no_depot_cell')")
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(ROOT, 'web', 'lang', `${lang}.js`), 'utf-8')
      const m = src.match(/'dsync\.no_depot_cell':\s*'([^']+)'/)
      expect(m, `${lang}.js: hianyzik a dsync.no_depot_cell`).toBeTruthy()
      expect((m as RegExpMatchArray)[1].trim().length).toBeGreaterThan(0)
    }
  })

  it('a kiszolgalo kuldi is ezt a mezot', () => {
    expect(route).toContain('localDir: depotAccountDir(p.account, DEPOT_DRIVE)')
  })
})

describe('a csonka mentesre nem szabad "rendben"-t irni', () => {
  it('a bejaras megmondja, csonkolt-e', () => {
    // A jelzes 2026-08-16-tol nem `boolean`, hanem OK-LISTA (`CsonkaOk[]`): egy
    // igaz/hamis csak annyit mondott, hogy "valami kimaradt", azt nem, hogy MI
    // es HOL. A felhasznalonak epp az kell, hogy tudja, melyik mappaja hianyos.
    expect(route).toContain('Promise<{ csonkolt: CsonkaOk[]; brake:')
    // Halmaz, nem lista: ugyanaz az ok szazszor is bekovetkezhet egy futasban
    // (szaz olvashatatlan mappa), a felhasznalonak viszont EGYSZER kell.
    expect(route).toContain('const csonkaOkok = new Set<CsonkaOk>()')
    // Mindharom ok kulon nevet kap -- mas-mas teendot jelentenek.
    expect(route).toContain("csonkaOkok.add('mappa-korlát')")
    expect(route).toContain("csonkaOkok.add('fájl-korlát')")
    expect(route).toContain("csonkaOkok.add('olvasási hiba')")
    // Es a hatar elerese nevesitve, a szammal egyutt jelenik meg.
    expect(route).toContain('mappás felső határ elérve')
    expect(route).toContain('fájlos felső határ elérve')
  })

  it('a paros eredmenye ettol fugg', () => {
    // 2026-08-15 ota a `syncPair` a vészféket is visszaadja (ketiranyu
    // szinkron), de a csonkolas-jelzes valtozatlanul ide fut be.
    expect(route).toContain('const { csonkolt, brake } = await syncPair(pair, cfg)')
    // A "részleges" szo megmarad -- ez az, amit a listaban a user elolvas --,
    // de mar nem egy fix mondat kovetkezik utana, hanem a KONKRET ok.
    expect(route).toContain('részleges: ${csonkoltSzoveg(csonkolt, MAX_FOLDERS, MAX_FILES)}')
    expect(route).toContain('a többi kimaradt')
  })

  it('es a kepernyon is LATSZIK, nem csak a naploban', () => {
    // A lista korabban csak a datumot mutatta: egy csonka futas pontosan
    // ugyanugy nezett ki, mint egy teljes.
    expect(app).toContain("p.lastResult ? '<br><span class=\"subtitle\">' + escapeHtml(p.lastResult) + '</span>' : ''")
  })
})

describe('a korlatokat ki kell mondani', () => {
  it('a korlatok tovabbra is ott vannak, es szolnak, ha elfogytak', () => {
    // Merve (2026-08-15, lackor2): 74 mappa / 3179 fajl / 5,47 GB -> belefer.
    // De egy nagyobb fioknal a csonkolast KI KELL mondani, kulonben a user azt
    // hinne, hogy a mentese teljes.
    //
    // A hatarok 2026-08-16-an emelkedtek 500/5_000-rol: a Boss keresere ("emelni
    // a hatart, vagy a szinkront ujrainditani") -- egy 500 mappas plafon egy
    // eves Drive-nal MENET KOZBEN vagja el a mentest. A teszt ezert nem a
    // KONKRET szamot orzi (az valtozhat), hanem azt, hogy (a) van felso hatar,
    // (b) tobb ezres nagysagrendu, (c) az elerese KIMONDOTT hiba lesz.
    const folders = Number((route.match(/const MAX_FOLDERS = ([\d_]+)/) || [])[1]?.replace(/_/g, ''))
    const files = Number((route.match(/const MAX_FILES = ([\d_]+)/) || [])[1]?.replace(/_/g, ''))
    expect(folders).toBeGreaterThanOrEqual(1000)
    expect(files).toBeGreaterThanOrEqual(10_000)
    // A hatar elerese nem csendes: sajat okot kap, a szamot is kiirva.
    expect(route).toContain('mappás felső határ elérve')
    expect(route).toContain('fájlos felső határ elérve')
  })
})
