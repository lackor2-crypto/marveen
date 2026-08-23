// A "tallozas" helyett: a worker sajat felderitesi jelentese a valaszthato
// lista. Boss (2026-08-22): "miert nem lehet kitallozni a projekt mappat? ...
// miert kellene kezzel megadnom az eleresi utvonalat? hiszen en egy komuves
// vagyok! hulyebiztosra kell megcsinalni a szoftvert! ... es mit irjak a UUID
// hez? kotelezo? nem? hol vannak a magyarazatok?"
//
// Negy dolgot rogzitenek az itteni tesztek:
//
//   * a felderitett mappak listaja a jelentes ELOTT szurve NINCS -- kulonben a
//     kizart mappa (a Boss egyetlen projektje!) lathatatlan maradna, es a lap
//     ugy nezne ki, mintha a felderites nem talalna semmit;
//   * a jelentes a gepre AUTORITAS: ami kikerult belole, az eltunik a listabol
//     is (nem marad ott egy bezart projekt, amit fel lehetne venni);
//   * a session-UUID-t nem kell begepelni: a szerver a jelentesbol tolti ki --
//     zaro visszaper vagy nagybetu miatt sem kuldunk senkit UUID-t vadaszni;
//   * a felulet minden mezoje mellett OTT A MAGYARAZAT, es a kezi urlap
//     megmondja, mikor kotelezo megis az azonosito.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession,
  recordCodeCandidates, listCodeCandidates, _resetCodeCandidates,
} from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'

const ROOT = process.cwd()
const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8')
const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8')

const WS = 'D:\\Tozsde_telepitesi_mappa'
const SID = 'aaaaaaaa-0000-4000-8000-000000000001'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
})

// --- egy keresre eleg mini HTTP-allvany ------------------------------------

interface Captured { status: number; body: any }

async function call(method: string, path: string, body?: unknown): Promise<Captured> {
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
    req, res, path, method,
    url: new URL('http://127.0.0.1:3420' + path),
  } as any)
  expect(handled).toBe(true)
  return out
}

describe('felderitett mappak: a jeloltlista', () => {
  it('keeps what discovery filters out -- path AND session id, ready to use', async () => {
    // Ez a hiba maga: a Boss egyetlen VS Code workspace-e ki volt zarva, tehat
    // a projektlistaban nem szerepelt, es semmi nem mondta meg, MIERT. A
    // jeloltlista a szures ELOTTI allapotot mutatja, allapot-cimkevel.
    recordCodeCandidates('WINPC', [{ workspacePath: WS, sessionId: SID, mtime: 1000 }])
    const res = await call('GET', '/api/code/candidates')
    expect(res.body.candidates).toHaveLength(1)
    expect(res.body.candidates[0].workspacePath).toBe(WS)
    expect(res.body.candidates[0].sessionId).toBe(SID)
    expect(['registered', 'excluded', 'new']).toContain(res.body.candidates[0].state)
  })

  it('the excluded state comes from the SAME rule the queue rejects on', () => {
    // A kizarasi lista indulaskor beolvasott const, ezert egy egysegteszt nem
    // tudja atallitani. Amit rogziteni tudunk -- es ami a lenyeg --, hogy a
    // jeloltlista ugyanazt a fuggvenyt kerdezi, mint az enqueue: kulonben a
    // lap "Felvetel" gombot kinalna olyan mappara, amit a szerver 400-zal utasit
    // vissza.
    const route = readFileSync(join(ROOT, 'src/web/routes/code.ts'), 'utf8')
    const block = route.slice(route.indexOf("path === '/api/code/candidates'"), route.indexOf("path === '/api/code/projects' && method === 'GET'"))
    expect(block).toContain('isExcludedProject(alias)')
    expect(block).toContain("'excluded'")
  })

  it('marks an already-registered workspace as registered, under ITS OWN alias', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: SID })
    recordCodeCandidates('WINPC', [{ workspacePath: WS, sessionId: SID, mtime: 1000 }])
    const res = await call('GET', '/api/code/candidates')
    expect(res.body.candidates[0].state).toBe('registered')
    expect(res.body.candidates[0].alias).toBe('tozsde')
  })

  it('a new folder gets the folder name as its suggested alias', async () => {
    recordCodeCandidates('WINPC', [{ workspacePath: 'C:\\ws\\TradingBot', sessionId: SID, mtime: 1 }])
    const res = await call('GET', '/api/code/candidates')
    expect(res.body.candidates[0].state).toBe('new')
    expect(res.body.candidates[0].alias).toBe('tradingbot')
  })

  it('the report is authoritative FOR ITS OWN MACHINE and no other', () => {
    recordCodeCandidates('WINPC', [
      { workspacePath: 'C:\\a', sessionId: 's1', mtime: 1 },
      { workspacePath: 'C:\\b', sessionId: 's2', mtime: 2 },
    ])
    recordCodeCandidates('LAPTOP', [{ workspacePath: 'C:\\c', sessionId: 's3', mtime: 3 }])
    // Egy bezart projekt eltunik a sajat gepe listajabol...
    recordCodeCandidates('WINPC', [{ workspacePath: 'C:\\a', sessionId: 's1', mtime: 4 }])
    const paths = listCodeCandidates().map((c) => c.workspacePath).sort()
    // ...de a masik gepet nem viszi magaval.
    expect(paths).toEqual(['C:\\a', 'C:\\c'])
  })

  it('drops a half-reported row instead of offering an unusable one', () => {
    recordCodeCandidates('WINPC', [
      { workspacePath: 'C:\\a' },
      { sessionId: 's2' },
      { workspacePath: 'C:\\c', sessionId: 's3' },
    ] as any)
    expect(listCodeCandidates().map((c) => c.workspacePath)).toEqual(['C:\\c'])
    expect(listCodeCandidates()[0]!.mtime).toBe(null)
  })

  it('caps the list so one machine cannot grow it without bound', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ workspacePath: 'C:\\p' + i, sessionId: 's' + i, mtime: i }))
    recordCodeCandidates('WINPC', many)
    expect(listCodeCandidates().length).toBeLessThanOrEqual(200)
  })
})

describe('a session-UUID-t nem kell begepelni', () => {
  it('fills the session id in from the worker report', async () => {
    recordCodeCandidates('WINPC', [{ workspacePath: 'C:\\ws\\TradingBot', sessionId: SID, mtime: 1 }])
    const res = await call('POST', '/api/code/projects', {
      project: 'tradingbot', workspacePath: 'C:\\ws\\TradingBot', pinned: true,
    })
    expect(res.status).toBe(200)
    expect(res.body.sessionId).toBe(SID)
  })

  it('a trailing backslash or a capital letter does not send anyone hunting for a UUID', async () => {
    recordCodeCandidates('WINPC', [{ workspacePath: 'C:\\ws\\TradingBot', sessionId: SID, mtime: 1 }])
    const res = await call('POST', '/api/code/projects', {
      project: 'tradingbot', workspacePath: 'c:\\WS\\tradingbot\\',
    })
    expect(res.status).toBe(200)
    expect(res.body.sessionId).toBe(SID)
  })

  it('says WHY it still needs one when the worker has never seen that folder', async () => {
    const res = await call('POST', '/api/code/projects', {
      project: 'tradingbot', workspacePath: 'C:\\ws\\Unknown',
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('has not reported a session')
  })

  it('an explicitly given id always wins over the reported one', async () => {
    recordCodeCandidates('WINPC', [{ workspacePath: 'C:\\ws\\TradingBot', sessionId: SID, mtime: 1 }])
    const res = await call('POST', '/api/code/projects', {
      project: 'tradingbot', workspacePath: 'C:\\ws\\TradingBot', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002',
    })
    expect(res.body.sessionId).toBe('bbbbbbbb-0000-4000-8000-000000000002')
  })
})

describe('a felulet nem ker begepelt utvonalat', () => {
  it('shows the discovered folders as a list, with a one-click add', () => {
    expect(html).toContain('id="cbCandidatesBox"')
    expect(app).toContain('function cbRenderCandidates(')
    expect(app).toContain("cbFetch('/api/code/candidates')")
    expect(app).toContain('cb-cand-add')
  })

  it('offers to lift the exclusion instead of leaving the folder unexplained', () => {
    // Kizart mappat felvenni nem lehet (a szerver 400-at ad ra), tehat a
    // "Felvetel" gomb ott hazudna. A teendo a kizaras feloldasa -- ES az
    // ujrainditas-gomb ott, ahol a muvelet tortent.
    expect(app).toContain('cb-cand-unexclude')
    expect(app).toContain("cbMountRestart('cbCandRestart'")
    expect(html).toContain('id="cbCandRestart"')
  })

  // A projektek-kartya markupja. Szandekosan NEM a kovetkezo kartyaig vagunk:
  // a fulekre bontas ota a kartyak sorrendje mas fulon van, es egy sorrendre
  // horgonyzott szelet uresen is "atmenne" barmilyen tartalmi allitason.
  const cbProjectsCardHtml = () => {
    const at = html.indexOf('id="cbProjectsCard"')
    expect(at, 'cbProjectsCard nincs a lapon').toBeGreaterThan(-1)
    return html.slice(at)
  }

  it('every field of the manual form carries its own explanation', () => {
    const form = cbProjectsCardHtml()
    for (const id of ['cbAddProject', 'cbAddWorkspace', 'cbAddSession']) {
      const at = form.indexOf('id="' + id + '"')
      expect(at, id + ' hianyzik az urlapbol').toBeGreaterThan(-1)
      // A magyarazat a mezo utan, meg a kovetkezo mezo elott.
      const rest = form.slice(at, at + 900)
      expect(rest, id + ' mellett nincs magyarazat').toContain('cb-hint')
    }
  })

  it('answers the "is the UUID mandatory" question in the form itself', () => {
    const form = cbProjectsCardHtml()
    // Ket kotelezo mezo es egy nem kotelezo -- kimondva, nem kitalalva.
    expect(form).toContain('cb-req')
    expect(form).toContain('cb-opt')
    const uuidAt = form.indexOf('id="cbAddSession"')
    expect(form.slice(Math.max(0, uuidAt - 400), uuidAt)).toContain('cb-opt')
  })

  it('the "lift exclusion" button disappears once the lift is SAVED', () => {
    // Elozo kor tanulsaga: "a gomb, ami nem tunik el, ugyanolyan rossz, mint a
    // hianyzo gomb". A kizaras indulaskor beolvasott ertek, tehat a mentes utan
    // a sor MEG MINDIG 'excluded' -- ha a gomb ottmarad, a felhasznalo azt hiszi,
    // nem tortent semmi, es ujra meg ujra rakattint.
    const fn = app.slice(app.indexOf('function cbRenderCandidates('), app.indexOf('function cbRenderTasks('))
    expect(fn).toContain('_cbSavedExclude')
    expect(fn).toContain('újraindítás után lép életbe')
    // Az allapot a MENTETT listabol jon, nem egy helyi zaszlobol: igy egy
    // lapfrissites utan is helyes marad.
    expect(app).toContain('_cbSavedExclude = cbNormList(cfg.CODE_BRIDGE_EXCLUDE, true)')
  })

  it('warns in Hungarian BEFORE the server answers in English', () => {
    // A szerver hibauzenete angol; ha a lap tovabbengedi, az a felhasznalo ele
    // kerul. A kezi urlap ezert maga ellenorzi a harom esetet.
    // A kattintas-kezelo esemeny-valtozoja `tgt` (2026-08-23: korabban `t` volt,
    // ami LEARNYEKOLTA a `t()` fordito fuggvenyt -- lasd
    // i18n-t-not-shadowed.test.ts). A horgony ezert nem kotodik a valtozo
    // nevehez: a gomb AZONOSITOJAT keressuk, nem azt, mi hivatkozik ra.
    const from = app.indexOf("'cbAddBtn')")
    const to = app.indexOf("'cbBotSaveBtn'", from)
    expect(from, 'a cbAddBtn kezeloje nincs meg a lapon').toBeGreaterThan(-1)
    expect(to, 'a cbBotSaveBtn kezeloje nincs meg a lapon').toBeGreaterThan(from)
    const handler = app.slice(from, to)
    expect(handler).toContain('Adj nevet a projektnek')
    expect(handler).toContain('Add meg a projekt mappáját')
    expect(handler).toContain('a session-azonosító most kötelező')
    expect(handler).toContain('cbSamePath(')
  })
})

describe('a nulla-projektes kartya a KOVETKEZO LEPEST mondja', () => {
  it('health counts the folders discovery found but nobody registered yet', async () => {
    // A kartya ezekbol a szamokbol tudja meg, hogy van-e egyaltalan mit
    // felvenni. Kizarasra a boot-ideju CODE_BRIDGE_EXCLUDE dont, ezt egy
    // teszt nem tudja atallitani -- ezert az OSSZEGET rogzitjuk: a jelentett
    // mappa vagy felvehetokent, vagy kizartkent, de MEGJELENIK a kartyan.
    recordCodeCandidates('WINPC', [{ workspacePath: WS, sessionId: SID, mtime: 1000 }])
    const res = await call('GET', '/api/code/health')
    expect(res.body.candidates.free + res.body.candidates.excluded).toBe(1)
  })

  it('a folder already registered is not offered again', async () => {
    // Kulonben a kartya orokke azt allitana, hogy "1 felveheto mappa" olyan
    // projektnel, ami mar reg fel van veve.
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: SID, host: 'WINPC' })
    recordCodeCandidates('WINPC', [{ workspacePath: WS + '\\', sessionId: SID, mtime: 1000 }])
    const res = await call('GET', '/api/code/health')
    expect(res.body.candidates.free).toBe(0)
    expect(res.body.candidates.excluded).toBe(0)
  })

  it('the card stops telling the owner to open a project he already has open', () => {
    // Ez volt a rossz tanacs: a Boss egyetlen workspace-e NYITVA volt, csak
    // kizarva -- a kartya megis uj projekt nyitasat kerte tole.
    expect(app).toContain("' felvehető mappa'")
    expect(app).toContain("' kizárt mappa'")
    expect(app).toMatch(/cand\.excluded > 0/)
    // Regi backend (nincs `candidates` a valaszban) nem torheti el a kartyat.
    expect(app).toMatch(/health\.candidates && health\.candidates\.free/)
  })
})
