// Kanban #235 -- "az elo nezet nem zold": a kod-hid SAJAT munkaja is munka.
//
// Boss, 2026-09-07: "csak eppen a vscode nal az elo nezet nem zold. tehat az
// meg nem mukodik."
//
// MERT ALLAPOT ugyanekkor (elo dashboard, csak olvaso hivasok):
//   GET /api/code/tabs      -> HAROM ful `live: true` (pid 5164, 3924, 9764)
//   GET /api/code/health    -> running: 0, queued: 0
//   GET /api/agents/activity-> code-bridge: state "idle", codeSessionId null
//
// Az ok szerkezeti volt, nem szamolasi: a `codeBridgeActivity()` a "dolgozik"-ot
// KIZAROLAG a `code_tasks WHERE status='running'` sorokbol szamolta, azaz csak
// abbol, amit a Marveen KULDOTT KI a hidnak. A tulajdonos sajat VS Code-munkaja
// sosem hoz letre ilyen sort -- a hid tehat dolgozott, a kartya meg idle-t
// mutatott, es az "Elo nezet" (`canOpen = !!codeSessionId`) meg akkor sem
// jelent meg, amikor vegre 'working' volt, mert a kiosztott feladat gyakran
// nem hordoz session-azonositot.
//
// A javitas EGY helyen mer (a vegpont forrasa), es az "elo" definicioja ugyanaz,
// mint a kod-hid kartyajan: `live === true`. Igy nem szuletik ket kulonbozo
// "dolgozik" fogalom -- ez az agens-paritas szabalya a meresre alkalmazva.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeWorkerSeen,
  recordCodeCandidates, _resetCodeCandidates, codeBridgeActivity,
} from '../web/code-bridge-store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'agents.ts'), 'utf8')

const WS_PATH = 'C:\\ws\\marvin'
const SID_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const SID_B = 'bbbbbbbb-0000-4000-8000-000000000002'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
})

describe('codeBridgeActivity: az eloben futo beszelgetes is munka', () => {
  it('a `live: true` fulet MUNKAKENT adja vissza, kiosztott feladat nelkul is', () => {
    upsertCodeSession({ project: 'marvin', workspacePath: WS_PATH, sessionId: SID_A })
    recordCodeWorkerSeen('windows', 'discovery', 1)
    recordCodeCandidates('windows', [
      { workspacePath: WS_PATH, sessionId: SID_A, title: 'Marveen vscode nak 3', live: true, primary: true, lastActivity: 5000 },
    ])

    const act = codeBridgeActivity()
    // Ez az a ket sor, ami a hibas allapotban ellentmondott egymasnak.
    expect(act.running).toEqual([])
    expect(act.liveSessions).toHaveLength(1)
    expect(act.liveSessions[0]?.sessionId).toBe(SID_A)
    // A BEKOTOTT mappa regisztralt neve nyer, nem a mappanevbol kepzett alias.
    expect(act.liveSessions[0]?.project).toBe('marvin')
    expect(act.liveSessions[0]?.title).toBe('Marveen vscode nak 3')
    expect(act.liveSessions[0]?.current).toBe(true)
  })

  it('csak a KIFEJEZETT igen szamit elonek: a false es a null nem', () => {
    // A `null` egy regi worker, ami meg nem kuldi ezt a mezot -- az "nem latunk
    // oda", nem "nem fut". Munkanak allitani epp olyan hazugsag volna, mint a
    // forditottja.
    upsertCodeSession({ project: 'marvin', workspacePath: WS_PATH, sessionId: SID_A })
    recordCodeWorkerSeen('windows', 'discovery', 2)
    recordCodeCandidates('windows', [
      { workspacePath: WS_PATH, sessionId: SID_A, live: false, primary: true },
      { workspacePath: WS_PATH, sessionId: SID_B, primary: false },
    ])
    expect(codeBridgeActivity().liveSessions).toEqual([])
  })

  it('a nem bekotott mappa a mappanevbol kap nevet, nem talalunk ki projektet', () => {
    recordCodeWorkerSeen('windows', 'discovery', 1)
    recordCodeCandidates('windows', [
      { workspacePath: 'd:\\Tozsde_telepitesi_mappa', sessionId: SID_B, live: true, primary: true },
    ])
    const act = codeBridgeActivity()
    expect(act.liveSessions[0]?.project).toBe('tozsde_telepitesi_mappa')
    // Nincs regisztralt session, ezert a `primary` mondja meg, melyik az aktualis.
    expect(act.liveSessions[0]?.current).toBe(true)
  })

  it('a legfrissebb elo beszelgetes all elol', () => {
    upsertCodeSession({ project: 'marvin', workspacePath: WS_PATH, sessionId: SID_A })
    recordCodeWorkerSeen('windows', 'discovery', 2)
    recordCodeCandidates('windows', [
      { workspacePath: WS_PATH, sessionId: SID_A, live: true, primary: true, lastActivity: 1000 },
      { workspacePath: WS_PATH, sessionId: SID_B, live: true, primary: false, lastActivity: 9000 },
    ])
    const act = codeBridgeActivity()
    expect(act.liveSessions.map((s) => s.sessionId)).toEqual([SID_B, SID_A])
    // A sorrend a frissesseg, de az AKTUALIS ful kulon meg van jelolve: a
    // vegpont ezt valasztja megnyitasra, hogy ugyanoda vigyen, ahova egy
    // feladat menne.
    expect(act.liveSessions.find((s) => s.current)?.sessionId).toBe(SID_A)
  })
})

describe('codeBridgeActivity: a nulla ket jelentese az elosegnel', () => {
  it('jelentes elott a nulla NEM azt jelenti, hogy nincs elo beszelgetes', () => {
    // A jeloltlista memoriaban el: a Marveen ujrainditasa utan a worker online,
    // a lista megis ures. E nelkul a mezo nelkul ezt nem lehet megkulonboztetni
    // attol, hogy tenyleg nincs nyitott beszelgetes.
    upsertCodeSession({ project: 'marvin', workspacePath: WS_PATH, sessionId: SID_A })
    recordCodeWorkerSeen('windows', 'heartbeat', 0)
    const act = codeBridgeActivity()
    expect(act.liveSessions).toEqual([])
    expect(act.liveMeasured).toBe(false)
  })

  it('jelentes utan az ures lista MAR meres: tenyleg nincs elo beszelgetes', () => {
    upsertCodeSession({ project: 'marvin', workspacePath: WS_PATH, sessionId: SID_A })
    recordCodeWorkerSeen('windows', 'discovery', 1)
    recordCodeCandidates('windows', [{ workspacePath: WS_PATH, sessionId: SID_A, live: false, primary: true }])
    const act = codeBridgeActivity()
    expect(act.liveSessions).toEqual([])
    expect(act.liveMeasured).toBe(true)
  })

  it('friss telepitesen nem talalunk ki csapattagot ettol a mezotol sem', () => {
    const act = codeBridgeActivity()
    expect(act.present).toBe(false)
    expect(act.liveSessions).toEqual([])
    expect(act.liveMeasured).toBe(false)
  })
})

describe('/api/agents/activity: ebbol lesz zold az "Elo nezet"', () => {
  it('a "dolgozik" a kiosztott feladatbol VAGY a FRISSEN aktiv MARVIN-SAJAT beszelgetesbol jon', () => {
    // Kartya f9aff668 (2026-09-10): egy elo, de regen inaktiv beszelgetes ONMAGABAN
    // mar nem eleg -- lasd `CodeBridgeActivity.liveRecentlyActive`.
    // Kartya f0745809 (2026-09-10, Boss masodik hanguzenete): TOVABB SZUKULT --
    // csak a Marvin altal NYITOTT (`marvinOwned`) friss beszelgetes szamit,
    // Boss SAJAT, nem Marvin-nyitotta fulje (pl. MetaTrader-elemzes) mar nem.
    // Lasd `CodeBridgeActivity.liveMarvinOwnedActive`. Az altalanos `liveSessions`
    // lista (lentebb, az "Elo nezet" linkhez) ettol fuggetlenul valtozatlan.
    expect(route).toMatch(
      /act\.running\.length > 0 \|\| act\.liveMarvinOwnedActive\s*\n?\s*\? 'working'/
    )
  })

  it('a megnyithato beszelgetes visszaesik az ELO fulre, ha a feladat nem hordoz azonositot', () => {
    // Ez az a sor, ami nelkul a kartyan nem jelent meg az "Elo nezet" ikon:
    // `canOpen = isCodeBridge ? !!a.codeSessionId : !!a.running` (web/app.js).
    expect(route).toContain('codeSessionId: first?.sessionId ?? liveFirst?.sessionId ?? null')
    expect(route).toContain('codeLabel: first?.project ?? liveFirst?.project ?? null')
    expect(route).toContain("const liveFirst = act.liveSessions.find((s) => s.current) ?? act.liveSessions[0] ?? null")
  })

  it('a farok-sorok az elo beszelgeteseket is felsoroljak, felso hatarral', () => {
    expect(route).toContain('...act.liveSessions.map((s) => (s.title ? `${s.project} · ${s.title}` : s.project))')
    expect(route).toContain('].slice(0, 8)')
  })
})
