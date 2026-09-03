/**
 * UTASITAS-KULDES AZ ELO NEZET ALJAROL -- amit ez a fajl oriz.
 *
 * Boss (2026-09-02): "azt nem lehet veletlenul megcsinalni hogy az elo chatbe
 * en ne csak lassam hanem tudjak beleirni is? utasitast kiadni?" -- majd a
 * kikotes, ami az egesz funkciot eldontotte: "ha kulon szallat indit, akkor a
 * kontextust elvesztette (...) az tilos, azt ne csinaljunk. Ezt csak akkor
 * csinaljuk, hogyha ugyanabban a cset ablakban jelenik, meg ugyanabban a szaba
 * ir, mert a kontextus az fontos."
 *
 * ★ EZERT A LEGFONTOSABB SZABALY: a kuldes a MOST NEZETT session-be megy.
 *   A munkas `claude -p --resume <sessionId>`-val inditja, amitol a session_id
 *   ugyanaz marad es az elozmeny megvan (merve 2026-08-26, lasd a
 *   `scripts/windows/marvin-code-worker.ps1` fejlecet). Ha a cimzes lemaradna,
 *   a feladat a projekt LEGFRISSEBB beszelgetesebe menne -- vagyis akar egy
 *   masikba, csendben. Ez a fajl ezt a cimzest rogziti.
 *
 * ★ A NULLA KET DOLGOT JELENTHET. A kuldo sor negy KULON esetet mond:
 *   nem ez a fajta beszelgetes / ilyen fulrol senki nem tud / a mappa nincs
 *   bekotve a kod-hidba / a munkas nem jelentkezik. Es egy otodiket, amit a
 *   legkonnyebb elrontani: NEM MERTUK (nem ertuk el a szervert) -- az nem
 *   ugyanaz, mint hogy a munkas offline.
 *
 * A felulet dontese TISZTA FUGGVENY, ezert DOM nelkul fut: a `web/app.js`-bol
 * kiemelve, `new Function` alatt.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeCandidates,
  _resetCodeCandidates, recordCodeWorkerSeen, findCodeTabLocation,
  claimNextCodeTask,
} from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

const WS = 'C:\\ws\\tozsde'
const OPEN = 'aaaaaaaa-0000-4000-8000-000000000001'
const CLOSED = 'bbbbbbbb-0000-4000-8000-000000000002'
const UNKNOWN = 'dddddddd-0000-4000-8000-00000000000d'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
})

interface Captured { status: number; body: any }

async function call(method: string, target: string, body?: unknown): Promise<Captured> {
  // A `path` a lekerdezes NELKUL megy at (a kezelo `path === ...`-ra egyezik),
  // a query a `url`-ben utazik -- ugyanugy, ahogy az igazi szerver adja at.
  const path = target.split('?')[0]!
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from([Buffer.from(payload)]) as unknown as http.IncomingMessage
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  ;(req as any).headers = { 'content-type': 'application/json' }
  const out: Captured = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(String(chunk)) } catch { out.body = String(chunk) } } },
  } as unknown as http.ServerResponse
  const handled = await tryHandleCode({
    req, res, path, method, url: new URL('http://127.0.0.1:3420' + target),
  } as any)
  expect(handled).toBe(true)
  return out
}

/** Egy nyitott es egy bezart ful UGYANABBAN a mappaban. */
function reportTabs(): void {
  recordCodeWorkerSeen('WINPC', 'discovery', 2)
  recordCodeCandidates('WINPC', [
    { workspacePath: WS, sessionId: OPEN, mtime: 2000, title: 'EA javitas', primary: true, live: true },
    { workspacePath: WS, sessionId: CLOSED, mtime: 1000, title: 'regi kor', primary: false, live: false },
  ])
}

// ---------------------------------------------------------------------------
// SZERVER: a ful ES a kornyezete EGY bejarasbol
// ---------------------------------------------------------------------------

describe('findCodeTabLocation: a ful mellol a PROJEKT is megjon', () => {
  it('bekotott mappa -> a ful es a projekt-nev egyutt', () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: OPEN })
    reportTabs()
    const loc = findCodeTabLocation(OPEN)
    expect(loc).not.toBeNull()
    expect(loc!.tab.sessionId).toBe(OPEN)
    expect(loc!.project).toBe('tozsde')
    expect(loc!.workspacePath).toBe(WS)
    expect(loc!.workerOnline).toBe(true)
  })

  it('★ be nem kotott mappa -> `project: null`, nem talalt projekt-nev', () => {
    // Kuldeni csak projekt-nevvel lehet. Ha ilyenkor barmit visszaadnank
    // (a mappa nevet, az elso projektet), a feladat egy MASIK helyre menne.
    reportTabs()
    expect(findCodeTabLocation(OPEN)!.project).toBeNull()
  })

  it('BEZART ful is megtalalhato -- oda is lehet utasitast kuldeni', () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: OPEN })
    reportTabs()
    const loc = findCodeTabLocation(CLOSED)
    expect(loc).not.toBeNull()
    expect(loc!.tab.sessionId).toBe(CLOSED)
    expect(loc!.project).toBe('tozsde')
  })

  it('ismeretlen session -> `null` (nem ures ful, hanem NINCS ilyen)', () => {
    reportTabs()
    expect(findCodeTabLocation(UNKNOWN)).toBeNull()
    expect(findCodeTabLocation('')).toBeNull()
  })
})

describe('GET /api/code/conversation: a valasz elmondja, hova lehet kuldeni', () => {
  it('★ a KONNYU (`meta=1`) valasz IS viszi a projektet es a munkas allapotat', async () => {
    // A kovetes 2,5 masodpercenkent ezt kerdezi. Ha csak a teljes valasz vinne
    // a projektet, a kuldo sor mondata a megnyitas pillanataba ragadna be --
    // es percekkel kesobb is a REGI allapotot allitana.
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: OPEN })
    reportTabs()
    const res = await call('GET', `/api/code/conversation?session=${OPEN}&meta=1`)
    expect(res.body.meta).toBe(true)
    expect(res.body.project).toBe('tozsde')
    expect(res.body.workerOnline).toBe(true)
    // A konnyu ut tovabbra sem olvassa be a naplot.
    expect(res.body).not.toHaveProperty('entries')
  })

  it('a TELJES valasz ugyanazt mondja, mint a konnyu', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: OPEN })
    reportTabs()
    const full = await call('GET', `/api/code/conversation?session=${OPEN}`)
    const meta = await call('GET', `/api/code/conversation?session=${OPEN}&meta=1`)
    expect(full.body.project).toBe(meta.body.project)
    expect(full.body.workerOnline).toBe(meta.body.workerOnline)
  })

  it('★ nem latok a naploba (`no-path`), de a CIMZES megvan', async () => {
    // Ket kulon kerdes: a napló olvashatosaga, es hogy hova megy az utasitas.
    // A worker meg nem kuld napló-utat, de a ful es a projekt el -- ilyenkor a
    // kuldes MEHET, csak a lista marad ures.
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: OPEN })
    reportTabs()
    const res = await call('GET', `/api/code/conversation?session=${OPEN}`)
    expect(res.body.reason).toBe('no-path')
    expect(res.body.project).toBe('tozsde')
  })

  it('★ ilyen fulrol senki nem tud -> `no-session` ES `project: null`', async () => {
    reportTabs()
    const res = await call('GET', `/api/code/conversation?session=${UNKNOWN}`)
    expect(res.body.reason).toBe('no-session')
    expect(res.body.project).toBeNull()
    // NEM `false`: nem azt allitjuk, hogy a munkas offline -- azt, hogy errol
    // a fulrol nem tudunk semmit.
    expect(res.body.workerOnline).toBeNull()
  })
})

describe('★ a kuldes UGYANABBA a beszelgetesbe megy', () => {
  it('a nezett session-re cimzett feladat oda kerul, nem a legfrissebbe', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: OPEN })
    reportTabs()
    // A felulet pontosan ezt kuldi: projekt a beszelgetes-valaszbol, session a
    // NEZETT beszelgetesbol. A cel itt a regi (bezart) ful, nem a legfrissebb.
    const res = await call('POST', '/api/code/tasks', {
      project: 'tozsde', prompt: 'folytasd', origin: 'dashboard',
      requestedBy: 'dashboard', sessionId: CLOSED,
    })
    expect(res.status).toBe(201)
    expect(res.body.targetSessionId).toBe(CLOSED)
    // A felulet a valasz `id` mezojet mutatja vissza -- legyen is mit.
    expect(typeof res.body.id).toBe('string')
    expect(claimNextCodeTask('WINPC')!.sessionId).toBe(CLOSED)
  })
})

// ---------------------------------------------------------------------------
// FELULET: mikor lehet kuldeni, es mit mondunk, ha nem
// ---------------------------------------------------------------------------

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() nincs a web/app.js-ben`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() zarojelei nincsenek parban`)
}

const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf-8')

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const api = new Function(`
  ${extractFn(app, 'convSendState')}
  ${extractFn(app, 'convSendOutcome')}
  ${extractFn(app, 'convDraftSave')}
  ${extractFn(app, 'convDraftLoad')}
  return {
    convSendState: convSendState, convSendOutcome: convSendOutcome,
    convDraftSave: convDraftSave, convDraftLoad: convDraftLoad,
  }
`)() as {
  convSendState: (info: unknown) => { show: boolean; can: boolean; note: string | null }
  convSendOutcome: (
    sentSession: unknown, nowSession: unknown, sameWindow: boolean,
    taValue: string, sentText: string, ok: boolean,
  ) => { inRow: boolean; toast: boolean; clear: boolean }
  convDraftSave: (drafts: Map<string, string>, sessionId: unknown, text: string) => Map<string, string>
  convDraftLoad: (drafts: Map<string, string>, sessionId: unknown) => string
}

describe('convSendState: latszik-e a doboz, es lehet-e kuldeni', () => {
  const ok = { kind: 'code', reason: null, project: 'tozsde', workerOnline: true }

  it('minden rendben -> kuldheto, es a mondat a folytatast igeri', () => {
    expect(api.convSendState(ok)).toEqual({ show: true, can: true, note: 'conversation.send.ready' })
  })

  it('★ ugynok-naplo -> a doboz EL SEM JON (oda nem lehet utasitast kuldeni)', () => {
    const st = api.convSendState({ ...ok, kind: 'agent' })
    expect(st.show).toBe(false)
    expect(st.can).toBe(false)
  })

  it('hianyzo bemenet nem dob kivetelt, es nem kinal beviteli mezot', () => {
    expect(api.convSendState(null).show).toBe(false)
    expect(api.convSendState(undefined).show).toBe(false)
    expect(api.convSendState({}).show).toBe(false)
  })

  it('★ ilyen fulrol senki nem tud -> latszik, de nem kuldheto, sajat mondattal', () => {
    expect(api.convSendState({ ...ok, reason: 'no-session', project: null }))
      .toEqual({ show: true, can: false, note: 'conversation.send.no_session' })
  })

  it('★ a mappa nincs bekotve -> nem kuldheto, es MAS a mondat', () => {
    const st = api.convSendState({ ...ok, project: null })
    expect(st).toEqual({ show: true, can: false, note: 'conversation.send.no_project' })
    // A ket "nem megy" eset NEM ugyanaz a mondat: mas a kovetkezo lepes.
    expect(st.note).not.toBe('conversation.send.no_session')
  })

  it('★ a munkas nem jelentkezik -> KULDHETO (sorba all), de szolunk rola', () => {
    // Az utasitas nem vesz el: sorban all, es a munkas bejelentkezesekor indul.
    // Letiltani annyi volna, mint elvenni a felhasznalotol a lehetoseget -- a
    // helyes valasz a halk, igaz mondat.
    expect(api.convSendState({ ...ok, workerOnline: false }))
      .toEqual({ show: true, can: true, note: 'conversation.send.offline' })
  })

  it('★★ NEM MERTUK != a munkas offline -- a ketto KULON mondat', () => {
    // Ez a legkonnyebben elrontott sor: ha a hianyzo merest `false`-nak
    // vennenk, a felulet azt allitana, hogy a munkas nem jelentkezik, holott
    // csak MI nem ertuk el a szervert. A tippelt ok rosszabb a semminel.
    for (const unknown of [null, undefined, 'igen', 1]) {
      const st = api.convSendState({ ...ok, workerOnline: unknown })
      expect(st.can, String(unknown)).toBe(true)
      expect(st.note, String(unknown)).toBe('conversation.send.unknown')
    }
  })

  it('a napló olvashatatlansaga NEM tiltja a kuldest', () => {
    // `no-path` / `too-large` / `unsafe-path`: a NAPLOT nem latjuk, de a
    // beszelgetes el es a cimzes megvan.
    for (const reason of ['no-path', 'too-large', 'unsafe-path']) {
      expect(api.convSendState({ ...ok, reason }).can, reason).toBe(true)
    }
  })
})

describe('★ a bekotes forras-szintu garanciai', () => {
  it('a kuldes a NEZETT beszelgetesbe megy (`conversationSource.id`)', () => {
    // Enelkul a feladat a projekt legfrissebb fulebe menne -- csendes
    // felrekuldes, pont az ellentete annak, amiert a funkcio keszult.
    const fn = extractFn(app, 'convSendSubmit')
    expect(fn).toContain('sessionId: conversationSource.id')
    expect(fn).toContain("'/api/code/tasks'")
  })

  it('a kuldes pillanataban ujra megnezzuk, szabad-e', () => {
    // A gomb tiltasa csak a kepernyon van; a billentyu-parancs es a kozben
    // valtozo allapot mellett a dontest itt is meg kell hozni.
    expect(extractFn(app, 'convSendSubmit')).toContain('convSendState(conversationSendInfo)')
  })

  it('★ a kovetes minden kore FRISSITI a kuldes kornyezetet', () => {
    // "Ujra allitas elott ujra meg kell nezni": a mondat nem ragadhat be a
    // megnyitas pillanataba.
    expect(extractFn(app, 'convFollowTick')).toContain('convSendInfoFrom(d)')
  })

  it('★ elerhetetlen szervernel a PROJEKT nem vesz el, csak a munkas-allapot', () => {
    // Ha ilyenkor az egesz kornyezetet eldobnank, a doboz azt allitana, hogy a
    // mappa nincs bekotve -- ami talalgatas volna, nem meres.
    expect(extractFn(app, 'convFollowTick')).toContain('workerOnline: null')
  })

  it('★ bezaraskor a felig beirt utasitas ELTEVODIK, nem vesz el', () => {
    // A mezot uriteni kell (a kovetkezo megnyitas MAS beszelgetes lehet, es az
    // ott felejtett szoveg elkuldese csendes felrekuldes volna) -- de eldobni
    // nem szabad: egy veletlen Esc igy vitt el eddig egy gonddal megirt
    // utasitast. A ketto egyszerre csak ugy megy, ha a szoveg a SAJAT
    // beszelgetese melle kerul.
    const fn = extractFn(app, 'convFollowReset')
    expect(fn).toContain('conversationSendInfo = null')
    expect(fn).toContain("getElementById('conversationSendPrompt')")
    expect(fn).toContain('convDraftSave(convSendDrafts, convSendDraftFor, sendTa.value)')
    expect(fn).toContain("sendTa.value = ''")
    // ES lepteti az ablak-szamlalot, kulonben egy menet kozbeni kuldes valasza
    // a kovetkezo beszelgetes ala esne be.
    expect(fn).toContain('convSendEpoch++')
  })

  it('a doboz alapbol REJTVE erkezik a markupban', () => {
    expect(html).toMatch(/id="conversationSend"[^>]*class="conv-send"[^>]*hidden/)
  })

  it('★ a `[hidden]` tenyleg elrejti (a `display: flex` kulonben eroesebb)', () => {
    expect(css).toMatch(/\.conv-send\[hidden\]\s*\{[^}]*display:\s*none/)
  })

  // MERVE 2026-09-02 (Playwright, 1400 px-es ablak): a `width: min(920px, 96vw)`
  // ellenere 480 px allt a kepernyon, mert a fentebbi `.modal { max-width:
  // 480px }` elvagta. A "nagyobb ablak" tehat csak a forraskodban letezett
  // volna -- ezert nem eleg a `width`, es ezert kell az OSSZETETT valaszto.
  it('★ az ablak szelesseget nem vagja el a `.modal` 480 px-es korlatja', () => {
    const rule = /\.modal\.conversation-modal\s*\{[^}]*\}/.exec(css)
    expect(rule).not.toBeNull()
    expect(rule![0]).toMatch(/max-width:\s*min\(920px/)
    expect(rule![0]).toMatch(/width:\s*min\(920px/)
  })

  it('★ minden kepernyore kerulo szoveg KETNYELVU', () => {
    const keys = [
      'conversation.send.placeholder', 'conversation.send.btn', 'conversation.send.ready',
      'conversation.send.ready_help', 'conversation.send.offline', 'conversation.send.unknown',
      'conversation.send.no_project', 'conversation.send.no_session', 'conversation.send.sending',
      'conversation.send.sent', 'conversation.send.failed', 'conversation.send.empty',
      'conversation.send.too_long', 'conversation.send.sent_bg', 'conversation.send.network',
      'conversation.send.aria',
    ]
    for (const k of keys) {
      expect(hu, `hu.js: ${k}`).toContain(`'${k}'`)
      expect(en, `en.js: ${k}`).toContain(`'${k}'`)
    }
  })

  it('a kuldes hibajanal a TENYLEGES uzenet megy ki, nem tippelt ok', () => {
    const fn = extractFn(app, 'convSendSubmit')
    // Szerver-hiba: a szerver SAJAT valasza. A `cbErrText` a szerver
    // i18n-KULCSAT (`errorKey`) forditja a felulet nyelvere, ha van; kulonben a
    // nyers `error`; vegso soron a HTTP-kod. Igy a komuves nem gepi angol kodot
    // lat (Boss: "a user egy komuves"), de tippelt okot tovabbra sem irunk oda.
    expect(fn).toContain('cbErrText(d, r)')
    // Kivetel: a kivetel sajat uzenete. Sehol nem allitunk okot magunktol.
    expect(fn).toContain("(err && err.message) || String(err)")
    expect(fn).not.toMatch(/valoszinuleg|altalaban|szokott/i)
  })

  it('★ a HALOZATI bukas MAS mondat, mint a szerver-hiba', () => {
    // Nem talalgatas, hanem szerkezeti tudas: a `fetch` KIZAROLAG akkor dob, ha
    // a keres el sem jutott a szerverig -- a szerver hibaja mar valasszal jon.
    // A ketto mas kovetkezo lepest kivan, es eddig egy angol bongeszo-szoveg
    // ("Failed to fetch") allt a magyar mondat kozepen.
    const fn = extractFn(app, 'convSendSubmit')
    expect(fn).toContain("t('conversation.send.network')")
    const i = fn.indexOf("r = await fetch('/api/code/tasks'")
    const j = fn.indexOf("t('conversation.send.network')")
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
  })

  it('★ menet kozbeni gepeles nem oltja ki a "Kuldes…" jelzest', () => {
    // Eddig barmelyik leutes torolte a visszajelzest -- pont a legbizonytalanabb
    // pillanatban tunt volna el az egyetlen jel, hogy a kuldes fut.
    const i = app.indexOf("getElementById('conversationSendPrompt')?.addEventListener('input'")
    expect(i).toBeGreaterThan(-1)
    expect(app.slice(i, i + 400)).toContain('convSendMsg && !convSendBusy')
  })

  it('★ a beviteli mezonek NEVE is van, nem csak helyorzoje', () => {
    // A helyorzo eltunik, amint ir bele: a kepolvaso onnantol egy nevtelen
    // mezot mondana be.
    const m = /<textarea id="conversationSendPrompt"[\s\S]*?><\/textarea>/.exec(html)
    expect(m).not.toBeNull()
    expect(m![0]).toContain('data-i18n-aria-label="conversation.send.aria"')
    expect(m![0]).toMatch(/aria-label="[^"]+"/)
  })

  it('★ a mobil `.modal-agent-detail` szabaly OSSZETETT valasztoval all', () => {
    // Egy egyosztalyos `.modal-agent-detail` (0,1,0) nem tudja felulirni a
    // fentebbi `.modal.modal-agent-detail` (0,2,0) 900px-et: a sor eddig NEM
    // csinalt semmit, csak a szandekarol hazudott.
    expect(css).not.toMatch(/\n\s*\.modal-agent-detail\s*\{/)
    expect(css).toMatch(/\.modal\.modal-agent-detail\s*\{[^}]*max-width:\s*100%/)
  })
})

// ---------------------------------------------------------------------------
// ★ AMI A KULDES ALATT TORTENIK -- a valasz nem eshet MAS beszelgetes ala
// ---------------------------------------------------------------------------

describe('convSendOutcome: hova kerul a valasz, es szabad-e uriteni a mezot', () => {
  const S1 = 'session-egy'
  const S2 = 'session-ketto'

  it('ugyanaz az ablak, valtozatlan mezo, sikeres kuldes -> sor + urites', () => {
    expect(api.convSendOutcome(S1, S1, true, 'csinald meg', 'csinald meg', true))
      .toEqual({ inRow: true, toast: false, clear: true })
  })

  it('★ kozben BEZARTAK -> buborek, es a mezohez NEM nyulunk', () => {
    // A kuldo sor ilyenkor mar egy masik beszelgetesrol beszelne, a mezoben
    // pedig az ott epp begepelt szoveg all.
    const r = api.convSendOutcome(S1, S2, false, 'mas szoveg', 'csinald meg', true)
    expect(r.inRow).toBe(false)
    expect(r.toast).toBe(true)
    expect(r.clear).toBe(false)
  })

  it('★ kozben MASIK beszelgetesre valtott -> ott sem urulhet a mezo', () => {
    expect(api.convSendOutcome(S1, S2, false, 'csinald meg', 'csinald meg', true).clear).toBe(false)
  })

  it('★ ugyanazt a beszelgetest nyitotta ujra -> az elkuldott szoveg elfogy', () => {
    // Az ablak lepett (buborek jar), de a mezoben a SAJAT, mar elkuldott
    // szovege all -- azt itt is le kell venni, kulonben masodszor is elkuldi.
    const r = api.convSendOutcome(S1, S1, false, 'csinald meg', 'csinald meg', true)
    expect(r.toast).toBe(true)
    expect(r.clear).toBe(true)
  })

  it('★ kozben TOVABB GEPELT -> a mezot nem uritjuk', () => {
    expect(api.convSendOutcome(S1, S1, true, 'csinald meg, de maskepp', 'csinald meg', true).clear)
      .toBe(false)
  })

  it('★ SIKERTELEN kuldes -> a szoveg marad (azt kellene ujra megirnia)', () => {
    expect(api.convSendOutcome(S1, S1, true, 'csinald meg', 'csinald meg', false).clear).toBe(false)
  })

  it('hianyzo session nem urit veletlenul (ket `undefined` nem "ugyanaz")', () => {
    expect(api.convSendOutcome(undefined, undefined, true, '', '', true).clear).toBe(false)
    expect(api.convSendOutcome(null, null, true, 'x', 'x', true).clear).toBe(false)
  })
})

describe('piszkozat: beszelgetesenkent, es csak oda kerul vissza', () => {
  it('eltevés utan a SAJAT beszelgetesebe jon vissza', () => {
    const d = new Map<string, string>()
    api.convDraftSave(d, 'A', 'felig megirt utasitas')
    expect(api.convDraftLoad(d, 'A')).toBe('felig megirt utasitas')
  })

  it('★ MAS beszelgetesbe SOSEM -- ez volt a csendes felrekuldes veszelye', () => {
    const d = new Map<string, string>()
    api.convDraftSave(d, 'A', 'felig megirt utasitas')
    expect(api.convDraftLoad(d, 'B')).toBe('')
  })

  it('★ a kiuritett mezo TORLI a piszkozatot (nem jon vissza a regi szoveg)', () => {
    const d = new Map<string, string>()
    api.convDraftSave(d, 'A', 'valami')
    api.convDraftSave(d, 'A', '   ')
    expect(api.convDraftLoad(d, 'A')).toBe('')
    expect(d.has('A')).toBe(false)
  })

  it('session nelkul nem tesz el es nem ad vissza semmit', () => {
    const d = new Map<string, string>()
    api.convDraftSave(d, null, 'valami')
    expect(d.size).toBe(0)
    expect(api.convDraftLoad(d, null)).toBe('')
  })

  it('★ megnyitaskor a felulet tenyleg visszateszi a sajat piszkozatot', () => {
    const fn = extractFn(app, 'openCodeConversationModal')
    expect(fn).toContain('convSendDraftFor = sessionId')
    expect(fn).toContain('convDraftLoad(convSendDrafts, sessionId)')
    // A visszateves a `convFollowReset()` UTAN all -- kulonben a reset
    // ugyanabban a menetben ujra kiuritene a mezot.
    expect(fn.indexOf('convFollowReset()')).toBeLessThan(fn.indexOf('convDraftLoad('))
  })
})
