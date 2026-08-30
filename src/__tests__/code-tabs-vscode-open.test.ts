// A "NYITOTT FUL" MERHETETLEN -- EZ A FAJL AZT ORZI, HOGY NE PROBALJUK UJRA.
//
// A fajl neve tortenelmi. 2026-08-30-ig ezek a tesztek azt a szabalyt oriztek,
// hogy "A VS CODE LISTAJA A DONTO": a kartya a VS Code
// `state.vscdb` -> `agentSessions.model.cache` kulcsabol olvasta ki, melyik
// beszelgetes van nyitva a panelen. A szabaly HAMIS VOLT, es 12 koron at ez
// hozta vissza ugyanazt a hibat.
//
// Az Anthropic sajat hibajegye (claude-code#74894) szo szerint:
//   "agentSessions.model.cache in state.vscdb: Contains entries exclusively
//    from a different provider (openai-codex), with no Claude Code entries.
//    This is NOT a reliable source."
//   "the actual session index appears to live in extension-host memory and
//    does not get correctly rebuilt/rehydrated on reopen."
//
// Merve 2026-08-30 12:02-kor: a DB 6 perccel korabban irodott, megis pontosan
// ket azonositot tartalmazott, mindketto elozo napi, es EGYIK SEM a ket akkor
// futo beszelgetes kozul valo. Boss ugyanekkor, kepernyokeppel: "eletfa van a
// jobb oldalt es bal oldalt egyelatalan nem latszik. nem a friss zhatet latom a
// maveenban."
//
// AMIT MOSTANTOL ORZUNK -- ket csoport, mindketto MERHETO jelbol:
//   * FUT MOST (`tabs`)        : `live === true` (elo folyamat) vagy `current`;
//   * LEGUTOBBI (`closedTabs`) : minden mas, a naplo VALODI utolso idobelyege
//     (`lastActivity`) szerint rendezve -- NEM a fajl mtime-ja szerint;
//   * a NULLA KET DOLGOT JELENTHET: ha a `live` sehol nem meres, nem
//     valogatunk szet semmit;
//   * a `vscodeOpen` mezo NEM LETEZIK tobbe -- se a jeloltben, se a fulben, se
//     az API valaszaban. Ha valaki visszateszi, ez a fajl bukik.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeCandidates,
  _resetCodeCandidates, listCodeTabs, recordCodeWorkerSeen,
} from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'

const WS = 'C:\\ws\\tozsde'
const RUNNING = 'aaaaaaaa-0000-4000-8000-000000000001'
const IDLE = 'bbbbbbbb-0000-4000-8000-000000000002'
const OLD = 'cccccccc-0000-4000-8000-000000000003'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
})

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
    req, res, path, method, url: new URL('http://127.0.0.1:3420' + path),
  } as any)
  expect(handled).toBe(true)
  return out
}

/** Egy futo beszelgetes es ket nem futo. A `primary` a futo -- ez all a
 *  legkozelebb a valos allapothoz. */
function reportMeasuredState(): void {
  recordCodeWorkerSeen('WINPC', 'discovery', 3)
  recordCodeCandidates('WINPC', [
    { workspacePath: WS, sessionId: RUNNING, mtime: 3000, lastActivity: 3000, title: 'MT4 CSV elemzes', primary: true, live: true, pid: 9908 },
    { workspacePath: WS, sessionId: IDLE, mtime: 2000, lastActivity: 2000, title: '47-es kanban kartya', primary: false, live: false },
    { workspacePath: WS, sessionId: OLD, mtime: 1000, lastActivity: 1000, title: 'Tegnapi beszelgetes', primary: false, live: false },
  ])
}

describe('KET CSOPORT: ami fut, es ami legutobb futott', () => {
  it('a FO listaba a futo beszelgetes kerul', () => {
    reportMeasuredState()
    const g = listCodeTabs().projects[0]!
    expect(g.tabs.map((t) => t.sessionId)).toEqual([RUNNING])
    expect(g.tabs[0]!.live).toBe(true)
  })

  it('ami nem fut, az NEM tunik el: a LEGUTOBBI csoportba kerul', () => {
    // A regi szabaly a "se nem fut, se nincs a VS Code listajaban" sorokat
    // nyomtalanul eldobta. Mivel a VS Code listajat nem lehet megmerni, ez
    // pont azt dobta el, amibe a felhasznalo gepelt.
    reportMeasuredState()
    const g = listCodeTabs().projects[0]!
    expect(g.closedTabs.map((t) => t.sessionId)).toEqual([IDLE, OLD])
  })

  it('a CELPONT (current) akkor is a fo listaban van, ha eppen nem fut', () => {
    // Oda megy a feladat, ha senki nem valaszt kulon. Ha eltunne, a projekt
    // cimezhetetlennek latszana.
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: IDLE, pinned: true })
    reportMeasuredState()
    const g = listCodeTabs().projects[0]!
    const target = g.tabs.find((t) => t.current)!
    expect(target.sessionId).toBe(IDLE)
    expect(target.live).toBe(false)
  })

  it('A NULLA KET DOLGOT JELENTHET: meres nelkul nem valogatunk szet semmit', () => {
    // Regi worker: egyetlen `live` meres sincs. Ez NEM azt jelenti, hogy semmi
    // nem fut -- olyankor minden sor a fo listaban marad.
    recordCodeWorkerSeen('WINPC', 'discovery', 2)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: RUNNING, mtime: 3000, title: 'egyik', primary: true },
      { workspacePath: WS, sessionId: IDLE, mtime: 2000, title: 'masik', primary: false },
    ])
    const g = listCodeTabs().projects[0]!
    expect(g.tabs).toHaveLength(2)
    expect(g.closedTabs).toEqual([])
  })
})

describe('A SORREND A NAPLO VALODI IDEJET koveti, nem a fajl mtime-jat', () => {
  it('egyforma mtime mellett a `lastActivity` dont -- ez volt a masodik hiba', () => {
    // Merve 2026-08-30: ot naplo mtime-ja EZREDMASODPERCRE megegyezett
    // (1788044767588), mert egy tomeges fajlmuvelet mindet atirta, mikozben a
    // valodi utolso uzenetuk 08-28 11:00 es 08-29 19:48 kozott szort. Az
    // mtime szerinti rendezes ilyenkor VELETLENSZERU sorrendet ad.
    recordCodeWorkerSeen('WINPC', 'discovery', 3)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: OLD, mtime: 1788044767588, lastActivity: 1000, title: 'legregebbi', primary: true, live: false },
      { workspacePath: WS, sessionId: RUNNING, mtime: 1788044767588, lastActivity: 3000, title: 'legfrissebb', primary: false, live: false },
      { workspacePath: WS, sessionId: IDLE, mtime: 1788044767588, lastActivity: 2000, title: 'kozepso', primary: false, live: false },
    ])
    const g = listCodeTabs().projects[0]!
    // A `primary` a celpont, tehat a fo listaban all; a tobbi a Legutobbiban,
    // a VALODI ido szerint.
    expect(g.closedTabs.map((t) => t.sessionId)).toEqual([RUNNING, IDLE])
  })

  it('ha nincs `lastActivity` (regi worker), a mtime-ra esunk vissza', () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 3)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: OLD, mtime: 1000, title: 'regi', primary: true, live: false },
      { workspacePath: WS, sessionId: RUNNING, mtime: 3000, title: 'uj', primary: false, live: false },
      { workspacePath: WS, sessionId: IDLE, mtime: 2000, title: 'kozepso', primary: false, live: false },
    ])
    const g = listCodeTabs().projects[0]!
    expect(g.closedTabs.map((t) => t.sessionId)).toEqual([RUNNING, IDLE])
    // Es a hianyzo meres `null` marad -- nem 0, nem a mtime bemasolva. A
    // felulet ebbol tudja, hogy amit kiir, csak kozelites.
    expect(g.closedTabs[0]!.lastActivity).toBeNull()
  })

  it('a 0 es a negativ ertek nem meres, hanem hianyzo adat', () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 1)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: RUNNING, mtime: 3000, lastActivity: 0, title: 'egy', primary: true, live: true },
    ])
    expect(listCodeTabs().projects[0]!.tabs[0]!.lastActivity).toBeNull()
  })
})

describe('a `vscodeOpen` fogalma NEM TERHET VISSZA', () => {
  it('a jelentesbol erkezo `vscodeOpen` mezo nyomtalanul eltunik', () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 1)
    // Egy REGI worker meg kuldheti. Nem szabad, hogy barmit befolyasoljon.
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: RUNNING, mtime: 3000, title: 'egy', primary: true, live: true, vscodeOpen: false } as any,
      { workspacePath: WS, sessionId: IDLE, mtime: 2000, title: 'ketto', primary: false, live: false, vscodeOpen: true } as any,
    ])
    const g = listCodeTabs().projects[0]!
    expect(g.tabs[0]).not.toHaveProperty('vscodeOpen')
    // A `vscodeOpen: true` NEM emeli be a fo listaba: csak a futas szamit.
    expect(g.tabs.map((t) => t.sessionId)).toEqual([RUNNING])
    expect(g.closedTabs.map((t) => t.sessionId)).toEqual([IDLE])
  })

  it('a /api/code/projects valasza `lastActivity`-t ad, `vscodeOpen`-t nem', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: RUNNING, pinned: true })
    reportMeasuredState()
    const out = await call('GET', '/api/code/projects')
    expect(out.status).toBe(200)
    const p = out.body.projects.find((x: any) => x.workspacePath === WS)
    expect(p).toBeTruthy()
    const run = p.tabs.find((t: any) => t.sessionId === RUNNING)
    expect(run).toBeTruthy()
    expect(run).not.toHaveProperty('vscodeOpen')
    expect(run.lastActivity).toBe(3000)
    expect(run.live).toBe(true)
    // A tobbi beszelgetes elerheto marad -- ez a "Legutobbi" csoport.
    expect(p.closedTabs.map((t: any) => t.sessionId)).toEqual([IDLE, OLD])
  })
})
