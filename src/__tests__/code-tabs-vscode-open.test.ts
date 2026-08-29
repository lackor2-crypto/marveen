// AMIT A FELHASZNALO LAT A VS CODE PANELEN, AZ LATSSZON A KARTYAN IS.
//
// Boss, 2026-08-28 (Telegram 649): "latom hogy ott van a listaban a 47 es
// kanban kartya nevu chat, de nem tudom kijelolni! miert? hiszen lattad hogy
// azt meg hasznalom a vscode ban. (...) viszont a 47 es kanban kartya nevu chat
// az elo, az nincs bezarva. az kellene."
//
// A MERT ok: a kartya eddig a FUTO FOLYAMATOT ismerte (`live`), es egy nyitott,
// de eppen tetlen fulhoz nem fut folyamat. Merve ugyanaznap: a 3d3f27b8
// beszelgeteshez 22:45:09-ig nem futott claude.exe, kozben a VS Code panelen
// ott volt. A "nyitott ful" es a "futo folyamat" KET KULONBOZO dolog.
//
// Amit ezek a tesztek oriznek:
//   * a VS Code listajaban szereplo beszelgetes a FO listaba kerul, akkor is,
//     ha eppen nem fut -- ott kijelolheto, es ezt kerte a tulajdonos;
//   * 2026-08-29 ota A VS CODE LISTAJA A DONTO, ha meg tudtuk nezni: ami fut,
//     de a panelen nincs ott, az NEM ful (a kartya 12-t mutatott 2 helyett).
//     A `live` csak ott tolt ki, ahol az adott fulrol NINCS VS Code-meres;
//   * ami emiatt kiesik a fo listabol, de FUT, az a closedTabs-ban elerheto
//     marad -- kulonben egy beragadt folyamatot nem lehetne leallitani;
//   * ha LATJUK a VS Code listajat, a maradek NEM kerul kulon dobozba
//     (Boss: "ezek a tobbiek amik mar be voltak zarva nem erdekesek");
//   * a NULLA KET DOLGOT JELENTHET: ha NEM latjuk a VS Code listajat, a regi
//     viselkedes marad -- olyankor a `live === false` meg nem bizonyitja, hogy
//     a ful be van zarva, es egy nyitott beszelgetes tunne el nyomtalanul.

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
// A meres szereploi: a futo beszelgetes es az, amelyik a panelen nyitva van,
// de nem fut. A harmadik sem nem fut, sem nincs a VS Code listajaban.
const RUNNING = 'aaaaaaaa-0000-4000-8000-000000000001'
const LISTED_ONLY = 'bbbbbbbb-0000-4000-8000-000000000002'
const GONE = 'cccccccc-0000-4000-8000-000000000003'

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

/** A 2026-08-28-an MERT allapot: egy futo beszelgetes, egy csak a VS Code
 *  listajaban szereplo (nyitott ful, nem fut), es egy, ami sehol nincs. */
function reportMeasuredState(): void {
  recordCodeWorkerSeen('WINPC', 'discovery', 3)
  recordCodeCandidates('WINPC', [
    { workspacePath: WS, sessionId: RUNNING, mtime: 3000, title: 'MT4 CSV elemzes', primary: true, live: true, vscodeOpen: false, pid: 9908 },
    { workspacePath: WS, sessionId: LISTED_ONLY, mtime: 2000, title: '47-es kanban kartya', primary: false, live: false, vscodeOpen: true },
    { workspacePath: WS, sessionId: GONE, mtime: 1000, title: 'Regen bezart beszelgetes', primary: false, live: false, vscodeOpen: false },
  ])
}

/** Ugyanaz az allapot, de a CELPONT (current) az, amit a VS Code listaz.
 *  A `current` fulet ugyanis SOSEM dobjuk el -- oda megy a feladat, ha senki
 *  nem valaszt kulon --, es az elozo fixture-ben eppen a futo ful volt a
 *  celpont. Az "ami fut, de nincs a listaban" szabalyt tehat csak igy lehet
 *  tisztan megmerni: kulonben a `current` szabaly fedne el az eredmenyt. */
function reportRunningNotListed(): void {
  recordCodeWorkerSeen('WINPC', 'discovery', 3)
  recordCodeCandidates('WINPC', [
    { workspacePath: WS, sessionId: LISTED_ONLY, mtime: 3000, title: '47-es kanban kartya', primary: true, live: false, vscodeOpen: true },
    { workspacePath: WS, sessionId: RUNNING, mtime: 2000, title: 'Fut, de a panelen nincs ott', primary: false, live: true, vscodeOpen: false, pid: 9908 },
    { workspacePath: WS, sessionId: GONE, mtime: 1000, title: 'Regen bezart beszelgetes', primary: false, live: false, vscodeOpen: false },
  ])
}

describe('a VS Code panelen nyitott beszelgetes a FO listaba kerul', () => {
  it('a nyitott, de nem futo ful ott van a fo listaban -- ez volt a bejelentes', () => {
    reportMeasuredState()
    const g = listCodeTabs().projects[0]!
    expect(g.tabs.map((t) => t.sessionId)).toContain(LISTED_ONLY)
    const tab = g.tabs.find((t) => t.sessionId === LISTED_ONLY)!
    // A ket meres KULON marad: nem fut, de nyitva van. Ha ezeket osszemosnank,
    // visszakapnank a hibat.
    expect(tab.live).toBe(false)
    expect(tab.vscodeOpen).toBe(true)
  })

  it('A VS CODE LISTAJA A DONTO: ami fut, de a panelen nincs ott, az NEM ful', () => {
    // 2026-08-29 (Boss): "a vscode agent kartyajan megint tul sok a chat. a
    // vscode szofverben (...) csak kb 2 chat ablak van. a marveen ban meg vagy
    // 12. ezt a hibat mar javitottuk vagy 12 szer."
    //
    // Merve: 7 ful `live === true`, de csak 2 `vscodeOpen === true`. Az UNIO
    // 7-et mutatott. A kerdes nem az, hogy FUT-e valami, hanem hogy a
    // felhasznalo LATJA-E FULKENT -- erre egyedul a VS Code listaja a forras.
    //
    // A RUNNING ful itt `vscodeOpen === false`: fut, de a panelen nincs ott.
    // A fo listaba tehat nem valo. Ettol NEM veszik el -- lasd a kovetkezo
    // teszt: a `closedTabs`-ban elerheto marad, hogy le lehessen allitani.
    reportRunningNotListed()
    const g = listCodeTabs().projects[0]!
    expect(g.tabs.map((t) => t.sessionId)).toEqual([LISTED_ONLY])
  })

  it('egy KONKRET fulrol hianyzo meresnel a `live` tolti ki a hianyt', () => {
    // A projekt tobbi fulet megmertuk, de errol az EGYrol nincs VS Code-adat.
    // "Nem latok oda" != "nincs ott": ilyenkor a futo folyamat a legjobb
    // tudasunk, tehat a fo listaban marad.
    recordCodeWorkerSeen('WINPC', 'discovery', 2)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: LISTED_ONLY, mtime: 3000, title: 'Nyitva', primary: true, live: false, vscodeOpen: true },
      { workspacePath: WS, sessionId: RUNNING, mtime: 2000, title: 'Fut, nincs rola meres', primary: false, live: true },
    ])
    const g = listCodeTabs().projects[0]!
    expect(g.tabs.map((t) => t.sessionId).sort()).toEqual([LISTED_ONLY, RUNNING].sort())
  })

  it('a CELPONT (current) akkor is a fo listaban marad, ha a VS Code nem listazza', () => {
    // Ez nem kivetel a szabaly alol, hanem a lap mukodokepessege: a feladat
    // oda megy, ha senki nem valaszt kulon. Ha eltunne, a projekt
    // cimezhetetlennek latszana. A `reportMeasuredState` fixture-ben eppen a
    // futo (`vscodeOpen === false`) ful a celpont.
    reportMeasuredState()
    const g = listCodeTabs().projects[0]!
    const target = g.tabs.find((t) => t.current)!
    expect(target.sessionId).toBe(RUNNING)
    expect(target.vscodeOpen).toBe(false)
  })

  it('ami se nem fut, se nincs a VS Code listajaban, az nem kerul a fo listaba', () => {
    reportMeasuredState()
    const g = listCodeTabs().projects[0]!
    expect(g.tabs.map((t) => t.sessionId)).not.toContain(GONE)
  })
})

describe('ha latjuk a VS Code listajat, a "tobbi beszelgetes" doboz elmarad', () => {
  it('a valoban bezart beszelgetes nem kerul a closedTabs-ba sem -- felesleges', () => {
    // Boss, 2026-08-28: "ezek a tobbiek amik mar be voltak zarva nem
    // erdekesek. (...) ugy sem lehet rajuk kattintani". A GONE se nem fut, se
    // nincs a VS Code listajaban -- sehol nem jelenik meg.
    reportMeasuredState()
    const g = listCodeTabs().projects[0]!
    expect(g.closedTabs.map((t) => t.sessionId)).not.toContain(GONE)
  })

  it('DE ami FUT es kiesett a fo listabol, az elerheto marad -- kulonben nem lehetne leallitani', () => {
    // 2026-08-29: a fo listat a VS Code listaja donti el, igy a futo, de be nem
    // toltott ful kikerul onnan. Nyomtalanul viszont NEM tunhet el: 2026-08-23-an
    // pont egy beragadt, futo folyamatot kellett leallitani a kartyarol. Ha a
    // felulet nem mutatja, a felhasznalonak nincs mivel megfognia.
    reportRunningNotListed()
    const g = listCodeTabs().projects[0]!
    expect(g.closedTabs.map((t) => t.sessionId)).toEqual([RUNNING])
    expect(g.closedTabs[0]!.live).toBe(true)
  })

  it('DE ha NEM latunk oda, a regi viselkedes marad: a tobbi beszelgetes elerheto', () => {
    // Regi worker, vagy olvashatatlan VS Code allapotfajl: `vscodeOpen` sehol
    // nincs megmerve. Olyankor a `live === false` meg NEM bizonyitja, hogy a
    // ful be van zarva -- egy nyitott beszelgetes tunne el nyomtalanul.
    recordCodeWorkerSeen('WINPC', 'discovery', 2)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: RUNNING, mtime: 3000, title: 'MT4 CSV elemzes', primary: true, live: true, pid: 9908 },
      { workspacePath: WS, sessionId: LISTED_ONLY, mtime: 2000, title: '47-es kanban kartya', primary: false, live: false },
    ])
    const g = listCodeTabs().projects[0]!
    expect(g.tabs.map((t) => t.sessionId)).toEqual([RUNNING])
    expect(g.closedTabs.map((t) => t.sessionId)).toEqual([LISTED_ONLY])
    expect(g.closedTabs[0]!.vscodeOpen).toBeNull()
  })

  it('ha EGYIK forrast sem tudtuk megmerni, semmit nem szurunk ki', () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 2)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: RUNNING, mtime: 3000, title: 'egyik', primary: true },
      { workspacePath: WS, sessionId: LISTED_ONLY, mtime: 2000, title: 'masik', primary: false },
    ])
    const g = listCodeTabs().projects[0]!
    expect(g.tabs).toHaveLength(2)
    expect(g.closedTabs).toEqual([])
  })
})

describe('a meres vegigmegy a worker jelentesetol a feluletig', () => {
  it('a regi worker hianyzo mezoje `null`, nem `false` -- a ketto mast jelent', () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 1)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: RUNNING, mtime: 3000, title: 'egy', primary: true },
    ])
    expect(listCodeTabs().projects[0]!.tabs[0]!.vscodeOpen).toBeNull()
  })

  it('a /api/code/projects valasza tartalmazza a merest, nem csak a szerver tudja', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: RUNNING, pinned: true })
    reportMeasuredState()
    const out = await call('GET', '/api/code/projects')
    expect(out.status).toBe(200)
    const p = out.body.projects.find((x: any) => x.workspacePath === WS)
    expect(p).toBeTruthy()
    const listed = p.tabs.find((t: any) => t.sessionId === LISTED_ONLY)
    expect(listed).toBeTruthy()
    expect(listed.vscodeOpen).toBe(true)
    expect(listed.live).toBe(false)
    // A doboz, amit a tulajdonos feleslegesnek nevezett, ures marad.
    expect(p.closedTabs).toEqual([])
  })
})
