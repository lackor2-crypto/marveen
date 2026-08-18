// A sarga jelveny annak a folyamatnak szoljon, amelyik TENYLEG elavult.
//
// Boss, 2026-08-16: "sokszor ujra lett mar inditva a marvin es megis itt vannak
// ezek a sarga betuk." A jelveny elso javitasa (boot-ertek vs. mostani ertek)
// pontos -- de csak a VEZERLOPULTRA, mert csak az o boot-ertekeit ismeri.
//
// A kulcsok egy resze nem ott el (restartTarget: 'main-agent'): azokat a
// foagens sajat tmux-munkamenete olvassa induláskor. Ott a boot-osszehasonlitas
// ket iranyban is hazudik, es a rosszabbik irany a CSENDES: a vezerlopult
// ujraindul, a jelveny eltunik, a foagens meg tovabbra is a regi modellel fut.
import { describe, it, expect } from 'vitest'
import { targetKind, decideRestartPending } from '../settings-restart-pending.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'

const T0 = 1_700_000_000_000
const perc = 60_000

describe('targetKind -- ki olvassa a beallitast', () => {
  it('a foagens kulcsait a vezerlopult NEM olvassa', () => {
    expect(targetKind('main-agent')).toEqual({ readsDashboard: false, sessions: 'main' })
  })

  it('a foagens kulcsahoz a SUB-AGENSEK munkamenete nem tartozik', () => {
    // Ez a javitas lenyege. Ha ez 'all'-ra valtozik, visszater a hiba:
    // MAIN_AGENT_MODEL atallitas -> Marvin ujraindul -> a jelveny MEGIS sarga
    // marad, mert egy napok ota futo `agent-lagunas` regebbi a valtozasnal.
    // A MAIN_AGENT_* kulcsokat a scripts/channels.sh olvassa, a foagens
    // munkamenetenek inditasakor; a sub-agensek soha nem latjak oket.
    expect(targetKind('main-agent').sessions).toBe('main')
    expect(targetKind('main-agent').sessions).not.toBe('all')
  })

  it('a vegyes celpontot mindketto olvassa, es ott TENYLEG minden agens', () => {
    expect(targetKind('dashboard+agents')).toEqual({ readsDashboard: true, sessions: 'all' })
  })

  it('a heartbeat kulcsa csak a heartbeat munkamenetere nez', () => {
    // A heartbeat sajat, csatorna nelkuli sub-agens (agents/heartbeat). Ha
    // nem fut, a hivo null-t ad, es marad a vezerlopult boot-jele.
    expect(targetKind('dashboard+heartbeat')).toEqual({ readsDashboard: true, sessions: 'heartbeat' })
  })

  it('ismeretlen vagy hianyzo celpont eseten a vezerlopult a valasz', () => {
    // Sosem allitunk tobbet, mint amit tudunk: egy uj, meg be nem sorolt
    // celpont ne kezdjen el tmux-munkameneteket emlegetni.
    expect(targetKind(undefined)).toEqual({ readsDashboard: true, sessions: 'none' })
    expect(targetKind('valami-uj')).toEqual({ readsDashboard: true, sessions: 'none' })
  })
})

describe('decideRestartPending', () => {
  it('a vezerlopult sajat kulcsanal a boot-ertek dont', () => {
    const kind = targetKind('dashboard')
    expect(decideRestartPending({ bootDiffers: true, kind, changedAt: null, sessionsStartedAt: null })).toBe(true)
    expect(decideRestartPending({ bootDiffers: false, kind, changedAt: null, sessionsStartedAt: null })).toBe(false)
  })

  it('a foagens kulcsanal a VEZERLOPULT ujrainditasa nem torli a jelvenyt', () => {
    // Ez a csendes hiba: a vezerlopult uj folyamat (bootDiffers=false), de a
    // foagens munkamenete a valtozas ELOTT indult -- meg mindig regi ertekkel fut.
    expect(decideRestartPending({
      bootDiffers: false,
      kind: targetKind('main-agent'),
      changedAt: T0,
      sessionsStartedAt: T0 - 10 * perc,
    })).toBe(true)
  })

  it('a foagens ujrainditasa UTAN a jelveny eltunik', () => {
    // Es ez a Boss eredeti panasza: ujrainditotta, megis sarga maradt.
    expect(decideRestartPending({
      bootDiffers: true,
      kind: targetKind('main-agent'),
      changedAt: T0,
      sessionsStartedAt: T0 + perc,
    })).toBe(false)
  })

  it('azonos idobelyegnel nem allitunk teendot', () => {
    // A naplo masodperc-felbontasu: az "ugyanabban a masodpercben indult"
    // eset inkabb legyen csend, mint egy soha el nem tuno jelveny.
    expect(decideRestartPending({
      bootDiffers: true,
      kind: targetKind('main-agent'),
      changedAt: T0,
      sessionsStartedAt: T0,
    })).toBe(false)
  })

  it('atallitas + visszaallitas utan NINCS teendo', () => {
    // Ket naplo-bejegyzes keletkezik, mindketto a munkamenet indulasa UTAN,
    // de a futo folyamat erteke vegul helyes. Puszta idobelyeg-osszehasonlitas
    // itt orokre sargan hagyna a sort -- pedig nincs mit ujrainditani.
    expect(decideRestartPending({
      bootDiffers: false,
      kind: targetKind('main-agent'),
      changedAt: T0 + 5 * perc,
      sessionsStartedAt: T0,
      valueAtSessionStart: 'claude-haiku-4-5-20251001',
      currentValue: 'claude-haiku-4-5-20251001',
    })).toBe(false)
  })

  it('ha az ertek TENYLEG mas lett, a teendo megmarad', () => {
    expect(decideRestartPending({
      bootDiffers: false,
      kind: targetKind('main-agent'),
      changedAt: T0 + 5 * perc,
      sessionsStartedAt: T0,
      valueAtSessionStart: 'claude-haiku-4-5-20251001',
      currentValue: 'claude-sonnet-5',
    })).toBe(true)
  })

  it('szam es szoveg ugyanaz az ertek', () => {
    // A naplo szoveget tarol, a beallitas visszaadhat szamot vagy logikai
    // erteket. Egy tipuskulonbseg nem a gazda valtoztatasa.
    expect(decideRestartPending({
      bootDiffers: false,
      kind: targetKind('main-agent'),
      changedAt: T0 + perc,
      sessionsStartedAt: T0,
      valueAtSessionStart: '1',
      currentValue: 1,
    })).toBe(false)
  })

  it('ismeretlen indulo ertek eseten marad az ido-alapu valasz', () => {
    // Nincs naplo a munkamenet indulasa korul: nem tudjuk, mivel indult.
    // Ilyenkor a kesobbi valtozas onmagaban teendo (a biztonsagos irany).
    expect(decideRestartPending({
      bootDiffers: false,
      kind: targetKind('main-agent'),
      changedAt: T0 + perc,
      sessionsStartedAt: T0,
      valueAtSessionStart: null,
      currentValue: 'barmi',
    })).toBe(true)
  })

  it('meres nelkul a regi, ertek-alapu jelre esik vissza', () => {
    // Kezzel szerkesztett .env (nincs naplo-bejegyzes) vagy olvashatatlan tmux.
    // Inkabb egy felesleges emlekezteto, mint egy csendben elavult foagens.
    const kind = targetKind('main-agent')
    expect(decideRestartPending({ bootDiffers: true, kind, changedAt: null, sessionsStartedAt: T0 })).toBe(true)
    expect(decideRestartPending({ bootDiffers: true, kind, changedAt: T0, sessionsStartedAt: null })).toBe(true)
    expect(decideRestartPending({ bootDiffers: false, kind, changedAt: null, sessionsStartedAt: null })).toBe(false)
  })

  it('a "senki nem olvassa tmuxbol" kulcsnal a munkamenet-ido nem szamit', () => {
    // 'dashboard' hataru kulcsnal hiaba regi minden munkamenet: a valasz a
    // boot-osszehasonlitas, semmi mas.
    const kind = targetKind('dashboard')
    expect(decideRestartPending({ bootDiffers: false, kind, changedAt: T0, sessionsStartedAt: T0 - perc })).toBe(false)
  })

  it('vegyes celpontnal barmelyik oldal indokolhatja a jelvenyt', () => {
    const kind = targetKind('dashboard+agents')
    // csak a vezerlopult elavult
    expect(decideRestartPending({ bootDiffers: true, kind, changedAt: T0, sessionsStartedAt: T0 + perc })).toBe(true)
    // csak az agensek elavultak
    expect(decideRestartPending({ bootDiffers: false, kind, changedAt: T0, sessionsStartedAt: T0 - perc })).toBe(true)
    // egyik sem
    expect(decideRestartPending({ bootDiffers: false, kind, changedAt: T0, sessionsStartedAt: T0 + perc })).toBe(false)
  })
})

describe('a registry oldalarol nezve', () => {
  it('minden requiresRestart kulcsnak van celpontja', () => {
    // Celpont nelkul a felulet "vezerlopult"-ot mondana -- egy foagens-kulcsnal
    // az rossz gombot kinalna fel.
    const hianyzik = SETTINGS_REGISTRY.filter(d => d.requiresRestart && !d.restartTarget).map(d => d.key)
    expect(hianyzik).toEqual([])
  })

  it('van legalabb egy olyan kulcs, amit a vezerlopult NEM olvas', () => {
    // Amig van ilyen, addig ez az egesz kulonbsegtetel szamit. (Ma harom van:
    // MAIN_AGENT_MODEL, MAIN_AGENT_CONFIG_DIR, MAIN_AGENT_ISOLATED_CONFIG.)
    const sajat = SETTINGS_REGISTRY.filter(d => targetKind(d.restartTarget).readsDashboard === false)
    expect(sajat.length).toBeGreaterThan(0)
  })

  it('egyetlen kulcs sem meri magat MINDEN agenshez feleslegesen', () => {
    // A legdragabb hatar az 'all': ott barmelyik regen futo sub-agens
    // sargan tartja a jelvenyt. Csak az kaphatja meg, ami tenyleg minden
    // agens inditasakor olvasodik ('dashboard+agents').
    const tulSzeles = SETTINGS_REGISTRY
      .filter(d => targetKind(d.restartTarget).sessions === 'all')
      .filter(d => d.restartTarget !== 'dashboard+agents')
      .map(d => d.key + '=' + d.restartTarget)
    expect(tulSzeles).toEqual([])
  })
})
