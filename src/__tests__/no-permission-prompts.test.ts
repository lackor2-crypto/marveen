// NE KERDEZZEN MUNKA KOZBEN -- es ez FRISS TELEPITESEN IS igy legyen.
//
// A MERT ESET (2026-09-13). Egy WSL-beli VS Code fejleszto-menetben kb. OTVEN
// engedelykeres jott fel egymas utan, mikozben ugyanannak a gepnek a windowsos
// meneteben egy sem. Az ok nem a gep volt: az "auto" (acceptEdits) mod csak a
// FAJLSZERKESZTEST engedi at, a PARANCSFUTTATAST nem -- egy fejleszto-menet
// pedig szaz parancsot futtat (git, npm, curl, teszt). A tulajdonos: "amig
// dolgozol addig ne kerdezz semmit! ... ha autora van allitva akkor menjen mar
// a programozas automatikusan tovabb."
//
// ES A LENYEG, amit a tulajdonos kulon kimondott: "ezt ugy csinald meg azert
// hogy ha a marveen t egy uj gepre telepitjuk akkor egy uj usernek ez ne jojjon
// elo". Egy `settings.local.json`-be irt javitas CSAK EZEN A GEPEN letezik --
// ezert kell HAROM helyen allnia, es ezert orzi ez a teszt mindharmat:
//
//   1. a KOVETETT projekt-beallitas  -> aki klonozza a repot, megkapja;
//   2. az agens-sablon               -> minden flotta-agens megkapja;
//   3. a telepito                    -> a friss gep user-szintu alapertelmezese.
//
// VISSZAVENNI barmikor lehet: a `.claude/settings.local.json` (nincs a gitben)
// erosebb a kovetettnel, tehat aki kerdeseket akar, ott atallitja.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const WANT = 'bypassPermissions'

describe('a fejleszto-menet nem all meg engedelykeresen -- friss telepitesen sem', () => {
  it('1. a KOVETETT projekt-beallitasban benne van', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'))
    expect(
      cfg?.permissions?.defaultMode,
      'A .claude/settings.json a REPOBAN van: ezt kapja meg mindenki, aki klonozza.\n'
        + 'Ha ez kiesik, a VS Code-menet ujra kerdezni fog minden parancsnal.',
    ).toBe(WANT)
  })

  it('2. az agens-sablonban benne van (minden flotta-agens ebbol kap settings-et)', () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf8'))
    expect(tpl?.permissions?.defaultMode).toBe(WANT)
  })

  it('3. a telepito a friss gepen is beallitja', () => {
    const sh = readFileSync(join(ROOT, 'install-linux.sh'), 'utf8')
    // A telepito a ~/.claude/settings.json-be ir; a sor pontos alakja valtozhat,
    // a LENYEG az, hogy a defaultMode-ot erre az ertekre allitja.
    expect(sh).toMatch(/defaultMode"?\]?\s*=\s*"bypassPermissions"/)
  })

  it('a harom hely UGYANAZT mondja (nem csuszhatnak szet)', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'))
    const tpl = JSON.parse(readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf8'))
    expect(cfg.permissions.defaultMode).toBe(tpl.permissions.defaultMode)
  })
})
