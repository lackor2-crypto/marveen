/**
 * Az ELO Google-ellenorzes: a lyuk, amin 2026-08-22-en egy teljes kieses
 * hangtalanul elfert.
 *
 * A mert allapot aznap: mind a 10 Google-fiok `invalid_grant`-ot adott, es
 * SEMMI nem szolt rola. Harom fuggetlen retegen csuszott at ugyanaz:
 *   - a lejarat-figyelo fajl-alapu, tehat szerkezetileg vak a visszavonasra,
 *   - az elo probe csak akkor fut, ha valaki megnyitja a Fiokok oldalt,
 *   - a python hibaja sehova nem kerul (10 nap naplo, NULLA `invalid_grant`).
 *
 * Boss: "mostmar veglegesen koss be mindent es ne legyen nyitott semmi!"
 *
 * Ezek a tesztek azt tartjak a helyen, hogy (1) a mereseredmenybol sor lesz az
 * onellenorzesben, (2) a HAROM hibamod HAROM kulon sor marad -- osszevonva a
 * legrosszabb eset (all az ellenorzo) pont ugy nezne ki, mint a legjobb --, es
 * (3) a felulet nem csak KIIRJA a bajt, hanem helyben el is vegezteti a
 * javitast.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { googleLiveRows, googleAccountCount, GOOGLE_LIVE_STALE_MS } from '../web/system-health.js'
import { readGoogleLiveCheck, GOOGLE_LIVE_FILE } from '../web/google-live-check.js'

const ORA = 60 * 60 * 1000
const NOW = Date.parse('2026-08-22T12:00:00Z')

/** Egy ep meresi eredmeny, `kora` ezredmasodperccel ezelottrol. */
function meres(kora: number, accounts: { id: string; ok: boolean; kind?: string | null }[]) {
  return { checkedAt: NOW - kora, accounts }
}

describe('googleLiveRows -- a harom hibamod harom kulon sor', () => {
  it('fiok nelkuli telepitesen HALLGAT', () => {
    // Nincs mit ellenorizni, es nincs mirol szolni: egy friss telepitesen a
    // "nem ellenoriztem" sor csak zaj lenne.
    expect(googleLiveRows(NOW, null, 0)).toEqual([])
    expect(googleLiveRows(NOW, meres(0, []), 0)).toEqual([])
  })

  it('van fiok, de meres MEG SOSEM futott -> szol', () => {
    // Pontosan ez az allapot allt fenn egesz nap, amig a hozzaferes halott
    // volt. Ez NEM "minden rendben".
    const rows = googleLiveRows(NOW, null, 3)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('google_live_never')
    expect(rows[0].status).toBe('warn')
  })

  it('romlott eredmenyfajl ugyanugy "nem tudom", nem "rendben"', () => {
    expect(googleLiveRows(NOW, { checkedAt: NOW } as never, 3)[0].id).toBe('google_live_never')
    expect(googleLiveRows(NOW, { accounts: [] } as never, 3)[0].id).toBe('google_live_never')
  })

  it('friss meres, minden fiok el -> ZOLD sor, szammal', () => {
    // A zold sor nem dekoracio: enelkul a hallgatas nem megkulonboztetheto a
    // nem-futo ellenorzestol -- ez volt a hiba alakja.
    const rows = googleLiveRows(NOW, meres(ORA, [
      { id: 'lackor2', ok: true }, { id: 'usalackor', ok: true },
    ]), 2)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('google_live_ok')
    expect(rows[0].status).toBe('ok')
    expect(rows[0].params).toMatchObject({ n: 2, h: 1 })
  })

  it('elutasitott fiok -> PIROS sor, es MEGNEVEZI, melyik', () => {
    // Tiz cimnel a "egy fiok lejart" nem elvegezheto utasitas: a vegigvezeto
    // ebbol a listabol tudja, mit kell egyesevel ujracsatlakoztatni.
    const rows = googleLiveRows(NOW, meres(ORA, [
      { id: 'lackor2', ok: false, kind: 'expired' },
      { id: 'usalackor', ok: true },
      { id: 'lackor3', ok: false, kind: 'expired' },
    ]), 3)
    const bad = rows.find(r => r.id === 'google_live_bad')
    expect(bad, 'nincs piros sor').toBeTruthy()
    expect(bad!.status).toBe('bad')
    expect(bad!.params).toMatchObject({ n: 2, all: 3, names: 'lackor2, lackor3' })
    // Es ilyenkor NEM allitja egyszerre, hogy minden rendben.
    expect(rows.some(r => r.id === 'google_live_ok')).toBe(false)
  })

  it('a fiok neve LEMEZROL jon, ezert megtisztitva kerul a sorba', () => {
    // A sor parameterei a felulten HTML-kent jelennek meg; egy lemezrol jott
    // nev sose vihessen be jelolest.
    const rows = googleLiveRows(NOW, meres(ORA, [
      { id: '<img src=x onerror=alert(1)>', ok: false },
    ]), 1)
    const names = String(rows.find(r => r.id === 'google_live_bad')!.params!.names)
    expect(names).not.toContain('<')
    expect(names).not.toContain('>')
  })

  it('allo ellenorzo: 3 ora utan figyelmeztet, 24 ora utan mar piros', () => {
    // A legalattomosabb eset: a tobbi sor ilyenkor egy REGI pillanatrol
    // szolna, magabiztosan.
    const friss = googleLiveRows(NOW, meres(GOOGLE_LIVE_STALE_MS - 1000, [{ id: 'a', ok: true }]), 1)
    expect(friss.some(r => r.id === 'google_live_stale')).toBe(false)

    const allo = googleLiveRows(NOW, meres(5 * ORA, [{ id: 'a', ok: true }]), 1)
    const s = allo.find(r => r.id === 'google_live_stale')
    expect(s?.status).toBe('warn')
    expect(s?.params).toMatchObject({ h: 5 })

    const halott = googleLiveRows(NOW, meres(30 * ORA, [{ id: 'a', ok: true }]), 1)
    expect(halott.find(r => r.id === 'google_live_stale')?.status).toBe('bad')
  })

  it('allo ellenorzonel NEM mondja rá, hogy minden rendben', () => {
    // Kulonben egy hete allo meres alapjan allitanank, hogy a fiokok elnek.
    const rows = googleLiveRows(NOW, meres(30 * ORA, [{ id: 'a', ok: true }]), 1)
    expect(rows.some(r => r.id === 'google_live_ok')).toBe(false)
  })

  it('allo ellenorzo ES elutasitott fiok: MINDKETTO kiirodik', () => {
    const rows = googleLiveRows(NOW, meres(5 * ORA, [{ id: 'a', ok: false }]), 1)
    expect(rows.map(r => r.id).sort()).toEqual(['google_live_bad', 'google_live_stale'])
  })
})

describe('a fajl, amibol a sor keszul', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glc-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('hianyzo fajl -> null (nem kivetel, nem "rendben")', () => {
    expect(readGoogleLiveCheck(dir)).toBeNull()
  })

  it('felbeszakadt iras (fel-JSON) -> null', () => {
    // A ket lepeses iras eppen ezt kerulné el, de a beolvasas akkor sem
    // hihet el egy csonkot.
    writeFileSync(join(dir, GOOGLE_LIVE_FILE), '{"checkedAt":1234,"accou')
    expect(readGoogleLiveCheck(dir)).toBeNull()
  })

  it('ep fajl visszaolvashato', () => {
    writeFileSync(join(dir, GOOGLE_LIVE_FILE), JSON.stringify(meres(0, [{ id: 'a', ok: true }])))
    expect(readGoogleLiveCheck(dir)?.accounts).toHaveLength(1)
  })

  it('a bekotott fiokok szama a token-fajlbol jon, a `_` kulcsok nelkul', () => {
    expect(googleAccountCount(dir)).toBe(0)
    writeFileSync(join(dir, 'google-tokens.json'), JSON.stringify({
      lackor2: {}, usalackor: {}, _default: 'lackor2',
    }))
    expect(googleAccountCount(dir)).toBe(2)
  })

  it('romlott token-fajl 0-t ad, nem dob kivetelt', () => {
    mkdirSync(join(dir, 'ures'), { recursive: true })
    writeFileSync(join(dir, 'ures', 'google-tokens.json'), 'nem json')
    expect(googleAccountCount(join(dir, 'ures'))).toBe(0)
  })
})

// === A felulet ==============================================================
//
// Boss, 2026-08-22: "es ha most ez problema akkor az onnellenorzes szoljon es
// vezessen vegig a folyamaton hogy mit kell csinalni. linkek kel. hova kell
// felmenni. vagy ha auth tal akor adjon kodot linket amit a bongeszobe kell
// megnyitni es visszakapok kodot. [...] hulyebiztosan!"
//
// A felulet nincs lefedve futtatott teszttel, ezert a forrast olvassuk: ez nem
// azt bizonyitja, hogy szep, hanem azt, hogy a megkovetelt viselkedes nem esik
// ki csendben egy kesobbi atirasnal.
const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'en.js'), 'utf8')
const route = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'connections.ts'), 'utf8')
const index = readFileSync(join(PROJECT_ROOT, 'src', 'index.ts'), 'utf8')
const renderer = /async function renderOverviewConnections\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''

describe('az Attekintes onellenorzese bekoti az elo Google-ellenorzest', () => {
  it('a meres MAGATOL fut, nem csak akkor, ha valaki megnyit egy oldalt', () => {
    // Ez volt a masodik reteg, amin atcsuszott: az elo probe letezett, csak
    // senki nem inditotta el.
    expect(index).toContain('startGoogleLiveCheck')
    expect(index).toMatch(/googleLiveInterval\s*=\s*startGoogleLiveCheck\(\)/)
    // Es leallaskor le is all -- kulonben az ujraindulas ket idozitot hagyna.
    expect(index).toMatch(/clearInterval\(googleLiveInterval\)/)
  })

  it('a "nem el a hozzaferes" sor VEGIGVEZETOT nyit, megnevezett fiokokkal', () => {
    expect(renderer).toContain("h.id === 'google_live_bad'")
    const g = /guide: h\.id === 'google_live_bad'[\s\S]*?: null,/.exec(renderer)?.[0] ?? ''
    expect(g, 'nem talalom a vegigvezeto agat').toContain('accounts:')
    expect(g).toContain("id: 'google:live'")
  })

  it('a "meg sosem futott" es a "megallt" sor GOMB, nem teendo', () => {
    // Ha a Fiokok oldalra dobnank, pont azt kellene kitalalnia, amit mi mar
    // tudunk: hogy mit nyomjon meg.
    expect(renderer).toMatch(/google_live_never'\s*\|\|\s*h\.id === 'google_live_stale'/)
    expect(renderer).toContain('runGoogleLiveCheckNow()')
    expect(app).toMatch(/async function runGoogleLiveCheckNow\(\)/)
    expect(app).toContain("'/api/connections/google/live-check'")
  })

  it('a piros sor ELORE kerul, nem szorul az "Egyeb" dobozba', () => {
    // A kartya merev negy dobozos (Boss, 2026-08-21/22). Tiz lejarat-sor melle
    // szorulva pont az a sor tunne el, amelyik a javitason vegigvezet.
    expect(renderer).toMatch(/if \(h\.id === 'google_live_bad'\) rows\.unshift\(rows\.pop\(\)\)/)
  })

  it('nem all KET sor ugyanarrol a tenyrol', () => {
    // A "hibas fiokok" sor ugyanazt allitana, csak rosszabbul: nem nevez meg
    // fiokot, es a Fiokok oldalra dob a vegigvezeto helyett. Egy dobozt venne
    // el a negybol.
    expect(renderer).toContain('eloRossz')
    expect(renderer).toMatch(/d\.google\.broken > 0 && !eloRossz/)
  })

  it('a jo hir is ki van mondva: van ZOLD sor is', () => {
    expect(renderer).toContain("health.google_live_ok")
    expect(renderer).toMatch(/greenRows\.push\(\{\s*label: t\('health\.google_live_ok'/)
  })

  it('a "futtasd le most" vegpont letezik, es egyszerre csak egy kor fut', () => {
    expect(route).toContain("'/api/connections/google/live-check'")
    expect(route).toContain('runGoogleLiveCheckOnce')
  })
})

describe('a vegigvezeto HELYBEN elvegzi az ujracsatlakoztatast', () => {
  const steps = /function _guideSteps\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''

  it('ha tudjuk, melyik fiokrol van szo, nem kuldjuk sehova', () => {
    expect(steps.length, 'nem talalom a _guideSteps-et').toBeGreaterThan(200)
    expect(steps).toContain('_guideAccountIds')
    expect(steps).toContain('auth: true')
  })

  it('a fiok-nevek a sorbol ES a lejarat-azonositobol is kiolvashatok', () => {
    const ids = /function _guideAccountIds\(target\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(ids).toContain('target.accounts')
    expect(ids).toContain("id.slice('google:'.length)")
    // A regi, egyfiokos levelkuldo token nem ezen a folyamaton ujul meg --
    // ott a felhasznalo hiaba keresne a fiokok kozott egy sort, ami nincs ott.
    expect(ids).toContain("google:legacy")
  })

  it('a folyamat mind a HAROM lepese megvan: inditas, link, visszakapott kod', () => {
    expect(app).toMatch(/async function guideAuthStart\(force\)/)
    expect(app).toContain("'/api/connections/google/login'")
    expect(app).toContain("'/api/connections/google/login/paste'")
    expect(app).toMatch(/async function guideAuthPasteSubmit\(\)/)
    // A link haromfelekeppen elerheto: gomb, masolas, kijelolheto mezo.
    expect(app).toContain('guide.auth_open_btn')
    expect(app).toContain('guide.auth_copy_btn')
    expect(app).toContain('guideAuthUrl')
  })

  it('tobb fiokot EGYESEVEL visz vegig, szamlaloval', () => {
    // Tiz halott hozzaferesnel egy "csatlakoztasd ujra" onmagaban nem
    // elvegezheto utasitas.
    expect(app).toMatch(/function guideAuthNext\(\)/)
    expect(app).toContain('guide.auth_progress')
    expect(app).toMatch(/st\.idx \+ 1 < st\.accounts\.length/)
  })

  it('a Google elutasitasat MEGNEVEZI, nem "nem sikerult"-nek mondja', () => {
    expect(app).toContain("st.blocked === 'test-user'")
    expect(app).toContain('guide.auth_blocked')
  })

  it('a foglaltsagbol van kiut, nem zsakutca', () => {
    expect(app).toContain('guide.auth_busy')
    expect(app).toContain('guideAuthStart(true)')
  })

  it('a `force` szigoruan logikai (egy click-Event igaz-szeru lenne)', () => {
    // Enelkul minden ELSO kattintas kiloné valaki mas futo bejelentkeztetéset.
    expect(app).toMatch(/force: force === true/)
  })

  it('bezaraskor leall a lekerdezes, de a futo folyamat nem szakad meg', () => {
    const close = /function closeSelfCheckGuide\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(close).toContain('_guideAuthStopPoll()')
    expect(close).not.toContain('login/cancel')
  })

  it('a zaro ellenorzes UJRAMER, nem a tarolt (akar oras) eredmenyt hiszi el', () => {
    // Pont ez volt a hiba alakja: az ora rendben volt, kozben a Google
    // elutasitott mindent.
    const verify = /async function selfCheckGuideVerify\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(verify).toContain('_selfCheckGuideTarget.live')
    expect(verify).toContain("'/api/connections/google/live-check'")
    expect(verify).toContain('guide.verify_live_ok')
    expect(verify).toContain('guide.verify_live_bad')
  })
})

describe('minden uj szoveg mindket nyelven megvan', () => {
  const kulcsok = [
    'health.google_live_ok', 'health.google_live_ok_action',
    'health.google_live_bad', 'health.google_live_bad_action',
    'health.google_live_never', 'health.google_live_never_action',
    'health.google_live_stale', 'health.google_live_stale_action',
    'conn.live_running', 'conn.live_done_ok', 'conn.live_done_bad', 'conn.live_failed',
    'guide.title_live', 'guide.lead_auth',
    'guide.auth_intro_one', 'guide.auth_intro_many', 'guide.auth_progress',
    'guide.auth_start_btn', 'guide.auth_retry_btn', 'guide.auth_force_btn',
    'guide.auth_starting', 'guide.auth_saving',
    'guide.auth_link_lead', 'guide.auth_open_btn', 'guide.auth_copy_btn', 'guide.auth_copied',
    'guide.auth_paste_lead', 'guide.auth_paste_ph', 'guide.auth_paste_btn',
    'guide.auth_done_one', 'guide.auth_done_saved',
    'guide.auth_next_btn', 'guide.auth_verify_btn',
    'guide.auth_failed', 'guide.auth_busy',
    'guide.auth_blocked', 'guide.auth_blocked_btn',
    'guide.verify_live_ok', 'guide.verify_live_bad',
  ]
  for (const k of kulcsok) {
    it(`'${k}' magyarul es angolul is`, () => {
      expect(hu, 'hu.js').toContain(`'${k}':`)
      expect(en, 'en.js').toContain(`'${k}':`)
    })
  }
})
