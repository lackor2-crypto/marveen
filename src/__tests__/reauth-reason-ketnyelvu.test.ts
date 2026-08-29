// A KARTYARA KERULO HIBAOK IS KETNYELVU.
//
// Boss, 2026-08-30: "a segedmunkas bejelentkezesnel latok egy not logged in
// feliratot. pedig most magyarra van allitva a felulet nyelve!"
//
// Merve (nem talalgatva): a /api/agents a `lackor3` sorra
// `reauthReason='Not logged in'`, `reauthReasonKey=None` erteket adta, es a
// kartya pontosan ezt a nyers, angol jelolot irta ki. A jelolo maga BIZONYITEK
// (a gep szo szerinti sora), ezert nem forditjuk le -- de a KEPERNYORE a
// felulet nyelven kell kerulnie, a nyers sor pedig a tooltipbe megy.
//
// Ez a teszt azt tartja karban, hogy egy UJ marker felvetele ne tudjon
// eszrevetlenul angol szoveget kirakni a magyar feluletre.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { detectReauthNeeded } from '../web/reauth-detect.js'

const HU = readFileSync('web/lang/hu.js', 'utf-8')
const EN = readFileSync('web/lang/en.js', 'utf-8')
const APP = readFileSync('web/app.js', 'utf-8')
const SRC = readFileSync('src/web/reauth-detect.ts', 'utf-8')

/** Minden jelolo egy panel-reszlettel, ami valoban kivaltja. */
const ESETEK: { nev: string; pane: string; kulcs: string }[] = [
  // Csak ez az egy jelolo all a panelen: a lista SORRENDJE szandekos, es a
  // 'Please run /login' elobb all -- ha mindketto latszik, az nyer.
  { nev: 'Not logged in', pane: 'Not logged in \u00b7 this session has no account',
    kulcs: 'agents.reauth.m_not_logged_in' },
  { nev: 'Invalid authentication credentials', pane: 'API Error: Invalid authentication credentials',
    kulcs: 'agents.reauth.m_invalid_credentials' },
  { nev: 'Please run /login', pane: 'Session ended. Please run /login to continue.',
    kulcs: 'agents.reauth.m_needs_login' },
  { nev: 'API Error: 401', pane: 'API Error: 401 rejected',
    kulcs: 'agents.reauth.m_api_401' },
  { nev: 'OAuth token expired', pane: 'OAuth token expired, re-auth needed',
    kulcs: 'agents.reauth.m_oauth_expired' },
  { nev: 'Invalid API key', pane: 'Invalid API key provided',
    kulcs: 'agents.reauth.m_invalid_api_key' },
  { nev: 'Session expired', pane: 'Your session has expired, run /login',
    kulcs: 'agents.reauth.m_session_expired' },
  { nev: 'first-run picker', pane: 'Select login method',
    kulcs: 'agents.reauth.m_first_run_picker' },
  { nev: 'first-run browser', pane: 'Use the url below to sign in',
    kulcs: 'agents.reauth.m_first_run_browser' },
]

describe('a kartyara kerulo ujrabejelentkezes-ok forditasi kulcsot kap', () => {
  for (const e of ESETEK) {
    it(`"${e.nev}" -> ${e.kulcs}`, () => {
      const r = detectReauthNeeded(e.pane)
      expect(r.needsReauth).toBe(true)
      expect(r.reasonKey).toBe(e.kulcs)
      // A nyers jelolo NEM tunhet el: ez a bizonyitek, ez megy a tooltipbe es
      // a naplokba. (Sose talalgasd a hiba okat -- olvasd ki a valodi sorbol.)
      expect(r.reason, e.nev).toBeTruthy()
    })
  }

  it('a naplobol vett, nem nevesitett hiba is kap kulcsot', () => {
    // "Invalid bearer token" horgonyzott hibasor: a BULLET_FAILURE_RX ismeri,
    // a marker-lista nem -- ez az altalanos ag.
    const r = detectReauthNeeded('\u23bf  Invalid bearer token \u00b7 request failed')
    expect(r.needsReauth).toBe(true)
    expect(r.reasonKey).toBe('agents.reauth.m_transcript_generic')
  })

  it('ha nincs baj, kulcs sincs', () => {
    expect(detectReauthNeeded('minden rendben, dolgozom').reasonKey).toBeUndefined()
  })
})

describe('a kulcsok mind a ket nyelven megvannak', () => {
  // A forrasbol szedjuk ossze, nem kezzel: igy egy UJ marker kulcsa is
  // azonnal bukik, ha valaki elfelejti leforditani.
  const kulcsok = [...SRC.matchAll(/reasonKey:[^\n]*?'([^']+)'/g)].map(m => m[1])

  it('a forrasban van is mit ellenorizni (a nulla ket dolgot jelenthet)', () => {
    // Ha ez a lista ures lenne, a tobbi teszt CSENDBEN atmenne -- ugy, hogy
    // valojaban semmit nem nezett meg.
    expect(kulcsok.length).toBeGreaterThanOrEqual(10)
  })

  it('MINDEN markernek van kulcsa (uj bejegyzes se csuszhasson at)', () => {
    const markerek = (SRC.match(/\{ rx: \//g) || []).length
    const kulcsosak = [...SRC.matchAll(/\{ rx: \/[\s\S]*?reasonKey:/g)].length
    expect(markerek).toBeGreaterThan(0)
    expect(kulcsosak).toBe(markerek)
  })

  for (const k of new Set(kulcsok)) {
    it(`hu + en: ${k}`, () => {
      expect(HU, `hu.js: ${k}`).toContain(`'${k}':`)
      expect(EN, `en.js: ${k}`).toContain(`'${k}':`)
    })
  }

  it('a tooltip kerete is ketnyelvu', () => {
    expect(HU).toContain("'agents.reauth.raw_tip':")
    expect(EN).toContain("'agents.reauth.raw_tip':")
  })
})

describe('a kartya nem irja ki a nyers, angol jelolot', () => {
  it('a piros sav szovege kulcsbol jon, a nyers jelolo a tooltipbe megy', () => {
    const i = APP.indexOf('class="agent-reauth-reason"')
    expect(i).toBeGreaterThan(-1)
    const sor = APP.slice(i, i + 400)
    // Ez volt a hiba: `agent.reauthReason` LATHATO szovegkent, forditas nelkul.
    expect(sor).not.toContain('escapeHtml(agent.reauthReasonKey ? t(agent.reauthReasonKey) : (agent.reauthReason')
    expect(sor).toContain("t(agent.reauthReasonKey) : t('agents.reauth.reason')")
    expect(sor).toContain("t('agents.reauth.raw_tip'")
  })
})
