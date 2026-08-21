import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync as read } from 'node:fs'
import {
  safeDepotName, depotRoot, depotAccountDir, depotHealth, ensureDepotSkeleton,
  resolvePhotoDir, countFiles, migrateLegacyAccountDirs,
  DEPOT_ACCOUNTS, DEPOT_PHOTOS, DEPOT_DRIVE, DEPOT_SYSTEM,
  DEPOT_PROJECTS, DEPOT_WORK, DEPOT_BACKUPS,
} from '../depot.js'
import { moveVerified, migrateDir, sha256Of } from '../depot-migrate.js'
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
    mkdirSync(join(root, DEPOT_ACCOUNTS, 'lackor2', DEPOT_PHOTOS), { recursive: true })
    writeFileSync(join(root, DEPOT_ACCOUNTS, 'lackor2', DEPOT_PHOTOS, 'kep.jpg'), 'x')
    mkdirSync(join(root, DEPOT_ACCOUNTS, 'usalackor', DEPOT_DRIVE), { recursive: true })
    writeFileSync(join(root, DEPOT_ACCOUNTS, 'usalackor', DEPOT_DRIVE, 'a.txt'), 'y')

    const mozgatott = migrateLegacyAccountDirs()
    expect(mozgatott).toHaveLength(2)
    expect(existsSync(join(root, DEPOT_PHOTOS, 'lackor2', 'kep.jpg'))).toBe(true)
    expect(existsSync(join(root, DEPOT_DRIVE, 'usalackor', 'a.txt'))).toBe(true)
    // A regi vaz eltunt, nem maradt ures mappa-labirintus.
    expect(existsSync(join(root, DEPOT_ACCOUNTS))).toBe(false)
  })

  it('ha a cel MAR letezik, nem nyul hozza (inkabb ket hely, mint felulirt fajl)', () => {
    const root = process.env.MARVEEN_DEPOT!
    mkdirSync(join(root, DEPOT_ACCOUNTS, 'lackor2', DEPOT_PHOTOS), { recursive: true })
    writeFileSync(join(root, DEPOT_ACCOUNTS, 'lackor2', DEPOT_PHOTOS, 'kep.jpg'), 'regi')
    mkdirSync(join(root, DEPOT_PHOTOS, 'lackor2'), { recursive: true })
    writeFileSync(join(root, DEPOT_PHOTOS, 'lackor2', 'kep.jpg'), 'uj')

    expect(migrateLegacyAccountDirs()).toHaveLength(0)
    expect(readFileSync(join(root, DEPOT_PHOTOS, 'lackor2', 'kep.jpg'), 'utf8')).toBe('uj')
    expect(existsSync(join(root, DEPOT_ACCOUNTS, 'lackor2', DEPOT_PHOTOS, 'kep.jpg'))).toBe(true)
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

describe('atkoltoztetes: masol, ellenoriz, csak AZUTAN torol', () => {
  it('a fajl atkerul, es a tartalma valtozatlan', async () => {
    const from = join(tmp, 'a.jpg')
    const to = join(tmp, 'cel', 'a.jpg')
    writeFileSync(from, 'kep-bajtok')
    expect(await moveVerified(from, to)).toBe('moved')
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(to, 'utf8')).toBe('kep-bajtok')
  })

  it('a celmappaban SOSEM marad felkesz .part fajl', async () => {
    const from = join(tmp, 'b.jpg')
    const to = join(tmp, 'cel2', 'b.jpg')
    writeFileSync(from, 'x'.repeat(1000))
    await moveVerified(from, to)
    expect(existsSync(`${to}.part`)).toBe(false)
  })

  it('azonos tartalom mar a helyen -> a regi peldany mehet, az uj marad', async () => {
    const from = join(tmp, 'c.jpg')
    const to = join(tmp, 'cel3', 'c.jpg')
    mkdirSync(join(tmp, 'cel3'))
    writeFileSync(from, 'ugyanaz')
    writeFileSync(to, 'ugyanaz')
    expect(await moveVerified(from, to)).toBe('already')
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(to, 'utf8')).toBe('ugyanaz')
  })

  it('MAS tartalom a cel neven -> hozza sem nyulunk, a regi is megmarad', async () => {
    const from = join(tmp, 'd.jpg')
    const to = join(tmp, 'cel4', 'd.jpg')
    mkdirSync(join(tmp, 'cel4'))
    writeFileSync(from, 'enyem')
    writeFileSync(to, 'valaki mase')
    expect(await moveVerified(from, to)).toBe('failed')
    // EGYIK sem veszett el -- ez a lenyeg.
    expect(readFileSync(from, 'utf8')).toBe('enyem')
    expect(readFileSync(to, 'utf8')).toBe('valaki mase')
  })

  it('egy egesz mappa atkoltoztetese', async () => {
    const from = join(tmp, 'src')
    const to = join(tmp, 'dst')
    mkdirSync(from)
    writeFileSync(join(from, '1.jpg'), 'egy')
    writeFileSync(join(from, '2.jpg'), 'ketto')
    const r = await migrateDir(from, to)
    expect(r.moved).toBe(2)
    expect(r.failed).toBe(0)
    expect(readFileSync(join(to, '1.jpg'), 'utf8')).toBe('egy')
  })

  it('a rejtett bejegyzesek (.thumbs, .part) kimaradnak', async () => {
    const from = join(tmp, 'src2')
    const to = join(tmp, 'dst2')
    mkdirSync(join(from, '.thumbs'), { recursive: true })
    writeFileSync(join(from, '.thumbs', 'x.jpg'), 'bolyeg')
    // Rejtett FAJL is kell ide, ne csak rejtett mappa: a mappat amugy is
    // kiszurne a "csak fajlt viszunk" szabaly, tehat rejtett mappaval a
    // ponttal-kezdodo szures egyaltalan nem lenne merve. (Ezt a lyukat a
    // szabotazs-proba mutatta meg: kivettem a szurest, es a teszt atengedte.)
    writeFileSync(join(from, '.reszleges.jpg'), 'felkesz')
    writeFileSync(join(from, 'felkesz.jpg.part'), 'darab')
    writeFileSync(join(from, 'jo.jpg'), 'kep')
    const r = await migrateDir(from, to)
    expect(r.moved).toBe(2)          // jo.jpg + felkesz.jpg.part (nem rejtett)
    expect(existsSync(join(to, '.thumbs'))).toBe(false)
    expect(existsSync(join(from, '.thumbs', 'x.jpg'))).toBe(true)
    expect(existsSync(join(to, '.reszleges.jpg'))).toBe(false)
    expect(existsSync(join(from, '.reszleges.jpg'))).toBe(true)
  })

  it('ha a regit nem lehet torolni, az UJ peldany akkor is a helyen van', async () => {
    // Ez a masolas -> ellenorzes -> torles SORRENDJET meri. Ha a torles
    // elorekerulne, egy irasvedett forrasmappanal a regi peldany maradna, az uj
    // pedig el sem keszulne -- eppen forditva, mint amit igerunk.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const dir = join(tmp, 'zart')
    const from = join(dir, 'f.jpg')
    const to = join(tmp, 'cel-zart', 'f.jpg')
    mkdirSync(dir, { recursive: true })
    writeFileSync(from, 'tartalom')
    chmodSync(dir, 0o555)
    try {
      await moveVerified(from, to)
      expect(existsSync(to)).toBe(true)
      expect(readFileSync(to, 'utf8')).toBe('tartalom')
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it('a masolatot LENYOMATTAL ellenorzi, es a sorrend is kotott', () => {
    // Forras-horgony: a masolat ujra-hasheleset es a "csak ellenorzes utan
    // torlunk" sorrendet nem lehet kikapcsolni eszrevetlenul. Kiserletileg
    // serult masolatot nem tudok eloallitani (a copy determinisztikus), ezert
    // itt a kod ALAKJA a vedelem -- de ez a ket sor a lelke az egesznek.
    const mig = read(join(ROOT, 'src', 'depot-migrate.ts'), 'utf8')
    expect(mig).toMatch(/if \(\(await sha256Of\(tmp\)\) !== srcHash\) \{/)
    expect(mig).toMatch(/renameSync\(tmp, to\)\s*\n\s*rmSync\(from, \{ force: true \}\)/)
  })

  it('nem letezo forrasmappa nem hiba, csak nincs mit vinni', async () => {
    const r = await migrateDir(join(tmp, 'nincs'), join(tmp, 'cel5'))
    expect(r).toEqual({ moved: 0, alreadyThere: 0, failed: 0, bytes: 0, errors: [] })
  })

  it('a lenyomat tenyleg a tartalmat nezi', async () => {
    const a = join(tmp, 'e1')
    const b = join(tmp, 'e2')
    writeFileSync(a, 'azonos')
    writeFileSync(b, 'azonos')
    expect(await sha256Of(a)).toBe(await sha256Of(b))
    writeFileSync(b, 'mas')
    expect(await sha256Of(a)).not.toBe(await sha256Of(b))
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

  it('van Depo oldal a feluleten, es el is indul', () => {
    expect(html).toContain('data-page="depo"')
    expect(html).toContain('id="depoPage"')
    expect(app).toContain("if (pageId === 'depo') loadDepoPage()")
    // Elnavigalva a poll leall -- kulonben orokke ketyegne a hatterben.
    expect(app).toContain("if (pageId !== 'depo') _depoStopPoll()")
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
