// A kozos skill-konyvtar paritasa: az URES LISTA ket dolgot jelentett.
//
// Kartya 3119f0bc, a #228 ellenorzesebol. A regi agentsMissingSharedSkills()
// string[]-et adott vissza, es HAROM kulonbozo vak agon adott URES listat:
// nem letezett a kozos konyvtar, a realpath dobott ra, vagy ures volt az
// agens-lista. A hivo (src/web.ts) mindharom esetben ezt irta a naploba:
// "Agent parity verified: every agent shares the same hooks and skill library"
// -- azaz egy el nem vegzett meresre allitott sikert. Friss telepitesen, ahol a
// seed-skillek meg nincsenek kirenderelve, pontosan ez a helyzet all fenn:
// EGYETLEN agens sem kapja meg a kozos konyvtarat, es a rendszer paritast jelent.
//
// A negyedik, legalattomosabb ag a javitas kozben derult ki, meressel: a
// listAgentNames() akkor is [] -t ad, ha az `agents/` konyvtar NINCS is meg (git
// worktree, CI checkout -- az `agents/` nincs git-ben kovetve). Nulla agens
// "meg nincs sub-agens" ES "nem latok oda" is lehet; csak maga a konyvtar donti el.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { summarizeSkillLibraryParity, describeSkillLibraryParity } from '../agent-parity.js'
import { skillLibraryParity } from '../web/skill-library-parity.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

describe('summarizeSkillLibraryParity', () => {
  it('minden agens a kozos konyvtarra mutat -> ok, es kimondja hanyat nezett meg', () => {
    const p = summarizeSkillLibraryParity({
      sharedLibraryExists: true, agents: ['a', 'b', 'c'], missing: [],
    })
    expect(p.verdict).toBe('ok')
    expect(p.examined).toBe(3)
    expect(p.reason).toBe('')
    expect(describeSkillLibraryParity(p)).toContain('3 agens megnezve')
  })

  it('elteres -> gaps, a neveket rendezve adja vissza', () => {
    const p = summarizeSkillLibraryParity({
      sharedLibraryExists: true, agents: ['z', 'a'], missing: ['z', 'a'],
    })
    expect(p.verdict).toBe('gaps')
    expect(p.missing).toEqual(['a', 'z'])
    expect(p.examined).toBe(2)
    expect(describeSkillLibraryParity(p)).toContain('a, z')
  })

  it('NINCS kozos konyvtar -> not_measured, NEM ok (ez volt a legdragabb ag)', () => {
    const p = summarizeSkillLibraryParity({
      sharedLibraryExists: false, agents: null, missing: [],
    })
    expect(p.verdict).toBe('not_measured')
    expect(p.examined).toBeNull()
    expect(p.reason).not.toBe('')
    // A mondat mondja meg, hogy nem MERT, ne azt sugallja, hogy rendben van.
    expect(describeSkillLibraryParity(p)).toContain('NEM tudtam megmerni')
  })

  it('a kozos konyvtar olvasasa hibara fut -> not_measured, a hibauzenet szo szerint', () => {
    const p = summarizeSkillLibraryParity({
      sharedLibraryExists: true, sharedLibraryError: 'EACCES: permission denied',
      agents: null, missing: [],
    })
    expect(p.verdict).toBe('not_measured')
    expect(p.reason).toContain('EACCES: permission denied')
  })

  it('az agens-lista nem olvashato -> not_measured, nem ures-de-rendben', () => {
    const p = summarizeSkillLibraryParity({
      sharedLibraryExists: true, agents: null, agentsError: 'ENOENT: no such file',
      missing: [],
    })
    expect(p.verdict).toBe('not_measured')
    expect(p.examined).toBeNull()
    expect(p.reason).toContain('ENOENT: no such file')
  })

  it('ismeretlen okot is kimond, nem hallgat', () => {
    const p = summarizeSkillLibraryParity({ sharedLibraryExists: true, agents: null, missing: [] })
    expect(p.verdict).toBe('not_measured')
    expect(p.reason).toContain('ismeretlen hiba')
  })

  it('NULLA agens LETEZO konyvtarral -> ok es examined=0: ez MERT nulla', () => {
    // A ketto kulonbsege a lenyeg: itt vegignezhettuk a listat, csak ures volt
    // (friss telepites, meg nincs sub-agens). Ez nem ugyanaz, mint a hianyzo
    // konyvtar -- lasd a kovetkezo teszt-blokkot.
    const p = summarizeSkillLibraryParity({ sharedLibraryExists: true, agents: [], missing: [] })
    expect(p.verdict).toBe('ok')
    expect(p.examined).toBe(0)
    expect(describeSkillLibraryParity(p)).toContain('nincs sub-agens')
  })
})

describe('skillLibraryParity (a fajlrendszert olvaso fele)', () => {
  it('sosem allit sikert olyasmire, amit nem nezett meg', () => {
    const p = skillLibraryParity()
    if (p.verdict === 'ok') {
      expect(typeof p.examined).toBe('number')
      expect(p.reason).toBe('')
    } else if (p.verdict === 'not_measured') {
      expect(p.examined).toBeNull()
      expect(p.reason).not.toBe('')
    }
  })

  it('hianyzo agens-konyvtar NEM latszik "nulla agens, minden rendben"-nek', () => {
    // Ez az az allitas, ami worktree-ben es CI-ben tenylegesen ERTEKELODIK:
    // ott az `agents/` nincs meg (nincs git-ben kovetve), tehat a verdikt
    // KOTELEZOEN not_measured. A regi kod itt ures listat adott -> "rendben".
    const p = skillLibraryParity()
    if (!existsSync(AGENTS_BASE_DIR)) {
      expect(p.verdict).toBe('not_measured')
      expect(p.reason).toContain('agens-konyvtar nem letezik')
    }
  })
})

describe('a hivo oldal is a verdiktet nezi (nem eleg megmerni)', () => {
  it('a web.ts csak MERT ok-ra allit paritast, es a nem-merest kulon kimondja', () => {
    const web = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    expect(web).toContain("parity.skills.verdict === 'ok'")
    expect(web).toContain("parity.skills.verdict === 'not_measured'")
    expect(web).toContain('Agent parity NOT verified')
    // A regi alak eltunt: az ures lista tobbe nem szamit bizonyiteknak.
    expect(web).not.toContain('parity.skillGaps')
  })

  it('a startup-ellenorzo a verdiktet adja tovabb, nem egy ures listat', () => {
    const check = readFileSync(join(__dirname, '..', 'web', 'agent-parity-check.ts'), 'utf-8')
    expect(check).toContain('skillLibraryParity()')
    expect(check).toContain("skills.verdict === 'ok'")
    expect(check).not.toContain('agentsMissingSharedSkills')
  })
})
