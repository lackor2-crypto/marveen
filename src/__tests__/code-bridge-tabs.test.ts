// CHAT FULEK -- egy mappa, tobb beszelgetes.
//
// Boss (2026-08-23): "a vscode ban latok tobb chat fulet. a marvinban az ugynok
// kartyan ki lehet valasztani hogy melyik chat fulelbe akarok irni? mert egy
// egy chat ful mas mas munkamenet." Majd, miutan a nevadas-alapu tervet
// elvetette: "nem fogok en foglalkozni ezzel ... majd fogom kerni a maximum
// azt, hogy listazza ki, hogy milyen chatfulek vannak, es akkor a Marvin-ban
// fogom kerni a Marvin ugynokot, hogy adja ki a parancsot".
//
// Ezert LISTA + CIMZES, nem elnevezes: a `listCodeTabs()` mondja meg, mi van,
// es a feladat egy opcionalis `sessionId`-vel megy egy KONKRET fulbe.
//
// Amit ezek a tesztek oriznek:
//   * a kartya tovabbra is a MAPPA (egy sor mappankent), a fulek alatta vannak;
//   * a "hova menne cimzes nelkul" a REGISZTRALT session, nem a legfrissebb;
//   * a NULLA ket dolgot jelenthet: "nincs beszelgetes" vs "nem latok oda" --
//     a `reason` mezo a kettot KULON mondja, nem a lista hosszabol kell kitalalni;
//   * a rovid azonosito (amit a lista mutat) ervenyes cimzes, de tobbertelmuen SOSE;
//   * egy REGI worker (nem kuld `primary`-t) viselkedese valtozatlan.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeCandidates,
  _resetCodeCandidates, listCodeTabs, enqueueCodeTask, claimNextCodeTask,
  recordCodeWorkerSeen, WORKER_STALE_MS, listCodeSessions,
} from '../web/code-bridge-store.js'
import { displayBotName } from '../web/code-bridge-telegram.js'
import { tryHandleCode } from '../web/routes/code.js'
import { writeBrokerConfig } from '../web/context-broker-store.js'
import { mkdirSync } from 'node:fs'
import { STORE_DIR } from '../config.js'

const WS = 'C:\\ws\\tozsde'
const OLD = 'aaaaaaaa-0000-4000-8000-000000000001'
const NEW = 'bbbbbbbb-0000-4000-8000-000000000002'

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

/** Ket ful UGYANABBAN a mappaban, ahogy a worker jelenti: a legfrissebb a
 *  `primary`, a masik cimezheto marad. */
function reportTwoTabs(): void {
  recordCodeWorkerSeen('WINPC', 'discovery', 2)
  recordCodeCandidates('WINPC', [
    { workspacePath: WS, sessionId: NEW, mtime: 2000, title: 'EA stop-loss javitas', primary: true },
    { workspacePath: WS, sessionId: OLD, mtime: 1000, title: 'MT5 atallasi terv', primary: false },
  ])
}

describe('chat fulek: a lista', () => {
  it('egy mappa = egy csoport, a fulek benne idorendben', () => {
    reportTwoTabs()
    const view = listCodeTabs()
    expect(view.projects).toHaveLength(1)
    expect(view.projects[0]!.workspacePath).toBe(WS)
    expect(view.projects[0]!.tabs.map((t) => t.sessionId)).toEqual([NEW, OLD])
    expect(view.projects[0]!.tabs.map((t) => t.title)).toEqual(['EA stop-loss javitas', 'MT5 atallasi terv'])
    expect(view.reason).toBe('ok')
  })

  it('a "cimzes nelkul ide megy" a REGISZTRALT session, nem a legfrissebb', () => {
    // Ez a kituzes ertelme: ha a projekt a REGI fulre van bekotve, a lista nem
    // allithatja, hogy az uj kapja a feladatot -- kulonben mast mutatna, mint
    // ami tortenne.
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: OLD, pinned: true })
    reportTwoTabs()
    const tabs = listCodeTabs().projects[0]!.tabs
    expect(tabs.find((t) => t.sessionId === OLD)!.current).toBe(true)
    expect(tabs.find((t) => t.sessionId === NEW)!.current).toBe(false)
  })

  it('a be nem kotott mappa NEM kap projekt-nevet -- a kettot nem mossuk ossze', () => {
    reportTwoTabs()
    const g = listCodeTabs().projects[0]!
    expect(g.project).toBeNull()
    expect(g.currentSessionId).toBeNull()
    // Cimzes nelkul a legfrissebbre esne a valasztas, ezt mutatja is:
    expect(g.tabs.find((t) => t.current)!.sessionId).toBe(NEW)
  })
})

describe('chat fulek: a NULLA ket dolgot jelenthet', () => {
  it('ha a worker meg SOHA nem jelentkezett, azt mondja -- nem azt, hogy nincs ful', () => {
    const view = listCodeTabs()
    expect(view.projects).toHaveLength(0)
    expect(view.reason).toBe('worker-never')
    expect(view.note).toMatch(/NEM azt jelenti/)
  })

  it('ha a worker EL es tenyleg nincs beszelgetes, az MAS uzenet', () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 0)
    const view = listCodeTabs()
    expect(view.reason).toBe('empty')
    expect(view.workerOnline).toBe(true)
  })

  it('ha a worker regen jelentkezett, a lista ELAVULT lehet -- es ezt kimondja', () => {
    const now = Date.now()
    recordCodeWorkerSeen('WINPC', 'discovery', 2, now - WORKER_STALE_MS - 1000)
    recordCodeCandidates('WINPC', [{ workspacePath: WS, sessionId: NEW, mtime: 2000, primary: true }])
    const view = listCodeTabs(now)
    expect(view.reason).toBe('worker-stale')
    expect(view.projects).toHaveLength(1)
  })
})

describe('chat fulek: cimzes', () => {
  beforeEach(() => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: NEW })
    reportTwoTabs()
  })

  it('a lista ROVID azonositoja ervenyes cimzes', () => {
    const out = enqueueCodeTask({ project: 'tozsde', prompt: 'nezd meg', sessionId: OLD.slice(0, 8) })
    expect('task' in out).toBe(true)
    expect((out as any).task.targetSessionId).toBe(OLD)
  })

  it('a megcimzett ful erosebb, mint a projekt aktualis beszelgetese', () => {
    const out = enqueueCodeTask({ project: 'tozsde', prompt: 'nezd meg', sessionId: OLD })
    expect('task' in out).toBe(true)
    const claimed = claimNextCodeTask('WINPC')
    expect(claimed!.sessionId).toBe(OLD)
  })

  it('cimzes NELKUL minden marad a regiben: a projekt sessionje fut', () => {
    const out = enqueueCodeTask({ project: 'tozsde', prompt: 'nezd meg' })
    expect('task' in out).toBe(true)
    expect((out as any).task.targetSessionId).toBeNull()
    expect(claimNextCodeTask('WINPC')!.sessionId).toBe(NEW)
  })

  it('tobbertelmu rovidites BUKIK -- talalgatva rossz fulbe irna', () => {
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: 'cccccccc-0000-4000-8000-000000000003', mtime: 3000, title: 'A', primary: true },
      { workspacePath: WS, sessionId: 'cccccccc-0000-4000-8000-000000000004', mtime: 2000, title: 'B', primary: false },
    ])
    const out = enqueueCodeTask({ project: 'tozsde', prompt: 'nezd meg', sessionId: 'cccccccc' })
    expect('error' in out).toBe(true)
    expect((out as any).error).toMatch(/tobb fulre is illik/)
  })

  it('ismeretlen ful eseten a valasz FELSOROLJA, mi van -- cimmel', () => {
    const out = enqueueCodeTask({ project: 'tozsde', prompt: 'nezd meg', sessionId: 'deadbeef' })
    expect('error' in out).toBe(true)
    expect((out as any).error).toContain('EA stop-loss javitas')
    expect((out as any).error).toContain('MT5 atallasi terv')
  })
})

describe('chat fulek: amikor NEM latunk oda', () => {
  beforeEach(() => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: NEW })
    // Szandekosan NINCS jelentes errol a mappa rol.
  })

  it('toredek azonositot nem kuldunk el vakon -- megmondjuk, hogy nem latunk oda', () => {
    const out = enqueueCodeTask({ project: 'tozsde', prompt: 'nezd meg', sessionId: 'deadbeef' })
    expect('error' in out).toBe(true)
    expect((out as any).error).toMatch(/nem latok ra/)
  })

  it('teljes UUID-t viszont atengedunk: a CLI sajat hibaja beszedesebb, mint a mi tippunk', () => {
    const out = enqueueCodeTask({ project: 'tozsde', prompt: 'nezd meg', sessionId: OLD })
    expect('task' in out).toBe(true)
    expect((out as any).task.targetSessionId).toBe(OLD)
  })
})

describe('chat fulek: a felderites listaja MAPPAKROL szol', () => {
  it('ket ful ugyanabban a mappaban NEM ket sor a jeloltlistaban', async () => {
    // Regresszio-or: a worker 2026-08-23 ota minden fulet jelent. Szures nelkul
    // ugyanaz a mappa ketszer allna a "Felderitett mappak" alatt, ket kulon
    // "Felvetel" gombbal -- ami ket projektet hozna letre egy mappara.
    reportTwoTabs()
    const res = await call('GET', '/api/code/candidates')
    expect(res.body.candidates).toHaveLength(1)
    expect(res.body.candidates[0].sessionId).toBe(NEW)
    expect(res.body.candidates[0].tabCount).toBe(2)
  })

  it('REGI worker (nincs `primary` a jelenteseben) eseten minden a regi', async () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 2)
    recordCodeCandidates('WINPC', [
      { workspacePath: 'C:\\ws\\egy', sessionId: OLD, mtime: 1000 },
      { workspacePath: 'C:\\ws\\ketto', sessionId: NEW, mtime: 2000 },
    ])
    const res = await call('GET', '/api/code/candidates')
    // Mindketto felveheto marad: a frissites elott allo gepen egyetlen projekt
    // sem tunhet el a listabol.
    expect(res.body.candidates).toHaveLength(2)
  })
})

describe('chat fulek: a vegpont', () => {
  it('a /api/code/tabs ugyanazt adja, amit a Telegram /tabs lat', async () => {
    reportTwoTabs()
    const res = await call('GET', '/api/code/tabs')
    expect(res.body.projects).toHaveLength(1)
    expect(res.body.projects[0].tabs).toHaveLength(2)
    expect(res.body.projects[0].tabs[0].shortId).toBe(NEW.slice(0, 8))
    expect(res.body.reason).toBe('ok')
    expect(res.body.window.maxTabsPerProject).toBeGreaterThan(0)
  })

  it('a feladat-vegpont atveszi a valasztott fulet', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: NEW })
    reportTwoTabs()
    const res = await call('POST', '/api/code/tasks', {
      project: 'tozsde', prompt: 'nezd meg', sessionId: OLD.slice(0, 8),
    })
    expect(res.status).toBe(201)
    expect(res.body.targetSessionId).toBe(OLD)
  })
})

// A kartya nem csak dekoracio: amit ott bejelolsz, azt Marvinnak is latnia
// kell, kulonben nem tudja, mit szabad ennek a vegrehajtonak kiosztani.
describe('a VS Code kartya: szerepek es nev', () => {
  // Friss telepitesen a store/ mappa meg nem letezik -- a szerep-iras enelkul
  // ENOENT-tel halna el. Ez a teszt pont az uj gepet utanozza.
  // Es a szerep-kiosztas MINDEN eset elott nullazodik: enelkul az elozo teszt
  // (vagy egy korabbi futas ottfelejtett fajlja) dontene el, mit lat a
  // kovetkezo -- pont a "nincs kiosztva" agat tenne teszteletlenne.
  beforeEach(() => {
    mkdirSync(STORE_DIR, { recursive: true })
    writeBrokerConfig(null, { roles: { planner: null, implementer: null, checker: null } })
  })

  it('a projekt-lista minden sorhoz megmondja a szerep-gazdat', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: NEW })
    const res = await call('GET', '/api/code/projects')
    expect(res.body.projects[0].roleHolder).toBe('vscode:tozsde')
    // Semmi nincs kiosztva -> ures tomb ES `rolesAssigned: false`. A ketto
    // egyutt mondja meg, hogy ez NEM korlatozas, csak meg senki nem valasztott.
    expect(res.body.projects[0].roles).toEqual([])
    expect(res.body.rolesAssigned).toBe(false)
  })

  it('a kiosztott szerep megjelenik a projekt soraban', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: NEW })
    writeBrokerConfig(null, { roles: { planner: null, implementer: 'vscode:tozsde', checker: null } })
    const res = await call('GET', '/api/code/projects')
    expect(res.body.projects[0].roles).toEqual(['implementer'])
    expect(res.body.rolesAssigned).toBe(true)
  })

  it('egy azonos nevu UGYNOK nem veszi el a projekt szerepet', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: NEW })
    // A gazda-nev ketospontos elotaggal megy; egy tozsde nevu agens mas.
    writeBrokerConfig(null, { roles: { planner: null, implementer: 'tozsde', checker: null } })
    const res = await call('GET', '/api/code/projects')
    expect(res.body.projects[0].roles).toEqual([])
    expect(res.body.rolesAssigned).toBe(true)
  })

  // A NULLA ket dolgot jelenthet, a kartya nevenel is: nincs bot beallitva
  // (friss telepites, teljesen normalis) VAGY van, de nem tudtuk lekerdezni.
  // A masodikat sose talalgatjuk -- a Telegram sajat hibauzenete megy tovabb.
  it('kod-bot token nelkul a nev NEM ismeretlen hiba, hanem "nincs beallitva"', async () => {
    const res = await call('GET', '/api/code/health')
    expect(res.body.codeBot.reason).toBe('not-configured')
    expect(res.body.codeBot.name).toBeNull()
    expect(res.body.codeBot.error).toBeNull()
  })

  // Boss, 2026-08-23: "A nevbol lehagyhattad volna mar a bot veget. a tobbinel
  // sincsen..." + "es a kukac sem kell az elejere".
  it('a kartya-nev nem viseli sem a kukacot, sem a bot-veget', () => {
    expect(displayBotName('@marveen_vscode_bot')).toBe('marveen vscode')
    expect(displayBotName('marveen_vscode_bot')).toBe('marveen vscode')
    expect(displayBotName('@MarveenBot')).toBe('Marveen')
    // Ha a levagas utan semmi nem maradna, inkabb a teljes nev alljon ott:
    // ures cim rosszabb a csunya nevnel.
    expect(displayBotName('@bot')).toBe('bot')
    expect(displayBotName('@_bot')).toBe('_bot')
  })
})

// ---------------------------------------------------------------------------
// NYITOTT FULEK. Boss, 2026-08-23: "a vscode kartyan latok vagy 5 chat fulet.
// a vscode ban meg 2 van. (...) amit a vscode ban kitorolnek azt a maveen
// kartyaja se mutassa!"
//
// A bezart ful transcriptje a lemezen MARAD (merve: 20 fajl, 2 nyitott ful),
// ezert a worker kulon meri, mi van nyitva (elo PID a ~/.claude/sessions
// alapjan), es azt kuldi `live` mezoben. A NULLA itt is ket dolgot jelenthet:
// "nincs nyitva" (`false`) es "nem latunk oda" (`null`) -- a ketto NEM
// ugyanazt a listat eredmenyezi.
describe('chat fulek: csak ami tenyleg nyitva van', () => {
  it('a bezart fulet nem mutatja, a nyitottat igen', () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 2)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: NEW, mtime: 2000, title: 'nyitott', primary: true, live: true },
      { workspacePath: WS, sessionId: OLD, mtime: 1000, title: 'bezart', primary: false, live: false },
    ])
    const view = listCodeTabs()
    expect(view.projects[0]!.tabs.map((t) => t.sessionId)).toEqual([NEW])
  })

  it('regi worker (nincs `live` mezo) mellett valtozatlanul minden ful latszik', () => {
    reportTwoTabs()
    const view = listCodeTabs()
    expect(view.projects[0]!.tabs).toHaveLength(2)
    expect(view.projects[0]!.tabs.every((t) => t.live === null)).toBe(true)
  })

  it('a cimzett (current) ful akkor is bent marad, ha eppen nincs nyitva', async () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 2)
    recordCodeCandidates('WINPC', [
      { workspacePath: WS, sessionId: OLD, mtime: 1000, title: 'bekotott, de bezart', primary: true, live: false },
      { workspacePath: WS, sessionId: NEW, mtime: 2000, title: 'masik, bezart', primary: false, live: false },
    ])
    await call('POST', '/api/code/projects', { project: 'tozsde', workspacePath: WS, sessionId: OLD })
    const view = listCodeTabs()
    // Ha ez eltunne, a lap ugy nezne ki, mintha a projekt cimezhetetlen lenne.
    expect(view.projects[0]!.tabs.map((t) => t.sessionId)).toEqual([OLD])
  })
})

// ---------------------------------------------------------------------------
// TORLES. Boss, 2026-08-23: "es a torles gombot is tedd fel."
//
// A puszta DELETE hazug gomb lenne: a felderites egy percen belul ujra
// bekotne ugyanazt a mappat.
describe('kartya levetele', () => {
  it('a torles utan a felderites NEM koti be ujra', async () => {
    recordCodeWorkerSeen('WINPC', 'discovery', 1)
    await call('POST', '/api/code/projects', { project: 'tozsde', workspacePath: WS, sessionId: NEW })
    const del = await call('DELETE', '/api/code/projects/tozsde')
    expect(del.body.deleted).toBe(true)
    expect(del.body.forgotten).toBe(true)

    const report = await call('POST', '/api/code/sessions', {
      host: 'WINPC',
      sessions: [{ workspacePath: WS, sessionId: NEW, mtime: 3000, primary: true, live: true }],
    })
    expect(report.body.registered).toEqual([])
    expect(listCodeSessions()).toHaveLength(0)
  })

  it('kezi bekotessel visszahozhato -- a levetel nem vegleges', async () => {
    await call('POST', '/api/code/projects', { project: 'tozsde', workspacePath: WS, sessionId: NEW })
    await call('DELETE', '/api/code/projects/tozsde')
    const again = await call('POST', '/api/code/projects', { project: 'tozsde', workspacePath: WS, sessionId: NEW })
    expect(again.status).toBe(200)
    expect(listCodeSessions().map((s) => s.project)).toEqual(['tozsde'])

    const report = await call('POST', '/api/code/sessions', {
      host: 'WINPC',
      sessions: [{ workspacePath: WS, sessionId: NEW, mtime: 4000, primary: true, live: true }],
    })
    expect(report.body.registered).toEqual(['tozsde'])
  })
})
