/**
 * A fiok-duplikalodas: 10 fiokbol 17 lett.
 *
 * Boss, 2026-08-22, miutan mind a 10 fiokot ujracsatlakoztatta: "valami bug
 * van. mert megduplazta a fiokokat. [...] es nem ugyanazt a fiokot hitelesiti!"
 *
 * A MERT lefolyas (store/dashboard.log + store/google-tokens.json):
 *   inditott slot   ->  a visszakapott token gazdaja  ->  mentve ide
 *   lackor2             usalackor@gmail.com               usalackor_2
 *   usalackor           lackor3@gmail.com                 lackor3_2
 *   lackor3             canadalackor@gmail.com            canadalackor_2
 *   canadalackor        daytraderboss@gmail.com           daytraderboss_2
 * ...tizbol hetszer. A cimeket nem talalgatjuk: `_token_email` a Google-tol
 * kerdezi meg, kie a token.
 *
 * KET fuggetlen hiba talalkozott:
 *
 *  1. A jovahagyo link nem mondta meg a Google-nak, MELYIK fiokrol van szo.
 *     Tiz bejelentkezett Google-fioknal a helyes sor kivalasztasa a felhasznalo
 *     emlekezeten mult -- a gep tudta a valaszt, megsem adta at. (`login_hint`)
 *
 *  2. Amikor megis mas cim erkezett, a szkript "uj fiokot" latott, es csinalt
 *     egy masodik slotot -- holott annak a postafioknak MAR volt sajat slotja,
 *     csak halott tokennel. A fiok azonossaga a CIM, nem a slot neve.
 *
 * Egy friss telepitesen ugyanez varna a kezelore, mert semmi nem kotelezi ra,
 * hogy a slot neve es a bejelentkezett cim egyezzen. Ezert vannak ezek a
 * tesztek: az elso a linket, a masodik a mentes celjat tartja a helyen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { markGoogleLiveOk, readGoogleLiveCheck, GOOGLE_LIVE_FILE } from '../web/google-live-check.js'
import { googleDuplicateRows } from '../web/system-health.js'

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'google-auth.py')
const runner = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'google-auth-runner.ts'), 'utf8')
const route = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'connections.ts'), 'utf8')

/**
 * A python dontes MEGHIVASA, nem a forrasa.
 *
 * Egy forras-illesztes csak azt bizonyitana, hogy a szoveg ott van. Itt a
 * szabaly maga fut le -- halozat nelkul, mert `_target_account` tisztan a
 * bemenetbol dolgozik.
 */
function celFiok(store: Record<string, unknown>, account: string, email: string | null) {
  const driver = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("ga", ${JSON.stringify(SCRIPT)})`,
    'ga = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(ga)',
    'data = json.loads(sys.argv[1])',
    'email = json.loads(sys.argv[2])',
    'acc, uz = ga._target_account(data, sys.argv[3], email)',
    'print(json.dumps({"account": acc, "uzenet": uz}))',
  ].join('\n')
  const out = execFileSync('python3', ['-c', driver, JSON.stringify(store), JSON.stringify(email), account], {
    encoding: 'utf8', timeout: 20000,
  })
  return JSON.parse(out.trim()) as { account: string; uzenet: string | null }
}

describe('a token abba a slotba kerul, amelyik CIMHEZ tartozik', () => {
  // Pontosan az az allas, ami 2026-08-22-en 17 fiokot csinalt.
  const store = {
    _default: 'lackor2',
    lackor2: { email: 'lackor2@gmail.com', refresh_token: 'x' },
    usalackor: { email: 'usalackor@gmail.com', refresh_token: 'x' },
    lackor3: { email: 'lackor3@gmail.com', refresh_token: 'x' },
  }

  it('a kert slotot inditottuk, de MAS cim jelentkezett be -> a cim sajat slotja', () => {
    // Ez a mert eset: `lackor2`-t inditotta a varazslo, usalackor hagyta jova.
    // Regen ebbol lett `usalackor_2`.
    const r = celFiok(store, 'lackor2', 'usalackor@gmail.com')
    expect(r.account).toBe('usalackor')
    expect(r.uzenet, 'a felulet nem hallgathatja el, hova ment').toContain('usalackor')
  })

  it('nem csinal masodik slotot annak, akinek mar van', () => {
    for (const [inditott, cim, vart] of [
      ['usalackor', 'lackor3@gmail.com', 'lackor3'],
      ['lackor3', 'lackor2@gmail.com', 'lackor2'],
    ] as const) {
      expect(celFiok(store, inditott, cim).account, `${inditott} + ${cim}`).toBe(vart)
    }
  })

  it('az egyezo eset csendes: ugyanaz a slot, nincs uzenet', () => {
    const r = celFiok(store, 'lackor2', 'lackor2@gmail.com')
    expect(r.account).toBe('lackor2')
    expect(r.uzenet).toBeNull()
  })

  it('VALODI uj cim tovabbra sem ir felul senkit', () => {
    // Ez a regi vedelem, es marad: egy idegen cimet a `lackor2` slotba menteni
    // nyom nelkul eltuntetne lackor2 hozzaferését.
    const r = celFiok(store, 'lackor2', 'ujember@gmail.com')
    expect(r.account).toBe('ujember')
    expect(r.uzenet).toContain('uj fiokkent')
  })

  it('utkozo nev eseten sem ir felul, hanem sorszamoz', () => {
    const s2 = { ...store, ujember: { email: 'masvalaki@gmail.com', refresh_token: 'x' } }
    expect(celFiok(s2, 'lackor2', 'ujember@gmail.com').account).toBe('ujember_2')
  })

  it('elso fiok, ures tarolo: a kert nev marad', () => {
    expect(celFiok({}, 'munka', 'barki@gmail.com').account).toBe('munka')
  })

  it('halozati hiba miatt ismeretlen cim: a kert slot marad, nem talalgatunk', () => {
    // `_token_email` sosem allitja meg a mentest -- egy atmeneti hiba miatt nem
    // dobhatjuk el a jovahagyast. Ilyenkor viszont tilos slotot valtani.
    const r = celFiok(store, 'lackor2', null)
    expect(r.account).toBe('lackor2')
    expect(r.uzenet).toBeNull()
  })

  it('a `_default` mutato nem fiok: sosem lehet cel', () => {
    // Nincs `email` mezoje, tehat a cim-keresesnek at kell lepnie rajta.
    expect(celFiok(store, 'lackor2', 'lackor2@gmail.com').account).not.toBe('_default')
  })
})

describe('a jovahagyo link MEGNEVEZI a fiokot', () => {
  const py = readFileSync(SCRIPT, 'utf8')

  it('login_hint kerul a linkbe', () => {
    // A gep tudja, melyik fiokrol van szo. Ha nem adja at, a fiokvalaszto
    // helyes sorat a felhasznalonak kell fejbol eltalalnia -- tizszer egymas
    // utan. Egyszer elrontani eleg.
    expect(py).toContain('login_hint')
  })

  it('meglevo fioknal a TAROLT cim a tipp, kulon parameter nelkul is', () => {
    const fn = /def _build_url\(account, hint=None\)[\s\S]*?\n\ndef /.exec(py)?.[0] ?? ''
    expect(fn, 'nem talalom a _build_url-t').toContain('_load_tokens()')
    expect(fn).toContain('rec["email"]')
  })

  it('a kezelo beirt cime uj fioknal is atmegy', () => {
    expect(py).toMatch(/def cmd_auth\(account, hint=None\)/)
    expect(py).toMatch(/sys\.argv\[3\] if len\(sys\.argv\) > 3 else None/)
    expect(route).toMatch(/const hint = wanted\.includes\('@'\) \? wanted : ''/)
    expect(route).toContain('hint })')
  })

  it('csak cimnek latszo tippet adunk at a szkriptnek', () => {
    expect(runner).toMatch(/\[SCRIPT, 'auth', id, hint\]/)
    expect(runner).toMatch(/\[SCRIPT, 'auth', id\]/)
    expect(runner).toContain('@')
  })
})

describe('a sikeres bejelentkezes AZONNAL latszik a mert allapotban', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mv-live-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const ir = (data: unknown) => writeFileSync(join(dir, GOOGLE_LIVE_FILE), JSON.stringify(data))

  it('a halottnak mert fiok elore vall, amint bejelentkeztek vele', () => {
    // Enelkul a friss fiok a kovetkezo oras meresig "halott" maradna: az
    // Attekintes tovabbra is felsorolna, es a vegigvezeto ujra felajanlana --
    // pont ez tolta el a sorrendet 2026-08-22-en.
    ir({ checkedAt: 1, accounts: [{ id: 'a', ok: false, kind: 'expired' }, { id: 'b', ok: false, kind: 'expired' }] })
    markGoogleLiveOk('a', dir)
    const d = readGoogleLiveCheck(dir)!
    expect(d.accounts.find(x => x.id === 'a')).toMatchObject({ ok: true, kind: null })
    expect(d.accounts.find(x => x.id === 'b'), 'a tobbit nem nyulja').toMatchObject({ ok: false })
  })

  it('a meg sosem mert fiok bekerul', () => {
    ir({ checkedAt: 1, accounts: [] })
    markGoogleLiveOk('uj', dir)
    expect(readGoogleLiveCheck(dir)!.accounts).toEqual([{ id: 'uj', ok: true, kind: null }])
  })

  it('meres nelkul NEM talal ki egy ures merest', () => {
    // Egy "minden rendben" latszatot csinalni a semmibol rosszabb a
    // nem-tudomnal: pont azt a sort tuntetne el, amiert ez az egesz keszult.
    markGoogleLiveOk('a', dir)
    expect(readGoogleLiveCheck(dir)).toBeNull()
  })

  it('ures fiok-nevre nem ir', () => {
    ir({ checkedAt: 1, accounts: [{ id: 'a', ok: false, kind: 'expired' }] })
    markGoogleLiveOk('   ', dir)
    expect(readGoogleLiveCheck(dir)!.accounts[0]).toMatchObject({ ok: false })
  })

  it('mindket bejelentkezesi ut elkonyveli -- a beillesztos ES a bongeszos', () => {
    // A bongeszos (loopback) ut sehol maserre nem jelenti be a sikert, csak az
    // allapot-lekerdezesben; ha ott nem konyveljuk el, csak a felenel javul a
    // lap.
    expect(route).toMatch(/if \(st\.phase === 'done' && st\.accountId\) markGoogleLiveOk\(st\.accountId\)/)
    expect(route).toMatch(/if \(result\.ok && result\.accountId\) markGoogleLiveOk\(result\.accountId\)/)
    expect(runner).toMatch(/accountId: savedAs \|\| mine\.accountId/)
  })
})

describe('ha a duplikatum megis eloall, az Attekintes SZOL', () => {
  // A megelozes (login_hint + cim szerinti slot-valasztas) az uj eseteket
  // zarja ki. De egy duplikatum, ami MAR letezik -- regi telepitesen, kezi
  // szerkesztesbol, vagy egy utbol, amire nem gondoltunk --, onmagatol sosem
  // tunik el, es kozben nema: a lap ket zold fiokot mutat, mikozben a
  // beallitasok fele a halott peldanyra hivatkozik.
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mv-dup-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const ir = (data: unknown) => writeFileSync(join(dir, 'google-tokens.json'), JSON.stringify(data))

  it('ket slot egy cimre -> figyelmezteto sor, MEGNEVEZVE mindkettot', () => {
    ir({
      _default: 'lackor2',
      usalackor: { email: 'usalackor@gmail.com' },
      usalackor_2: { email: 'usalackor@gmail.com' },
      lackor3: { email: 'lackor3@gmail.com' },
    })
    const rows = googleDuplicateRows(dir)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'google_dup', status: 'warn' })
    expect(rows[0].params).toMatchObject({ n: 1 })
    // A nevek nelkul a sor nem teendo, hanem rejtveny: tiz fiok mellett tudni
    // kell, MELYIK kettot kell osszevonni.
    expect(String(rows[0].params?.names)).toContain('usalackor + usalackor_2')
    expect(String(rows[0].params?.names)).not.toContain('lackor3')
  })

  it('a mert eset: het par egy sorban, het darabszammal', () => {
    // Pontosan az az allas, ami 2026-08-22-en eloallt.
    const store: Record<string, unknown> = { _default: 'lackor2' }
    for (const n of ['lackor2', 'usalackor', 'lackor3', 'canadalackor', 'daytraderboss', 'lackor4', 'lackor5']) {
      store[n] = { email: `${n}@gmail.com` }
      store[`${n}_2`] = { email: `${n}@gmail.com` }
    }
    ir(store)
    const rows = googleDuplicateRows(dir)
    expect(rows[0].params).toMatchObject({ n: 7 })
  })

  it('a cimet kisbetusen vetjuk ossze -- a Gmail sem tesz kulonbseget', () => {
    ir({ a: { email: 'Boss@Gmail.com' }, b: { email: ' boss@gmail.com ' } })
    expect(googleDuplicateRows(dir)).toHaveLength(1)
  })

  it('kulon cimek: egy szo sem', () => {
    ir({ _default: 'a', a: { email: 'a@gmail.com' }, b: { email: 'b@gmail.com' } })
    expect(googleDuplicateRows(dir)).toEqual([])
  })

  it('cim nelkuli rekordokbol NEM csinalunk duplikatumot', () => {
    // Cim nelkul ket rekord lehet ket kulonbozo fiok is: az egyik meg nem volt
    // sikeres bejelentkezesen, a masiknal a cim-lekerdezes bukott el. Egy
    // talalgatasbol szuletett riasztas rosszabb a hallgatasnal -- azt tanitja
    // meg, hogy ezt a sort at lehet lapozni.
    ir({ a: { refresh_token: 'x' }, b: { refresh_token: 'y' }, c: { email: '' } })
    expect(googleDuplicateRows(dir)).toEqual([])
  })

  it('a `_default` mutato nem fiok', () => {
    // Sztring, nem objektum -- es a nevet sem szabad fiokkent felsorolni.
    ir({ _default: 'a', a: { email: 'a@gmail.com' } })
    expect(googleDuplicateRows(dir)).toEqual([])
  })

  it('fajl nelkuli (friss) telepitesen nincs mirol szolni', () => {
    expect(googleDuplicateRows(dir)).toEqual([])
    writeFileSync(join(dir, 'google-tokens.json'), 'nem json')
    expect(googleDuplicateRows(dir), 'romlott fajltol sem esik szet').toEqual([])
  })

  it('a lemezrol jott nev tisztitva megy a feluletre', () => {
    // A kliens a params-t escape NELKUL rendereli, a kulcs pedig lemezrol jon.
    ir({ '<img src=x onerror=alert(1)>': { email: 'a@gmail.com' }, a: { email: 'a@gmail.com' } })
    const nev = String(googleDuplicateRows(dir)[0].params?.names)
    expect(nev).not.toContain('<')
    expect(nev).not.toContain('>')
  })

  it('a sor be van kotve az Attekintes onellenorzesebe, mindket nyelven', () => {
    const health = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'system-health.ts'), 'utf8')
    expect(health, 'a fuggveny letezese onmagaban semmit nem er, ha senki nem hivja')
      .toContain('...googleDuplicateRows(),')
    for (const f of ['hu.js', 'en.js']) {
      const lang = readFileSync(join(PROJECT_ROOT, 'web', 'lang', f), 'utf8')
      expect(lang, f).toContain("'health.google_dup':")
      // A leiras a TEENDOT mondja meg; enelkul a sor csak ijesztget.
      expect(lang, f).toContain("'health.google_dup_action':")
    }
  })
})
