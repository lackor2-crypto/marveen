// A FOLYAMATBAN LEVO BEJELENTKEZES NEM BERAGADT MENU.
//
// Boss, 2026-08-29: "⌨️ A(z) lackor3 session beragadt egy interaktiv menube
// (pl. /mcp) (...) Kikuldtem egy Escape-et" -- "ezt irta ki a marvin miutan
// megprobaltam bejelentkezni a lackor3 al! es nem is jelentkezett be."
//
// A MERT ok: a bejelentkezes masodik kepernyoje ("Paste code here if prompted
// >", felette az OAuth-URL-lel) kivulrol pontosan ugy nez ki, mint egy
// beragadt menu -- nincs busy-jel, nincs idle-lablec, a lablecben ott az "Esc
// to cancel". Az orjarat Escape-et kuldott ra, ami KILOTTE a bejelentkezest.
//
// Ugyanaz a csapda, mint a modell-hozzajarulasi dialogusnal, ahol a vak
// Escape "cancelled"-et rogzitett -- es a megoldas is ugyanaz: eloszor
// megnezzuk, mi az.

import { describe, it, expect } from 'vitest'
import { detectsLoginInProgress, detectsBlockingMenu } from '../pane-state.js'

const AUTH_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code'
  + '&code_challenge=ZFSak1&state=gbXJV'

// A 2026-08-29-en MERT panel alakja.
const LOGIN_PANE = [
  '   Login',
  '',
  "   Browser didn't open? Use the url below to sign in (c to copy)",
  '',
  AUTH_URL,
  '',
  '   Paste code here if prompted >',
  '',
  '   Esc to cancel',
].join('\n')

describe('a bejelentkezesi kepernyot nem szabad beragadt menunek nezni', () => {
  it('a MERT panel bejelentkezesnek latszik', () => {
    expect(detectsLoginInProgress(LOGIN_PANE)).toBe(true)
  })

  it('a regi detektor ONMAGABAN tenyleg menunek latja -- ezert kellett a kulon vizsgalat', () => {
    // Ez a sor a HIBA bizonyiteka, nem a javitase: ha ez valaha false lesz,
    // az azt jelenti, hogy a menu-detektor valtozott, es a fenti vedelem
    // esetleg mar mas okbol nem tuzel. Akkor ezt a tesztet ujra kell gondolni.
    expect(detectsBlockingMenu(LOGIN_PANE)).toBe(true)
  })

  it('EGY jel nem eleg: a scrollbackben allo regi URL onmagaban nem bejelentkezes', () => {
    // Kulonben minden panel, amiben valaha volt egy OAuth-URL, orokre
    // "bejelentkezes alatt" lenne, es a valodi beragadast sosem oldanank fel.
    const pane = [
      '   Korabban: ' + AUTH_URL,
      '   ❯ ',
      '   Esc to cancel',
    ].join('\n')
    expect(detectsLoginInProgress(pane)).toBe(false)
  })

  it('a beviteli sor onmagaban sem eleg', () => {
    const pane = ['   Paste code here if prompted >', '   Esc to cancel'].join('\n')
    expect(detectsLoginInProgress(pane)).toBe(false)
  })

  it('egy sima, valodi menu NEM bejelentkezes -- azt tovabbra is fel kell oldani', () => {
    const pane = [
      '   Select an MCP server',
      '     1. github',
      '     2. filesystem',
      '   Esc to cancel',
    ].join('\n')
    expect(detectsLoginInProgress(pane)).toBe(false)
    expect(detectsBlockingMenu(pane)).toBe(true)
  })

  it('ures / whitespace panelre false (nem talal ki semmit)', () => {
    expect(detectsLoginInProgress('')).toBe(false)
    expect(detectsLoginInProgress('   \n  \n')).toBe(false)
  })
})
