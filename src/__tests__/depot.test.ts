import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync as read } from 'node:fs'
import {
  safeDepotName, depotRoot, depotAccountDir, depotHealth, ensureDepotSkeleton,
  resolvePhotoDir, countFiles, migrateLegacyAccountDirs,
  DEPOT_ACCOUNTS, DEPOT_PHOTOS, DEPOT_DRIVE, DEPOT_SYSTEM,
  LEGACY_KIND_PHOTOS, LEGACY_KIND_DRIVE,
  DEPOT_PROJECTS, DEPOT_WORK, DEPOT_BACKUPS,
} from '../depot.js'
import { safeSegment, needsDownload } from '../web/routes/drive-sync.js'

const ROOT = join(__dirname, '..', '..')
let tmp = ''
const prevDepot = process.env.MARVEEN_DEPOT

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'depo-teszt-'))
  process.env.MARVEEN_DEPOT = join(tmp, 'Marveen')
})

afterEach(() => {
  if (prevDepot === undefined) delete process.env.MARVEEN_DEPOT
  else process.env.MARVEEN_DEPOT = prevDepot
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* mar nincs meg */ }
})

describe('a depo helye', () => {
  it('nincs beallitva -> nincs depo, minden marad a regi helyen', () => {
    delete process.env.MARVEEN_DEPOT
    expect(depotRoot()).toBeNull()
    expect(depotAccountDir('a@b.hu', DEPOT_PHOTOS)).toBeNull()
    // Ez a legfontosabb: depo nelkul a regi utvonalat kapja vissza VALTOZATLANUL.
    expect(resolvePhotoDir('a@b.hu', '/regi/hely')).toBe('/regi/hely')
  })

  it('csupa szokoz nem szamit beallitasnak', () => {
    process.env.MARVEEN_DEPOT = '   '
    expect(depotRoot()).toBeNull()
  })

  it('a FAJTA van felul, nem a fiok: drive/lackor2, fotok/lackor2', () => {
    // Boss, 2026-08-15: "a fotok mappaba lesz lackor2, usalackor stb. nevu
    // mappak" -- vagyis eloszor azt latod, MIT keresel, azutan azt, KIE.
    expect(depotAccountDir('lackor2', DEPOT_PHOTOS)!).toContain(join(DEPOT_PHOTOS, 'lackor2'))
    expect(depotAccountDir('lackor2', DEPOT_DRIVE)!).toContain(join(DEPOT_DRIVE, 'lackor2'))
    // A REGI alak (fiokok/<fiok>/<fajta>) mar nem szerepelhet benne.
    expect(depotAccountDir('lackor2', DEPOT_DRIVE)!).not.toContain(DEPOT_ACCOUNTS)
  })

  it('a helyi mappa neve a FIOK neve -- nem lehet atirni', () => {
    // Ez volt a Boss aggalya: "kesobb veletlenul nem fogja a lackor2 interneten
    // levo mappakat az usalackor-ra szinkronizalni csak mert megvaltoztatta a
    // nevet." Ket kulonbozo fiok SOHA nem eshet egy mappaba.
    expect(depotAccountDir('lackor2', DEPOT_DRIVE)).not.toBe(depotAccountDir('usalackor', DEPOT_DRIVE))
    expect(depotAccountDir('lackor2', DEPOT_DRIVE)!.endsWith(join(DEPOT_DRIVE, 'lackor2'))).toBe(true)
  })
})

describe('a regi szerkezet egyszeri atkoltoztetese', () => {
  // fiokok/<fiok>/<fajta>  ->  <fajta>/<fiok>. ATNEVEZES: nem masol, nem duplaz.
  it('atemeli, ami mar lejott, es a fajl VALOBAN az uj helyen van', () => {
    const root = process.env.MARVEEN_DEPOT!
    mkdirSync(join(root, DEPOT_ACCOUNTS, 'lackor2', LEGACY_KIND_PHOTOS), { recursive: true })
    writeFileSync(join(root, DEPOT_ACCOUNTS, 'lackor2', LEGACY_KIND_PHOTOS, 'kep.jpg'), 'x')
    mkdirSync(join(root, DEPOT_ACCOUNTS, 'usalackor', LEGACY_KIND_DRIVE), { recursive: true })
    writeFileSync(join(root, DEPOT_ACCOUNTS, 'usalackor', LEGACY_KIND_DRIVE, 'a.txt'), 'y')

    const mozgatott = migrateLegacyAccountDirs()
    expect(mozgatott).toHaveLength(2)
    expect(existsSync(join(root, DEPOT_PHOTOS, 'lackor2', 'kep.jpg'))).toBe(true)
    expect(existsSync(join(root, DEPOT_DRIVE, 'usalackor', 'a.txt'))).toBe(true)
    // A regi vaz eltunt, nem maradt ures mappa-labirintus.
    expect(existsSync(join(root, DEPOT_ACCOUNTS))).toBe(false)
  })

  it('ha a cel MAR letezik, nem nyul hozza (inkabb ket hely, mint felulirt fajl)', () => {
    const root = process.env.MARVEEN_DEPOT!
    mkdirSync(join(root, DEPOT_ACCOUNTS, 'lackor2', LEGACY_KIND_PHOTOS), { recursive: true })
    writeFileSync(join(root, DEPOT_ACCOUNTS, 'lackor2', LEGACY_KIND_PHOTOS, 'kep.jpg'), 'regi')
    mkdirSync(join(root, DEPOT_PHOTOS, 'lackor2'), { recursive: true })
    writeFileSync(join(root, DEPOT_PHOTOS, 'lackor2', 'kep.jpg'), 'uj')

    expect(migrateLegacyAccountDirs()).toHaveLength(0)
    expect(readFileSync(join(root, DEPOT_PHOTOS, 'lackor2', 'kep.jpg'), 'utf8')).toBe('uj')
    expect(existsSync(join(root, DEPOT_ACCOUNTS, 'lackor2', LEGACY_KIND_PHOTOS, 'kep.jpg'))).toBe(true)
  })

  it('nincs regi mappa -> nem csinal semmit, es nem is hibazik', () => {
    expect(migrateLegacyAccountDirs()).toEqual([])
  })

  it('depo nelkul sem nyul semmihez', () => {
    delete process.env.MARVEEN_DEPOT
    expect(migrateLegacyAccountDirs()).toEqual([])
  })

  it('a vazkeszites ELOBB koltoztet, csak azutan hozza letre az uj mappakat', () => {
    // Forditva a frissen letrehozott ures `fotok/` mar "letezo cel" lenne, es a
    // regi tartalom orokre ottragadna a fiokok/ alatt.
    const forras = read(join(ROOT, 'src', 'depot.ts'), 'utf8')
    expect(forras.indexOf('migrateLegacyAccountDirs()')).toBeLessThan(forras.indexOf('for (const d of [DEPOT_DRIVE'))
  })

  it('a vaz a fajtakat hozza letre felul (nem a `fiokok`-at)', () => {
    const r = ensureDepotSkeleton()
    expect(r.created).toContain(DEPOT_DRIVE)
    expect(r.created).toContain(DEPOT_PHOTOS)
    expect(r.created).not.toContain(DEPOT_ACCOUNTS)
  })
})

describe('mappanev Windowson is', () => {
  it('az e-mail cim olvashato marad', () => {
    expect(safeDepotName('usalackor@gmail.com')).toBe('usalackor@gmail.com')
  })

  it('a Windowson tiltott karakterek eltunnek', () => {
    expect(safeDepotName('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h')
  })

  it('nem vegzodhet ponttal vagy szokozzel (Windowson megnyithatatlan lenne)', () => {
    expect(safeDepotName('mappa.')).toBe('mappa')
    expect(safeDepotName('mappa ')).toBe('mappa')
  })

  it('nem lehet ures', () => {
    expect(safeDepotName('...')).toBe('_')
    expect(safeDepotName('')).toBe('_')
  })

  it('utvonal-elvalaszto sosem maradhat benne', () => {
    expect(safeDepotName('../../etc/passwd')).not.toContain('/')
    expect(safeDepotName('..\\..\\Windows')).not.toContain('\\')
  })
})

describe('el-e a depo (ez mondja ki a bajt)', () => {
  it('nem letezo mappa -> kimondja, es NEM irhato', () => {
    process.env.MARVEEN_DEPOT = join(tmp, 'nincs-ilyen')
    const h = depotHealth()
    expect(h.configured).toBe(true)
    expect(h.exists).toBe(false)
    expect(h.writable).toBe(false)
    // Nem nema hiba: a felhasznalonak szolo mondatban ott az utvonal.
    expect(h.message).toContain(join(tmp, 'nincs-ilyen'))
  })

  it('fajl a mappa helyen -> nem mappa, tehat nem jo', () => {
    const p = join(tmp, 'ez-egy-fajl')
    writeFileSync(p, 'x')
    process.env.MARVEEN_DEPOT = p
    expect(depotHealth().exists).toBe(false)
  })

  it('letezo, irhato mappa -> rendben', () => {
    const p = join(tmp, 'jo')
    mkdirSync(p)
    process.env.MARVEEN_DEPOT = p
    const h = depotHealth()
    expect(h.exists).toBe(true)
    expect(h.writable).toBe(true)
  })

  it('a proba nem hagy maga utan szemetet', () => {
    const p = join(tmp, 'jo2')
    mkdirSync(p)
    process.env.MARVEEN_DEPOT = p
    depotHealth()
    expect(countFiles(p)).toBe(0)
    expect(existsSync(join(p, '.marveen-iras-proba'))).toBe(false)
  })

  it('nem irhato mappa -> VALODI irassal derul ki, nem a jogosultsagi bitekbol', () => {
    const p = join(tmp, 'zart')
    mkdirSync(p)
    chmodSync(p, 0o500)
    process.env.MARVEEN_DEPOT = p
    try {
      const h = depotHealth()
      // Root alatt a chmod nem all utjaba az irasnak -- ott ez a proba nem
      // ertelmes, es a teszt sem allithat mast.
      if (process.getuid && process.getuid() === 0) expect(h.exists).toBe(true)
      else {
        expect(h.writable).toBe(false)
        expect(h.message).toContain('nem tudok bele írni')
      }
    } finally {
      chmodSync(p, 0o700)
    }
  })
})

describe('a depo alapmappai', () => {
  it('elkeszulnek, es mind a hat ott van', () => {
    // A technikai mappak a RENDSZER ala kerultek; a drive es a fotok
    // SZANDEKOSAN a gyokerben maradt. Konstansbol dolgozunk, nem beirt nevbol.
    const r = ensureDepotSkeleton()
    expect(r.health.writable).toBe(true)
    for (const d of [DEPOT_DRIVE, DEPOT_PHOTOS, DEPOT_PROJECTS, DEPOT_WORK, DEPOT_BACKUPS, DEPOT_SYSTEM]) {
      expect(existsSync(join(process.env.MARVEEN_DEPOT!, d))).toBe(true)
    }
  })

  it('masodszor futtatva nem csinal semmit (nem hiba)', () => {
    ensureDepotSkeleton()
    const r = ensureDepotSkeleton()
    expect(r.created).toEqual([])
    expect(r.health.writable).toBe(true)
  })

  it('elerhetetlen depo eseten NEM hoz letre semmit', () => {
    // Egy fajlt adunk meg depokent: a gyoker nem keszulhet el, es a
    // vazszerkezet sem -- kulonben egy elirt utvonalra ures mappakat szornank.
    const p = join(tmp, 'fajl-nem-mappa')
    writeFileSync(p, 'x')
    process.env.MARVEEN_DEPOT = p
    const r = ensureDepotSkeleton()
    expect(r.created).toEqual([])
    expect(r.health.writable).toBe(false)
    expect(statSync(p).isFile()).toBe(true)
  })

  it('irasvedett gyoker eseten sem keszul semmi, es meg is mondja, miert', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const p = join(tmp, 'zart-depo')
    mkdirSync(p, { recursive: true })
    chmodSync(p, 0o555)
    process.env.MARVEEN_DEPOT = p
    try {
      const r = ensureDepotSkeleton()
      expect(r.created).toEqual([])
      expect(r.health.writable).toBe(false)
      expect(r.health.message).toContain('nem tudok bele írni')
      expect(existsSync(join(p, DEPOT_DRIVE))).toBe(false)
    } finally {
      chmodSync(p, 0o755)
    }
  })

  it('eltunt lemeznel NEM huzza fel a hianyzo szulomappat sem', () => {
    // Ez a legveszelyesebb hibamod, es a `recursive: true` alapbol pont ezt
    // csinalna: ha a /mnt/d elszall, a /mnt/d/Marveen letrehozasa egy /mnt/d
    // nevu kozonseges linux-mappat gyartana a WSL gyokeren, es a kepek oda
    // mennenek -- nem a D: lemezre, hanem a semmibe.
    const p = join(tmp, 'nincs-ilyen-lemez', 'Marveen')
    process.env.MARVEEN_DEPOT = p
    const r = ensureDepotSkeleton()
    expect(r.created).toEqual([])
    expect(existsSync(join(tmp, 'nincs-ilyen-lemez'))).toBe(false)   // a szulo SEM keszult el
    expect(existsSync(p)).toBe(false)
    expect(r.health.message).toContain('nem érhető el')
  })

  it('letezo szulomappaban viszont maga hozza letre a depot', () => {
    // A masik oldal: ha a lemez ott van, csak a mappa nincs meg, akkor a
    // Marveen sajat maga megcsinalja -- ne kelljen kezzel mappat gyartani.
    const parent = join(tmp, 'lemez')
    mkdirSync(parent, { recursive: true })
    process.env.MARVEEN_DEPOT = join(parent, 'Marveen')
    const r = ensureDepotSkeleton()
    expect(r.health.writable).toBe(true)
    expect(r.created).toContain(DEPOT_DRIVE)
    expect(existsSync(join(parent, 'Marveen', DEPOT_DRIVE))).toBe(true)
  })

  it('a statusz-vegpont maga inditja el a vazszerkezetet', () => {
    // Enelkul a depo befagy: a koltoztetes megtagadja magat, mert a depo nem
    // irhato -- es azert nem irhato, mert meg nem letezik.
    const route = read(join(ROOT, 'src', 'web', 'routes', 'depot.ts'), 'utf8')
    expect(route).toContain('const health = ensureDepotSkeleton().health')
  })

  it('a "csak irhato depoba nyulunk" kapu a helyen van', () => {
    // Forras-horgony. A kapu kivetele magaban meg nem lathato kivulrol (a
    // mappankenti try/catch amugy is elnyelne a hibat), de eppen ezert nem is
    // venne eszre senki, ha eltunne -- a szabotazs-proba ezt mutatta meg.
    const src = read(join(ROOT, 'src', 'depot.ts'), 'utf8')
    expect(src).toContain('if (!health.writable) return { created: [], health }')
  })
})

describe('hol vannak a kepek', () => {
  it('ha a depoban meg nincs mappa, a regi hely marad', () => {
    const legacy = join(tmp, 'store', 'photos', 'lackor2')
    mkdirSync(legacy, { recursive: true })
    expect(resolvePhotoDir('lackor2', legacy)).toBe(legacy)
  })

  it('ha a depoban MAR van mappa, az a hiteles', () => {
    const legacy = join(tmp, 'store', 'photos', 'lackor2')
    mkdirSync(legacy, { recursive: true })
    const d = depotAccountDir('lackor2', DEPOT_PHOTOS)!
    mkdirSync(d, { recursive: true })
    expect(resolvePhotoDir('lackor2', legacy)).toBe(d)
  })
})

describe('a letoltes CSAK a depoba mehet (nincs ket hely, nincs koltoztetes)', () => {
  const depot = read(join(ROOT, 'src', 'web', 'routes', 'depot.ts'), 'utf8')
  const photos = read(join(ROOT, 'src', 'web', 'routes', 'photos-picker.ts'), 'utf8')
  const app = read(join(ROOT, 'web', 'app.js'), 'utf8')

  it('a fotok-valasztas el sem indul depo nelkul', () => {
    // A valasztas ELOTT kell szolni: kesobb a felhasznalo mar kijelolt
    // ketszaz kepet a Google feluleten, es azt dobnank el.
    const idx = photos.indexOf("path === '/api/photos/session' && method === 'POST'")
    expect(idx).toBeGreaterThan(-1)
    const blokk = photos.slice(idx, idx + 1400)
    expect(blokk).toContain("code: 'no_depot'")
    expect(blokk).toContain("code: 'depot_unreachable'")
    // A ket eset KULON kod: a "nincs beallitva" beallitas, a "nem erheto el"
    // javitas -- mas a teendo, mas uzenet jar.
    expect(blokk.indexOf("code: 'no_depot'")).toBeLessThan(blokk.indexOf("code: 'depot_unreachable'"))
  })

  it('a leiro fuggveny sem esik vissza a regi helyre', () => {
    // Ez a masodik retege ugyanannak: ha egy kesobbi hivo megkerulne a
    // vegpontot, ne csendben a rossz helyre irjon, hanem alljon meg.
    const idx = photos.indexOf('export function photoWriteDir')
    const blokk = photos.slice(idx, idx + 400)
    expect(blokk).toContain('throw new Error')
    expect(blokk).not.toContain('legacyPhotoDir')
  })

  it('a koltozteto vegpont es a kodja NINCS tobbe', () => {
    expect(depot).not.toContain('/api/depot/migrate')
    expect(depot).not.toContain('depot-migrate')
    expect(existsSync(join(ROOT, 'src', 'depot-migrate.ts'))).toBe(false)
  })

  it('a felulet sem kinal koltoztetest', () => {
    expect(app).not.toContain('/api/depot/migrate')
  })
})

describe('Drive-szinkron: fajlnevek', () => {
  it('a Drive-nev nem tud kilepni a mappabol', () => {
    expect(safeSegment('../../.ssh/authorized_keys')).not.toContain('/')
    expect(safeSegment('..')).toBe('_')
    expect(safeSegment('.')).toBe('_')
  })

  it('az ekezetek megmaradnak (a nev olvashato marad)', () => {
    expect(safeSegment('Szerződés 2026 március.pdf')).toBe('Szerződés 2026 március.pdf')
  })

  it('a Windowson tiltott karakterek eltunnek', () => {
    expect(safeSegment('a:b?c*d')).toBe('a_b_c_d')
  })

  it('ures nev sem lehet', () => {
    expect(safeSegment('')).toBe('nevtelen')
    expect(safeSegment('   ')).toBe('nevtelen')
  })
})

describe('Drive-szinkron: mit kell ujra lehozni', () => {
  const local = join(__dirname, '..', '..', 'package.json')  // letezo fajl

  it('amit meg soha nem hoztunk le, azt igen', () => {
    expect(needsDownload({ modifiedTime: 'x', size: '10' }, undefined, local)).toBe(true)
  })

  it('valtozatlan datum + meret -> nem toltjuk ujra', () => {
    expect(needsDownload({ modifiedTime: 'x', size: '10' }, { path: 'a', modifiedTime: 'x', size: 10 }, local)).toBe(false)
  })

  it('valtozott datum -> ujra', () => {
    expect(needsDownload({ modifiedTime: 'y', size: '10' }, { path: 'a', modifiedTime: 'x', size: 10 }, local)).toBe(true)
  })

  it('valtozott meret -> ujra', () => {
    expect(needsDownload({ modifiedTime: 'x', size: '11' }, { path: 'a', modifiedTime: 'x', size: 10 }, local)).toBe(true)
  })

  it('ha a HELYI fajl eltunt, ujra lehozzuk (barmit is mond a nyilvantartas)', () => {
    expect(needsDownload({ modifiedTime: 'x', size: '10' }, { path: 'a', modifiedTime: 'x', size: 10 }, join(tmp, 'sose-volt'))).toBe(true)
  })

  it('Google-fajlnal (nincs meret) a datum dont egyedul', () => {
    // Az exportalt docx merete futasrol futasra valtozhat -- ha a meretet is
    // neznenk, minden szinkronban ujra lehoznank minden Docs-fajlt.
    expect(needsDownload({ modifiedTime: 'x' }, { path: 'a', modifiedTime: 'x', size: 12345 }, local)).toBe(false)
  })
})

describe('a beallitas es a vegpontok a helyukon vannak', () => {
  const registry = read(join(ROOT, 'src', 'config-registry.ts'), 'utf8')
  const config = read(join(ROOT, 'src', 'config.ts'), 'utf8')
  const web = read(join(ROOT, 'src', 'web.ts'), 'utf8')
  const depot = read(join(ROOT, 'src', 'depot.ts'), 'utf8')
  const app = read(join(ROOT, 'web', 'app.js'), 'utf8')
  const html = read(join(ROOT, 'web', 'index.html'), 'utf8')

  it('a depo helye a Beallitasok oldalrol allithato', () => {
    expect(registry).toContain("key: 'MARVEEN_DEPOT'")
    // Ujrainditast igenyel: az utvonalat a boot olvassa ki.
    const idx = registry.indexOf("key: 'MARVEEN_DEPOT'")
    expect(registry.slice(idx, idx + 900)).toContain('requiresRestart: true')
  })

  it('a mentett beallitas VERI a kornyezeti valtozot', () => {
    // Forditva egy regen ottfelejtett env-valtozo csendben felulirna azt, amit
    // a felhasznalo a feluleten allitott be.
    expect(config).toContain("cfg('MARVEEN_DEPOT')")
    expect(depot).toContain('DEPOT_ROOT_CONFIGURED || process.env.MARVEEN_DEPOT')
  })

  it('a depo- es szinkron-vegpontok be vannak kotve', () => {
    expect(web).toContain('tryHandleDepot(routeCtx)')
    expect(web).toContain('tryHandleDriveSync(routeCtx)')
  })

  it('a Raktar beallitasai elerhetok a feluletrol, es el is indulnak', () => {
    // A kartyak 2026-08-27 ota az Iroda -> Beallitasok "Raktar beallitasok"
    // csempeje alatt vannak (Boss: "a depo mappa alatti dolgokat at kellene
    // tenni a beallitasokba"). Az azonositok valtozatlanok.
    expect(html).toContain('data-category="depot"')
    expect(html).toContain('id="irodaSettingsDepotView"')
    expect(html).toContain('id="depoPage"')
    expect(app).toContain('function openIrodaDepotSettings()')
    expect(app).toContain('loadDepoPage()')
    // Elnavigalva a poll leall -- kulonben orokke ketyegne a hatterben.
    expect(app).toContain("if (pageId !== 'irodaSettings') _depoStopPoll()")
    // ... es a csempekhez visszalepve is, mert ott sincs kinek mutatni.
    expect(app).toContain('function closeIrodaSettingsDetail() {')
  })

  it('a csempe-lista tenyleg eltunik a reszletes nezet alol', () => {
    // A `.iroda-settings-categories` `display: flex`-e erosebb a bongeszo
    // `[hidden] { display: none }` szabalyanal: felulirás nelkul a csempek
    // akkor is latszanak, amikor a JS mar elrejtette oket.
    const css = readFileSync(join(process.cwd(), 'web/style.css'), 'utf8')
    expect(css).toContain('.iroda-settings-categories[hidden] { display: none; }')
  })

  it('a felulet kimondja, mi megy fel es mi NEM jon vissza', () => {
    // 2026-08-15-ig ez a teszt azt orizte, hogy a szinkron EGYIRANYU. A Boss
    // ezt elvetette: "amit a gepemen szerkesztek az felmenne a drive ra! ...
    // es ami a driv on fent torlodik az nalam megmarad. az helyes. mert ha
    // valaki feltori a drivomat akkor a gepemrol ne tudjon torolni."
    //
    // A szoveg tehat mar nem "egyirányú" -- de a lenyeget ugyanugy KI KELL
    // mondani, kulonben a felhasznalo nem tudja, mit tesz a gepe a Drive-javal.
    expect(html).toContain('felmegy')
    // A torles-irany aszimmetriaja: ez a biztonsagi lenyeg.
    expect(html).toContain('megmarad')
    expect(html).toContain('Kuka')
    // Es a ket kapcsolo, amivel a felmeno ag kikapcsolhato.
    expect(html).toContain('id="depoSyncUpload"')
    expect(html).toContain('id="depoSyncDeleteUp"')
  })
})

describe('a Depo fotok-kartyaja ODAVISZ, nem masodik letolto felulet', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf-8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf-8')

  it('van gomb, es az a Fotok oldalra visz', () => {
    expect(html).toContain('id="depoPhotosGoBtn"')
    expect(app).toContain("bind('depoPhotosGoBtn', () => switchPage('photos'))")
  })

  it('a gomb NEM a tablazat belsejeben van -- ures listaval is ott all', () => {
    // Ures depoban a tabla helyere egyetlen mondat kerul (`depot.photos.none`).
    // Ha a gomb azon belul lenne, pont friss telepitesen tunne el, amikor a
    // legjobban kell: nulla kep mellett ez az egyetlen ut tovabb.
    const tabla = html.indexOf('id="depoPhotosTable"')
    const gomb = html.indexOf('id="depoPhotosGoBtn"')
    expect(tabla).toBeGreaterThan(-1)
    expect(gomb).toBeGreaterThan(tabla)
    expect(app).not.toContain('depoPhotosGoBtn</button>')
  })

  it('NINCS masodik letolto felulet a Depo alatt', () => {
    // Egy helyen toltunk le. Ket felulet ket kulonbozo allapotot tudna
    // mutatni ugyanarrol a fiokrol.
    const kartya = html.slice(html.indexOf('depot.photos.title'), html.indexOf('dsync.title'))
    expect(kartya).not.toContain('/api/photos/session')
    expect(kartya).not.toContain('depoPhotosPickBtn')
  })

  it('a gomb es a magyarazata mindket nyelven megvan', () => {
    for (const nyelv of ['hu', 'en']) {
      const forras = readFileSync(join(process.cwd(), 'web/lang', nyelv + '.js'), 'utf-8')
      expect(forras, nyelv).toContain("'depot.photos.go_btn'")
      expect(forras, nyelv).toContain("'depot.photos.go_hint'")
    }
  })
})

describe('a kepernyon allo UTVONALAK a valodi mappaszerkezetet mondjak', () => {
  // A mert hiba: a Drive-kartya magyarazata 2026-08-27-ig a `drive/lackor2` es
  // `fotok/lackor2` utat igerte. Ezek a REGI, lapos nevek -- a 2026-08-15-os
  // atrendezes ota `Rendszer/Tárolók/Drive/lackor2` all a lemezen (a depo
  // gyokereben ellenorizve: lapos `drive` / `fotok` mappa nem letezik).
  // Aki a kepernyorol olvasva kereste a fajljait, nem talalta meg.
  //
  // Ez a teszt SZANDEKOSAN nem szoveget hasonlit szoveghez: a `depot.ts`
  // konstansaibol vezeti le, minek KELL ott allnia. Ha a mappaszerkezet megint
  // valtozik, a teszt bukik -- nem a felhasznalo veszi eszre fel ev mulva.
  const depotTs = readFileSync(join(process.cwd(), 'src/depot.ts'), 'utf-8')
  const konstans = (nev: string): string => {
    const m = depotTs.match(new RegExp('export const ' + nev + " = [`']([^`']*)"))
    if (m) return m[1]
    return ''
  }

  it('a lapos, regi nevek SEHOL nem szerepelnek a feluleten', () => {
    for (const f of ['web/index.html', 'web/lang/hu.js', 'web/lang/en.js']) {
      const forras = readFileSync(join(process.cwd(), f), 'utf-8')
      expect(forras, f + ' -- regi lapos Drive-ut').not.toContain('<code>drive/')
      expect(forras, f + ' -- regi lapos fotok-ut').not.toContain('<code>fotok/')
    }
  })

  it('a magyar szoveg a MAGYAR, az angol az ANGOL mappanevet mondja', () => {
    // A mappa neve az APP_LANG-ot koveti (`Tárolók` / `Storages`), ezert egy
    // magyar ut az angol szovegben ugyanolyan hiba, mint egy elavult ut.
    const hu = readFileSync(join(process.cwd(), 'web/lang/hu.js'), 'utf-8')
    const en = readFileSync(join(process.cwd(), 'web/lang/en.js'), 'utf-8')
    expect(hu).toContain('Rendszer/Tárolók/Drive/lackor2')
    expect(en).toContain('System/Storages/Drive/lackor2')
    expect(en, 'magyar mappanev az angol nyelvi fajlban').not.toContain('Rendszer/Tárolók/')
  })

  it('a felirt utak a depot.ts konstansaival egyeznek', () => {
    // DEPOT_DRIVE = `${DEPOT_STORAGES}/Drive`, DEPOT_PHOTOS = `.../GOOGLE_PHOTOS`
    expect(konstans('DEPOT_DRIVE')).toContain('/Drive')
    expect(konstans('DEPOT_PHOTOS')).toContain('/GOOGLE_PHOTOS')
    const hu = readFileSync(join(process.cwd(), 'web/lang/hu.js'), 'utf-8')
    expect(hu).toContain('Rendszer/Tárolók/GOOGLE_PHOTOS/lackor2')
  })
})

describe('a magyar feluleten RAKTAR all, es letezo helyre kuld', () => {
  // Boss, 2026-08-27: „hogyha magyar nyelvu a Marvin, akkor beszeljunk
  // magyarul, es mindenhol magyarul." A tarhely magyar neve RAKTAR -- azert
  // nem „depo", hogy ne keveredjen a GIT TAROLOVAL (repository). A kod
  // azonositoi (`depot*`, `depoPage`, 'depot.*' kulcsok) NEM valtoznak: az
  // ekezet a valasztovonal.
  const olvas = (f: string) => readFileSync(join(ROOT, f), 'utf-8')

  it('a kepernyore kerulo magyar szovegben nincs tobbe „depo"', () => {
    for (const f of ['web/lang/hu.js', 'web/index.html', 'web/app.js']) {
      const sorok = olvas(f).split('\n')
        .map((l, i) => ({ n: i + 1, l }))
        .filter(x => /[Dd]ep[\u00f3\u00d3]/.test(x.l))
        .map(x => `  ${f}:${x.n}  ${x.l.trim().slice(0, 110)}`)
      expect(sorok.length, sorok.length ? '\n' + sorok.join('\n') + '\n' : '').toBe(0)
    }
  })

  it('a magyar nyelvi fajl tenyleg a Raktar szot hasznalja', () => {
    const hu = olvas('web/lang/hu.js')
    expect(hu).toContain("'nav.depo':")
    expect(hu.match(/'nav\.depo':\s*'([^']+)'/)?.[1]).toBe('Rakt\u00e1r')
    // Az angol oldal marad Depot -- ez nem forditasi adossag, hanem dontes.
    expect(olvas('web/lang/en.js').match(/'nav\.depo':\s*'([^']+)'/)?.[1]).toBe('Depot')
  })

  it('a kod azonositoi VALTOZATLANOK -- kulonben a meglevo beallitas elveszne', () => {
    // Ha valaki „kovetkezetessegbol" atnevezne oket, a mar beallitott
    // MARVEEN_DEPOT es a mentesek utja egyszerre esne szet.
    expect(olvas('src/depot.ts')).toContain('export function depotRoot')
    expect(olvas('web/index.html')).toContain('id="depoPage"')
    expect(olvas('web/lang/hu.js')).toContain("'depot.card_title':")
  })

  it('egyetlen szoveg sem kuld NEM LETEZO oldalra', () => {
    // Valos hiba volt: negy onellenorzes-sor a „Tarolok oldalra" kuldott,
    // csak eppen ilyen oldal nincs -- a tablazat a Raktar oldal egyik
    // KARTYAJA. A rossz iranyba kuldott ember rosszabb, mint a hallgatas.
    const html = olvas('web/index.html')
    const oldalak = new Set([...html.matchAll(/data-page="([A-Za-z0-9_-]+)"/g)].map(m => m[1]))
    expect(oldalak.has('storages'), 'ha lett Tarolok OLDAL, ez a teszt frissitendo').toBe(false)
    expect(html.indexOf('id="storagesTable"')).toBeGreaterThan(html.indexOf('id="depoPage"'))
    const halott: string[] = []
    for (const f of ['web/lang/hu.js', 'web/lang/en.js', 'src/web/routes/storages.ts']) {
      olvas(f).split('\n').forEach((l, i) => {
        if (l.includes('T\u00e1rol\u00f3k oldal') || l.includes('Storages page')) {
          halott.push(`  ${f}:${i + 1}  ${l.trim().slice(0, 110)}`)
        }
      })
    }
    expect(
      halott.length,
      halott.length ? '\nNem letezo oldalra kuldo szoveg:\n' + halott.join('\n') + '\n' : '',
    ).toBe(0)
  })
})
