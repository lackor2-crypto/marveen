// KI VAN EBBEN A SLOTBAN.
//
// Boss, 2026-08-29: "ne legyen ugyanabba a fiokba bejelentkezve. hat hiszen a
// lackor3 az egy kulon email klon fiokkal... mit keres az az usalackorban? ez
// igy nagyon gaz. egesd be a marveenba hogy ilyen tobbet elo ne forduljon!"
//
// Ket kulon nevu elofizetes ugyanarra az Anthropic-fiokra mutatott: ketten
// ettek ugyanannak az egy fioknak a keretet, a masik elofizetes meg allt.
// Semmi nem szolt, mert sehol nem volt leirva, KINEK kellene ott lennie.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditIdentities,
  decideNewAccountEmail,
  decidePostLogin,
  hasIdentityProblem,
  normalizeEmail,
} from '../web/account-identity-guard.js'
import { pinExpectedEmail } from '../web/claude-plans.js'

const be = (id: string | null, email: string | null, expectedEmail?: string | null) => ({
  id, label: id || '', email, loggedIn: email !== null, probeOk: true, expectedEmail,
})

describe('ket elofizetes ugyanazon a fiokon', () => {
  it('eszreveszi, ha ket nevesitett slot ugyanazt a cimet adja', () => {
    const a = auditIdentities([
      be('usalackor', 'usalackor@gmail.com'),
      be('lackor3', 'usalackor@gmail.com'),
    ])
    expect(a.collisions).toHaveLength(1)
    expect(a.collisions[0].email).toBe('usalackor@gmail.com')
    expect(a.collisions[0].ids.sort()).toEqual(['lackor3', 'usalackor'])
    expect(hasIdentityProblem(a)).toBe(true)
  })

  it('a gep sajat fiokja is beleszamit -- arra atcsuszni ugyanaz a hiba', () => {
    const a = auditIdentities([
      be(null, 'lackor2@gmail.com'),
      be('lackor3', 'lackor2@gmail.com'),
    ])
    expect(a.collisions).toHaveLength(1)
    expect(a.collisions[0].ids).toContain(null)
  })

  it('kulon fiokoknal csend', () => {
    const a = auditIdentities([
      be(null, 'lackor2@gmail.com'),
      be('usalackor', 'usalackor@gmail.com'),
      be('lackor3', 'lackor3@gmail.com'),
    ])
    expect(a.collisions).toHaveLength(0)
    expect(hasIdentityProblem(a)).toBe(false)
  })

  it('a nagybetu es a szokoz nem csinal ket kulon fiokot', () => {
    const a = auditIdentities([
      be('a', ' Usalackor@Gmail.com '),
      be('b', 'usalackor@gmail.com'),
    ])
    expect(a.collisions).toHaveLength(1)
  })
})

describe('a nulla ket dolgot jelenthet', () => {
  it('a meg nem kerdezett fiok NEM "rendben", hanem sajat allapota van', () => {
    const a = auditIdentities([
      { id: 'x', label: 'X', email: null, loggedIn: false, probeOk: false },
    ])
    expect(a.bySlot['x']).toEqual({ kind: 'blind' })
    expect(a.blind).toBe(1)
  })

  it('a vak slot nem kerul be az utkozes-keresesbe -- a lista igy HIANYOS lehet', () => {
    const a = auditIdentities([
      be('a', 'kozos@gmail.com'),
      { id: 'b', label: 'B', email: 'kozos@gmail.com', loggedIn: true, probeOk: false },
    ])
    // Csak egy slotot lattunk, tehat nincs bizonyitott utkozes -- de a `blind`
    // szam megmondja, hogy nem lattunk mindenkit.
    expect(a.collisions).toHaveLength(0)
    expect(a.blind).toBe(1)
  })

  it('a kijelentkezett fiok nem utkozik senkivel', () => {
    const a = auditIdentities([be('a', null), be('b', null)])
    expect(a.collisions).toHaveLength(0)
  })
})

describe('elteres a rogzitett cimtol', () => {
  it('mas cim van benne, mint amit ide rogzitettunk', () => {
    const a = auditIdentities([be('lackor3', 'usalackor@gmail.com', 'lackor3@gmail.com')])
    expect(a.bySlot['lackor3']).toEqual({
      kind: 'drift', expected: 'lackor3@gmail.com', actual: 'usalackor@gmail.com',
    })
    expect(hasIdentityProblem(a)).toBe(true)
  })

  it('egyezesnel rendben', () => {
    const a = auditIdentities([be('lackor3', 'lackor3@gmail.com', 'lackor3@gmail.com')])
    expect(a.bySlot['lackor3'].kind).toBe('ok')
  })

  it('rogzites nelkul nem allitunk semmit, csak jelezzuk, hogy nincs mihez merni', () => {
    const a = auditIdentities([be('lackor3', 'barmi@gmail.com')])
    expect(a.bySlot['lackor3'].kind).toBe('unpinned')
    expect(hasIdentityProblem(a)).toBe(false)
  })
})

describe('mi tortenjen egy befejezett bejelentkezes utan', () => {
  it('az ELSO bejelentkezes rogziti a slot cimet (friss telepitesen sincs mit beallitani)', () => {
    expect(decidePostLogin(null, 'uj@gmail.com')).toEqual({ kind: 'pin', email: 'uj@gmail.com' })
  })

  it('mas cim eseten NEM ir felul csendben, hanem jelez', () => {
    expect(decidePostLogin('regi@gmail.com', 'mas@gmail.com')).toEqual({
      kind: 'drift', expected: 'regi@gmail.com', actual: 'mas@gmail.com',
    })
  })

  it('ha nem tudtuk leolvasni a cimet, nem talalgatunk', () => {
    expect(decidePostLogin('regi@gmail.com', null)).toEqual({ kind: 'unknown' })
  })

  it('ugyanaz a cim: nincs teendo', () => {
    expect(decidePostLogin('a@b.hu', 'A@B.hu ')).toEqual({ kind: 'ok', email: 'a@b.hu' })
  })
})

describe('normalizeEmail', () => {
  it('ures es hianyzo ertek egyarant null', () => {
    expect(normalizeEmail('   ')).toBeNull()
    expect(normalizeEmail(null)).toBeNull()
    expect(normalizeEmail(undefined)).toBeNull()
  })
})

describe('a rogzitett cim lemezre irasa', () => {
  let dir: string
  let path: string
  const jegyzek = (extra = '') => `[
    { "id": "usalackor", "label": "Usalackor", "configDir": "/tmp/u", "planType": "team", "channelsAllowed": false },
    { "id": "lackor3", "label": "Lackor3", "configDir": "/tmp/l", "planType": "personal", "channelsAllowed": false${extra} }
  ]`

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claw-pin-'))
    path = join(dir, 'claude-plans.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('rogziti a cimet, ha meg nincs', () => {
    writeFileSync(path, jegyzek())
    const r = pinExpectedEmail('lackor3', 'lackor3@gmail.com', { path })
    expect(r).toEqual({ ok: true, changed: true })
    const list = JSON.parse(readFileSync(path, 'utf-8'))
    expect(list[1].expectedEmail).toBe('lackor3@gmail.com')
    // A tobbi mezo erintetlen marad.
    expect(list[1].configDir).toBe('/tmp/l')
    expect(list[0].expectedEmail).toBeUndefined()
  })

  it('MAR rogzitett cimet nem ir felul magatol', () => {
    writeFileSync(path, jegyzek(', "expectedEmail": "lackor3@gmail.com"'))
    const r = pinExpectedEmail('lackor3', 'valakimas@gmail.com', { path })
    expect(r).toEqual({ ok: true, changed: false })
    expect(JSON.parse(readFileSync(path, 'utf-8'))[1].expectedEmail).toBe('lackor3@gmail.com')
  })

  it('kifejezett dontesre viszont atirja', () => {
    writeFileSync(path, jegyzek(', "expectedEmail": "lackor3@gmail.com"'))
    const r = pinExpectedEmail('lackor3', 'valakimas@gmail.com', { path, force: true })
    expect(r).toEqual({ ok: true, changed: true })
    expect(JSON.parse(readFileSync(path, 'utf-8'))[1].expectedEmail).toBe('valakimas@gmail.com')
  })

  it('serult nyilvantartasnal nem ir semmit, es megmondja, mi a baj', () => {
    writeFileSync(path, '{ nem lista')
    const r = pinExpectedEmail('lackor3', 'x@y.hu', { path })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/serult/)
  })

  it('hianyzo fajlnal sem dob hibat -- friss telepitesen ez a normalis', () => {
    const r = pinExpectedEmail('lackor3', 'x@y.hu', { path: join(dir, 'nincs.json') })
    expect(r.ok).toBe(false)
  })
})

describe('UJ FIOK FELVETELE: sajat cimhez kotve, nem egy meglevohoz', () => {
  // Boss, 2026-08-30: "ha valaki szeretne felvenni egy uj fiokot, akkor azt
  // mindenfelekeppen ahhoz az emailhez kell kotni, amivel regisztralni akar.
  // nem egy meglevohoz!!!"
  const megvan = [
    be('usalackor', 'usalackor@gmail.com'),
    be(null, 'lackor2@gmail.com'),
    { id: 'lackor3', label: 'Lackor3', email: null, loggedIn: false, probeOk: true,
      expectedEmail: 'lackor3@gmail.com' },
  ]

  it('cim nelkul nem lehet uj fiokot felvenni', () => {
    expect(decideNewAccountEmail('', megvan)).toEqual({ kind: 'missing' })
    expect(decideNewAccountEmail(null, megvan)).toEqual({ kind: 'missing' })
    expect(decideNewAccountEmail('   ', megvan)).toEqual({ kind: 'missing' })
  })

  it('a fel-cim sem eleg', () => {
    expect(decideNewAccountEmail('valaki', megvan).kind).toBe('invalid')
    expect(decideNewAccountEmail('valaki@gep', megvan).kind).toBe('invalid')
    expect(decideNewAccountEmail('a b@c.hu', megvan).kind).toBe('invalid')
  })

  it('MAR HASZNALT cimet nem lehet meg egyszer felvenni', () => {
    const d = decideNewAccountEmail('usalackor@gmail.com', megvan)
    expect(d).toEqual({ kind: 'taken', by: 'usalackor', email: 'usalackor@gmail.com' })
  })

  it('a gep sajat fiokjanak cime is foglalt', () => {
    expect(decideNewAccountEmail('lackor2@gmail.com', megvan).kind).toBe('taken')
  })

  it('a ROGZITETT cim akkor is foglal, ha az a fiok epp ki van jelentkezve', () => {
    // Ez a lenyeg: a hely mar el van igerve valakinek. Ha ezt engednenk, a
    // visszajelentkezes utan ket slot ulne egy fiokon.
    expect(decideNewAccountEmail('lackor3@gmail.com', megvan).kind).toBe('taken')
  })

  it('nagybetu es szokoz nem kerulo ut', () => {
    expect(decideNewAccountEmail('  UsaLackor@Gmail.com ', megvan).kind).toBe('taken')
  })

  it('sajat, meg nem hasznalt cim: mehet, es normalizalva megy tovabb', () => {
    expect(decideNewAccountEmail(' Uj.Fiok@Pelda.hu ', megvan))
      .toEqual({ kind: 'ok', email: 'uj.fiok@pelda.hu' })
  })

  it('friss telepitesen (meg egyetlen fiok sincs) barmelyik cim mehet', () => {
    expect(decideNewAccountEmail('elso@pelda.hu', [])).toEqual({ kind: 'ok', email: 'elso@pelda.hu' })
  })
})

describe('a felulet is keri a cimet, nem csak a szerver', () => {
  // Ket retegben all: a gomb be sem kuldi cim nelkul, a szerver pedig akkor sem
  // engedi, ha valaki megkeruli a lapot.
  const app = readFileSync('web/app.js', 'utf-8')
  const html = readFileSync('web/index.html', 'utf-8')

  it('a hozzaadas gombja cim nelkul nem indit folyamatot', () => {
    const kezdet = app.indexOf("getElementById('claudeAuthStartBtn')")
    expect(kezdet).toBeGreaterThan(-1)
    const blokk = app.slice(kezdet, kezdet + 1200)
    expect(blokk).toContain("t('claudeauth.need_email')")
    // A regi, feltételes payload ("email ? {label,email} : {label}") pont azt
    // engedte at, ami a hibat okozta.
    expect(blokk).not.toContain('email ? { label, email } : { label }')
  })

  it('az urlap mezoje kotelezonek van jelolve', () => {
    const i = html.indexOf('id="claudeAuthEmail"')
    expect(i).toBeGreaterThan(-1)
    expect(html.slice(i - 200, i + 200)).toContain('required')
  })

  it('a hiba a felulet nyelven jelenik meg (kulcs, nem magyar mondat)', () => {
    expect(app).toContain('function _claudeAuthErrorText(data)')
    expect(app).toContain('_claudeAuthSetState(_claudeAuthErrorText(data)')
  })

  for (const nyelv of ['hu', 'en']) {
    it(`${nyelv}: mind a negy uj szoveg megvan`, () => {
      const s = readFileSync(`web/lang/${nyelv}.js`, 'utf-8')
      for (const k of ['claudeauth.need_email', 'claudeauth.err_email_required',
        'claudeauth.err_email_invalid', 'claudeauth.err_email_taken']) {
        expect(s, `${nyelv}: ${k}`).toContain(`'${k}':`)
      }
    })
  }
})
