/**
 * DRIVE-MAPPA VALASZTO (Depó oldal, "Drive-mappák a gépemen").
 *
 * Boss, 2026-08-15: "nem lehet azt is megoldani hogy ki lehessen valasztani a
 * drive oldalrol a mappa azonositot meg a mappa nevet? miert kezzel kell
 * beirnia a komuvesnek mindig mindent?"
 *
 * Amit ez a fajl orzii:
 *   1. A mappa-azonositot NEM kell begepelni: nincs lathato beviteli mezoje.
 *   2. A valasztas nelkuli "Hozzáadás" nem indulhat el (a gomb alapbol tiltott).
 *   3. Fiokvaltaskor a korabbi valasztas eldobodik -- egy azonosito csak abban a
 *      fiokban ervenyes, amelyikben kivalasztottuk.
 *   4. A felajanlott mappanev PONTOSAN az, ami a lemezre kerul: a kliens-oldali
 *      _dpSafeName ugyanazt adja, mint a kiszolgalo safeSegment().
 *   5. A gyokeret ("Saját meghajtó") nem lehet kivalasztani -- azzal az EGESZ
 *      Drive-ot huznank le.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { safeSegment } from '../web/routes/drive-sync.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')

/** Egy fuggveny torzse az app.js-bol, zarojel-parositassal. */
function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  const i = src.indexOf('{', start.index)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start.index, j + 1) }
  }
  throw new Error(`nem zarodik: ${name}`)
}

describe('a mappa-azonositot nem kell kezzel beirni', () => {
  it('nincs lathato azonosito-mezo, csak rejtett -- a valaszto tolti ki', () => {
    const m = /<input[^>]*id="depoSyncFolderId"[^>]*>/.exec(html)
    expect(m, 'nincs depoSyncFolderId a markupban').toBeTruthy()
    expect(m![0]).toContain('type="hidden"')
    expect(m![0]).not.toContain('placeholder')
  })

  it('van "Drive-mappa kiválasztása" gomb, es az nyitja a valasztot', () => {
    expect(html).toContain('id="depoSyncPickBtn"')
    expect(app).toContain("bind('depoSyncPickBtn', () => _depoPickDriveFolder())")
    expect(extractFn(app, '_depoPickDriveFolder')).toContain('openDrivePicker(account,')
  })

  it('a "Hozzáadás" alapbol tiltott: valasztas nelkul nincs mit hozzaadni', () => {
    const m = /<button[^>]*id="depoSyncAddBtn"[^>]*>/.exec(html)
    expect(m).toBeTruthy()
    expect(m![0]).toContain('disabled')
    expect(extractFn(app, '_depoClearDrivePick')).toContain('add.disabled = true')
  })

  it('fiokvaltaskor eldobjuk a korabbi valasztast', () => {
    const f = extractFn(app, 'loadDepoPage')
    expect(f).toContain("acc.addEventListener('change', () => _depoClearDrivePick())")
  })

  it('a valaszto a kivalasztott fiokban nez -- nem egy rogzitett fiokban', () => {
    expect(extractFn(app, '_dpLoad')).toContain("'&account=' + encodeURIComponent(_dpAccount)")
  })
})

describe('a fioklegordulo fuggetlen a depo allapotatol', () => {
  // Ez VALODI hiba volt: a fioklista feltoltese a _depoRefresh legvegen allt,
  // a `/api/depot/status` lekerdezese UTAN -- amelynek a hibaaga `return`-nel
  // kilep. Ha tehat a depo-allapot barmiert nem jott meg, a legordulo URESEN
  // maradt, a "Drive-mappa kiválasztása" gomb meg annyit mondott, hogy "Előbb
  // válaszd ki, melyik fiókból nézzük" -- pedig nem volt mit valasztani.
  it('a fioklistat kulon fuggveny tolti, nem a _depoRefresh vege', () => {
    expect(app).toContain('async function _depoLoadSyncAccounts()')
    expect(extractFn(app, '_depoLoadSyncAccounts')).toContain("_depoGet('/api/drive/accounts')")
  })

  it('a fioklista a depo-allapot ELOTT indul (nem az utan)', () => {
    const f = extractFn(app, '_depoRefresh')
    const fiok = f.indexOf('_depoLoadSyncAccounts()')
    const allapot = f.indexOf("_depoGet('/api/depot/status')")
    expect(fiok, 'nem hivja a fioklista-toltot').toBeGreaterThan(-1)
    expect(fiok, 'a fioklista megint a depo-allapot utan tolt').toBeLessThan(allapot)
  })

  it('a _depoRefresh mar NEM tolti maga a legordulot', () => {
    // Kulonben ket helyen allna ugyanaz, es a regi (rossz) helyen levo elavulna.
    const f = extractFn(app, '_depoRefresh')
    expect(f).not.toContain("_depoGet('/api/drive/accounts')")
  })

  it('ha nem sikerul a fioklista, azt KIIRJA (nem nyeli le nemAn hibat)', () => {
    const f = extractFn(app, '_depoLoadSyncAccounts')
    expect(f).toContain("t('dsync.accounts_failed'")
    expect(f).toContain("t('dsync.no_accounts')")
  })

  it('ket egyszerre futo toltes nem rajzolja ujra a legordulot', () => {
    // A _depoRefresh tobb helyrol is jon (gomb, munka-figyelo, mentes utan). Egy
    // masodik ujrarajzolas VISSZAALLITANA a kivalasztott fiokot az elsore.
    const f = extractFn(app, '_depoLoadSyncAccounts')
    expect(f).toContain('_depoAccountsLoading')
    expect(f).toMatch(/finally \{[\s\S]*_depoAccountsLoading = false/)
    expect(app).toContain('var _depoAccountsLoading')
    expect(app).not.toContain('let _depoAccountsLoading')
  })
})

describe('a kepernyo MEGMONDJA, mi mire valo (hulyebiztos leiras)', () => {
  // Boss 2026-08-15: "de hogy miert es mit kell kivalasztani a jobbra levo
  // drive mappa kivalasztasa menu alatt? fogalmam sincsen" + "hulyebiztosan
  // kell leirni hogy mi mire valo es mit kell honnan kivalasztani".
  // A gombsor korabban cimke nelkul allt: egy legordulo es ket gomb.
  const nyelvek = ['hu', 'en'].map((n) => readFileSync(join(ROOT, 'web', 'lang', `${n}.js`), 'utf8'))

  it('a doboz elmondja, MIRE VALO -- markupos kulcsbol, hogy nyelvvaltaskor is megmaradjon', () => {
    expect(html).toContain('data-i18n-html="dsync.what_html"')
    // `data-i18n` (nem -html) a textContent-et irna felul, es a felkoveresek
    // eltunnenek az elso nyelvi sopresnel.
    expect(html).not.toContain('data-i18n="dsync.what_html"')
    for (const l of nyelvek) expect(l).toContain("'dsync.what_html'")
  })

  it('a fo uton EGYETLEN kerdes van: melyik fiok', () => {
    for (const kulcs of ['dsync.step1', 'dsync.whole_btn', 'dsync.only_one', 'dsync.only_one_hint']) {
      expect(html, kulcs).toContain(`data-i18n="${kulcs}"`)
      for (const l of nyelvek) expect(l, kulcs).toContain(`'${kulcs}'`)
    }
    // A kerdes cimkeje a legordulohoz TARTOZIK (kattintasra is odavisz).
    expect(html).toMatch(/<label for="depoSyncAccount"[^>]*data-i18n="dsync\.step1"/)
    // A regi, szamozott harom lepes MEGSZUNT: mappat mar nem kell valasztani.
    // Boss 2026-08-15: "tehat ne kelljen kivalasztani itt mappakat. az nem kell ide."
    for (const regi of ['dsync.step2', 'dsync.step3', 'dsync.step_hint', 'dsync.name_label']) {
      expect(html, regi).not.toContain(regi)
    }
  })

  it('a valaszto ablak megmondja, mit kell ott csinalni', () => {
    expect(html).toContain('data-i18n-html="dpick.lead_html"')
    expect(html).toContain('data-i18n="dpick.here_label"')
    for (const l of nyelvek) {
      expect(l).toContain("'dpick.lead_html'")
      expect(l).toContain("'dpick.here_label'")
    }
  })

  it('a gyokerben kiirja, MIERT nem valaszthato es mi a teendo', () => {
    // Enelkul csak egy szurke gombot lat, es nem tudja, mit rontott el.
    expect(extractFn(app, '_dpLoad')).toContain("else reszek.push(t('dpick.root_hint'))")
    for (const l of nyelvek) expect(l).toContain("'dpick.root_hint'")
  })
})

describe('TELJES szinkron: az egesz Drive egyben', () => {
  // Boss, 2026-08-15: "mit akarok szinkronizalni. hat a lackor2 drivot
  // mindenestul! akkor itt nincs tovabb kerdes semmi." + "total szinkron. meg a
  // fa struktura is ugyanaz legyen" + "a gepeden ez legyen a mappa neve -- az
  // sem kell. legyen csak ugyanaz mint fent a neten ... igy nincs keveredes."
  const nyelvek = ['hu', 'en'].map((n) => readFileSync(join(ROOT, 'web', 'lang', `${n}.js`), 'utf8'))

  it('van EGY gomb, ami az egesz Drive-ot hozza le', () => {
    expect(html).toContain('id="depoSyncWholeBtn"')
    expect(app).toContain("bind('depoSyncWholeBtn', () => _depoAddWholeDrive())")
  })

  it('a gomb a gyokeret kuldi, URES nevvel -- se mappavalasztas, se nevadas', () => {
    const f = extractFn(app, '_depoAddWholeDrive')
    expect(f).toContain("folderId: 'root'")
    expect(f).toContain("name: ''")
    // A valasztot NEM nyitja meg: ez pont az, amit a Boss nem akart latni.
    expect(f).not.toContain('openDrivePicker')
  })

  it('sok fajl, sok ido: elotte megkerdezi', () => {
    expect(extractFn(app, '_depoAddWholeDrive')).toContain("confirm(t('dsync.whole_confirm'")
    for (const l of nyelvek) expect(l).toContain("'dsync.whole_confirm'")
  })

  it('a nevado mezo eltunt a kepernyorol (a nev a fioke, illetve a Drive-mappae)', () => {
    // Ha at lehetne irni, ket fiok tartalma osszekeveredhetne -- eppen ettol
    // tartott a Boss: "kesobb veletlenul nem fogja a lackor2 interneten levo
    // mappakat az usalackor-ra szinkronizalni csak mert megvaltoztatta a nevet".
    const m = /<input[^>]*id="depoSyncName"[^>]*>/.exec(html)
    expect(m, 'nincs depoSyncName a markupban').toBeTruthy()
    expect(m![0]).toContain('type="hidden"')
    expect(html).not.toContain('id="depoSyncNameRow"')
    // A hozzaadas sem kerhet nevet: nincs, aki begepelje.
    expect(extractFn(app, '_depoAddSync')).not.toContain("t('dsync.need_name')")
  })

  it('a listaban NEM ures cella all a teljes Drive helyen', () => {
    expect(extractFn(app, '_depoRefresh')).toContain("p.name || t('dsync.whole_row')")
    for (const l of nyelvek) expect(l).toContain("'dsync.whole_row'")
  })

  it('a hibat kimondja, nem nyeli le', () => {
    const f = extractFn(app, '_depoAddWholeDrive')
    expect(f).toContain('showToast(')
    expect(f).toMatch(/finally \{[\s\S]*disabled = false/)
  })
})

describe('a Drive-valaszto ablak jarata', () => {
  it('a gyokeret magat nem itt valasztjuk (arra sajat gomb van a kartyan)', () => {
    const f = extractFn(app, '_dpLoad')
    expect(f).toContain('ok.disabled = _dpStack.length <= 1')
    expect(extractFn(app, '_dpConfirm')).toContain('if (!cur || _dpStack.length <= 1) return')
  })

  it('csak MAPPAK kozott lehet lepkedni (fajlt nem lehet szinkronizalni)', () => {
    expect(extractFn(app, '_dpLoad')).toContain('files.filter((f) => f.isFolder)')
  })

  it('sikertelen megnyitas utan a "Vissza" nem visz sehova nem letezo helyre', () => {
    // A verembol ki kell venni azt a mappat, ahova be sem jutottunk.
    const f = extractFn(app, '_dpLoad')
    expect(f).toMatch(/catch \(e\) \{[\s\S]*if \(_dpStack\.length > 1\) _dpStack\.pop\(\)/)
  })

  it('a kezi azonositot ugyanaz a szabaly szuri, mint a kiszolgalon', () => {
    // isSafeFolderId (drive-browser.ts): /^[A-Za-z0-9_-]{1,256}$/
    expect(extractFn(app, '_dpOpenManual')).toContain('/^[A-Za-z0-9_-]{1,256}$/.test(id)')
  })

  it('az azonositoval nyitott mappat JELZO kiseri, nem a kiirt szoveg', () => {
    // A "Beírt mappa" felirat angolul mas ("Folder by ID") -- egy szoveg-
    // osszehasonlitas ott csendben elromlana (ez a hiba mar megvolt a gepi
    // valasztoban: `textContent === 'Saját gép'`).
    expect(extractFn(app, '_dpOpenManual')).toContain("_dpEnter(id, t('dpick.manual_name'), true)")
    expect(extractFn(app, '_dpConfirm')).toContain('manual: !!cur.manual')
    // A nev-mezo megszunt, de a JELZO-nek maradt dolga: az azonositoval nyitott
    // mappa neve mindenkinel ugyanaz a helykitolto lenne ("Beírt mappa"), es ket
    // ilyen mappa UGYANABBA a helyi mappaba erkezne. Ezert kap azonosito-vegzodest.
    expect(extractFn(app, '_depoPickDriveFolder')).toContain('f.manual ?')
    expect(extractFn(app, '_depoPickDriveFolder')).toContain("String(f.id).slice(0, 8)")
  })

  it('a keson beeso valasz nem irhatja felul a frissebb mappat', () => {
    const f = extractFn(app, '_dpLoad')
    expect(f).toContain('const seq = ++_dpSeq')
    // Ket helyen kell ellenorizni: a hibaagon is, kulonben egy keson beeso
    // HIBA torolne a kozben mar betoltott jo listat.
    expect(f.match(/if \(seq !== _dpSeq\) return/g) || []).toHaveLength(2)
  })

  it('kimondja, ha nem fert bele minden elem a listaba', () => {
    // A kiszolgalo 200 elemet ker le (pageSize=200). Enelkul ugy tunne, hogy a
    // hianyzo mappa nem letezik.
    expect(extractFn(app, '_dpLoad')).toContain("if (files.length >= 200) reszek.push(t('dpick.truncated'))")
  })

  it('az allapot-valtozok hoistolhatok (var) -- a korai hivas ne dobjon hibat', () => {
    // Ugyanaz a csapda, mint a _depoPoll-nal (web-boot-order.test.ts).
    for (const v of ['_dpStack', '_dpAccount', '_dpOnPick', '_dpSeq']) {
      expect(app, v).toContain(`var ${v} `)
      expect(app, v).not.toContain(`let ${v} `)
    }
  })
})

describe('a felajanlott nev PONTOSAN az, ami a lemezre kerul', () => {
  // A kliens-oldali mas kifejezes ugyan, de ugyanazt kell adnia, mint a
  // kiszolgalo safeSegment()-je -- kulonben a mezoben "Fotók/2026" allna,
  // a lemezen meg "Fotók_2026", es a user mast latna, mint amit kap.
  const dpSafeName = new Function(`${extractFn(app, '_dpSafeName')}; return _dpSafeName`)() as (s: string) => string

  const esetek = [
    'Fotók',
    'Szerződés 2026 március.pdf',
    'a/b',
    'a\\b',
    'a:b?c*d',
    '..',
    '.',
    '   ',
    '',
    'vege pont.',
    'szokoz a vegen   ',
    'x'.repeat(200),
    'idezojel"es<jelek>|pipa',
  ]

  for (const e of esetek) {
    it(`ugyanaz, mint a kiszolgalon: ${JSON.stringify(e.slice(0, 30))}`, () => {
      expect(dpSafeName(e)).toBe(safeSegment(e))
    })
  }

  it('vezerlokaraktereket is ugyanugy szur', () => {
    const nev = 'a\u0000b\u001fc\u007fd'
    expect(dpSafeName(nev)).toBe(safeSegment(nev))
    expect(dpSafeName(nev)).toBe('abcd')
  })
})
