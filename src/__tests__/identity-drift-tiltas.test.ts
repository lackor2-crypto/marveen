// MAS FIOKKAL BEJELENTKEZNI NEM LEHET -- NEM CSAK SZOLUNK, VISSZA IS VONJUK.
//
// Boss, 2026-08-30: "most ha direkt az usalackorral vagyok a bongeszoben
// bejelentkezve es igy probalok bejelentkezni a lackor3-al akkor mi tortenik?
// szol a rendszer hogy ezt nem lehet? mert meg kellene tiltani!"
//
// Eddig a rendszer SZOLT (`identityDrift` -> piros ertesites), de a rossz fiok
// BENT MARADT a helyen -- vagyis eloallt pontosan az az allapot, ami miatt az
// egesz or szuletett: ket hely egy fiokon, ketten esznek egy keretet.
//
// A tmux-os bejelentkezesi folyamat egeszet nem lehet egysegtesztben lejatszani
// (valodi tmux ablak + valodi CLI), ezert itt a DONTES es a KIMENET harom
// allapota all tesztelve, forrasszinten es a felulet oldalan.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { decidePostLogin } from '../web/account-identity-guard.js'

const RUNNER = readFileSync('src/web/claude-auth-runner.ts', 'utf-8')
const APP = readFileSync('web/app.js', 'utf-8')
const HU = readFileSync('web/lang/hu.js', 'utf-8')
const EN = readFileSync('web/lang/en.js', 'utf-8')

describe('a dontes maga', () => {
  it('a Boss esete: lackor3 helyre usalackor jon be -> elteres', () => {
    expect(decidePostLogin('lackor3@gmail.com', 'usalackor@gmail.com'))
      .toEqual({ kind: 'drift', expected: 'lackor3@gmail.com', actual: 'usalackor@gmail.com' })
  })
  it('a jo fiok: csend', () => {
    expect(decidePostLogin('lackor3@gmail.com', 'Lackor3@Gmail.com '))
      .toEqual({ kind: 'ok', email: 'lackor3@gmail.com' })
  })
  it('ha nem tudtuk megmerni, ki jott be, NEM allitunk eltereset', () => {
    // A nulla ket dolgot jelenthet: "nem ismerem a cimet" != "mas jott be".
    expect(decidePostLogin('lackor3@gmail.com', null)).toEqual({ kind: 'unknown' })
  })
})

describe('a szerver vissza is vonja a rossz bejelentkezest', () => {
  it('elteresnel kijelentkeztet', () => {
    const i = RUNNER.indexOf('if (drift) {')
    expect(i).toBeGreaterThan(-1)
    const blokk = RUNNER.slice(i, i + 1200)
    expect(blokk).toContain('logoutAccount(drift.planId)')
    expect(blokk).toContain('reverted: vissza.ok')
  })

  it('a visszavonas KUDARCA nem tunhet el (kulon mezo, kulon napló)', () => {
    const i = RUNNER.indexOf('if (drift) {')
    const blokk = RUNNER.slice(i, i + 1200)
    expect(blokk).toContain('revertError')
    expect(blokk).toContain('logger.error')
  })

  it('a visszavonas a folyamat lezarasa UTAN fut (kulonben a logoutAccount elutasitana)', () => {
    // `logoutAccount` nem nyul hozza, amig fut egy bejelentkezes (`current`).
    const zaras = RUNNER.indexOf('killSession(); current = null\n\n    // NEM ELEG SZOLNI')
    const vonas = RUNNER.indexOf('if (drift) {')
    expect(zaras).toBeGreaterThan(-1)
    expect(vonas).toBeGreaterThan(zaras)
  })

  it('a lista a visszavonas UTAN kerul ossze (kulonben a bent maradt fiokot mutatna)', () => {
    const vonas = RUNNER.indexOf('if (drift) {')
    const lista = RUNNER.indexOf('const accounts = listAccounts(true)', vonas)
    expect(lista).toBeGreaterThan(vonas)
  })
})

describe('a felulet harom kulon allapotot mond, nem egyet', () => {
  it('visszavonva / nem sikerult / regi valasz -- harom kulon kulcs', () => {
    const i = APP.indexOf('if (s.identityDrift) {')
    expect(i).toBeGreaterThan(-1)
    const blokk = APP.slice(i, i + 700)
    expect(blokk).toContain("'accounts.identity.drift_blocked'")
    expect(blokk).toContain("'accounts.identity.drift_block_failed'")
    expect(blokk).toContain("'accounts.identity.drift_after_login'")
  })

  it('a visszavont bejelentkezesre NEM ir "Hozzaadva"-t', () => {
    expect(APP).toContain('const _driftBlocked = !!(s.identityDrift && s.identityDrift.reverted)')
    expect(APP).toContain("else if (!_driftBlocked) showToast(t(s.reused ? 'claudeauth.done_back'")
  })

  it('a rogzitett cim MAR A BEJELENTKEZES ALATT kint van', () => {
    expect(APP).toContain("t('claudeauth.expect_hint', { email: s.expectedEmail })")
    const i = APP.indexOf("if (s.phase === 'starting')")
    expect(APP.slice(i, i + 400)).toContain('_expectHint')
  })
})

describe('mind a harom uj mondat ketnyelvu', () => {
  for (const k of ['accounts.identity.drift_blocked', 'accounts.identity.drift_block_failed',
    'claudeauth.expect_hint']) {
    it(`hu + en: ${k}`, () => {
      expect(HU, `hu.js: ${k}`).toContain(`'${k}':`)
      expect(EN, `en.js: ${k}`).toContain(`'${k}':`)
    })
  }

  it('a tiltas mondata megmondja a KOVETKEZO LEPEST is', () => {
    const sor = HU.slice(HU.indexOf("'accounts.identity.drift_blocked':"), HU.indexOf("'accounts.identity.drift_block_failed':"))
    expect(sor).toContain('claude.ai')
    expect(sor).toMatch(/privát ablak/i)
  })
})
