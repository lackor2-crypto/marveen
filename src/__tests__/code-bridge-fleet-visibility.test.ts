// Kanban #213 -- a kod-hid (VS Code kulso programozo) LATHATOSAGA a flottaban.
//
// Boss merese: a bal menu "dolgozik" jelvenye 1-et mutatott, mikozben Marvin ES
// a kulso programozo is dolgozott. Az ok szerkezeti volt, nem szamolasi: a
// /api/agents/activity KET forrasbol epitette a listat (a fo agens tmux panelje
// + listAgentNames()), es a kod-hid egyikben sincs benne -- nincs tmux-panelje
// es nincs sajat processze ezen a gepen. Egy csapattag, akit a meres nem lat,
// nem attol lesz lathato, hogy a szamlalot javitgatjuk.
//
// Ezert a meres bovult EGY helyen (a vegpont), es minden fogyasztoja -- a
// Tevekenyseg lap, a bal menu szamlaloja, a "mindent ujraindit" megerosites --
// ugyanazt a flottat latja. Ez az agens-paritas szabalya alkalmazva.
//
// A masik ket panasz ugyaninnen kap valaszt: a Tevekenyseg-kartya megmutatja,
// MIN dolgozik epp (projekt + a feladat elso sora), es megnyitja a BESZELGETEST
// (chat ful) -- nem egy terminalt, ami sosem letezett.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask,
  recordCodeWorkerSeen, codeBridgeActivity, CODE_BRIDGE_ACTIVITY_ID, WORKER_STALE_MS,
  completeCodeTask, recordCodeCandidates, _resetCodeCandidates, isCodeUsageLimitMessage,
  LIVE_SESSION_STALE_MS,
} from '../web/code-bridge-store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'agents.ts'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

const WS = { project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

describe('codeBridgeActivity: a nulla ket jelentese', () => {
  it('friss telepitesen NEM talal ki csapattagot', () => {
    // Se worker, se beszelgetes: itt a nulla azt jelenti, hogy nincs is hid.
    // Egy "0 feladat" allapotu VS Code kartya ilyenkor hazugsag volna.
    const act = codeBridgeActivity()
    expect(act.present).toBe(false)
    expect(act.workerOnline).toBe(false)
    expect(act.running).toEqual([])
  })

  it('bekotott, de tetlen hid: LETEZIK, csak nem dolgozik', () => {
    upsertCodeSession(WS)
    const act = codeBridgeActivity()
    expect(act.present).toBe(true)
    expect(act.running).toEqual([])
  })
})

describe('codeBridgeActivity: mit csinal epp', () => {
  it('a futo feladatot a projektjevel es a beszelgetesevel egyutt adja vissza', () => {
    upsertCodeSession(WS)
    recordCodeWorkerSeen('windows', 'discovery', 1)
    const enq = enqueueCodeTask({ project: 'marvin', prompt: 'Javitsd a popovert\nmasodik sor', origin: 'api' })
    expect('task' in enq).toBe(true)
    const claimed = claimNextCodeTask('windows')
    expect(claimed).not.toBeNull()

    const act = codeBridgeActivity()
    expect(act.workerOnline).toBe(true)
    expect(act.running).toHaveLength(1)
    expect(act.running[0]?.project).toBe('marvin')
    expect(act.running[0]?.prompt).toContain('Javitsd a popovert')
    // Enelkul a Tevekenyseg-kartya nem tudna megnyitni a beszelgetest.
    expect(act.running[0]?.sessionId).toBe(WS.sessionId)
  })

  it('a sorban allo feladat NEM szamit dolgozasnak', () => {
    upsertCodeSession(WS)
    recordCodeWorkerSeen('windows', 'discovery', 1)
    enqueueCodeTask({ project: 'marvin', prompt: 'meg nem indult el', origin: 'api' })
    const act = codeBridgeActivity()
    expect(act.queued).toBe(1)
    expect(act.running).toEqual([])
  })

  it('elnemult worker: a hid letezik, de nem online', () => {
    upsertCodeSession(WS)
    const long_ago = Date.now() - WORKER_STALE_MS - 1000
    recordCodeWorkerSeen('windows', 'discovery', 1, long_ago)
    const act = codeBridgeActivity()
    expect(act.present).toBe(true)
    expect(act.workerOnline).toBe(false)
  })
})

describe('/api/agents/activity: a kod-hid is flotta-tag', () => {
  it('a vegpont kikuldi a kod-hid bejegyzeset', () => {
    expect(route).toContain('codeBridgeActivity()')
    expect(route).toContain('name: CODE_BRIDGE_ACTIVITY_ID')
    expect(route).toContain("kind: 'code-bridge'")
  })

  it('csak akkor, ha a hid VALOBAN letezik', () => {
    expect(route).toMatch(/if \(act\.present && !taken\)/)
  })

  it('a "dolgozik" a VALODI MUNKABOL jon, nem a bekapcsolt allapotbol', () => {
    // Kanban #235: a feltetel BOVULT (a kiosztott feladat MELLE az eloben futo
    // beszelgetes is munka), de a lenyege valtozatlan -- a puszta "be van
    // kapcsolva es online" tovabbra sem "dolgozik".
    // Kartya f9aff668 (2026-09-10, Boss): a `liveSessions.length > 0` onmagaban
    // TOVABB BOVULT `&& act.liveRecentlyActive`-tel -- egy elo, de regen inaktiv
    // beszelgetes se "dolgozik" tobbe.
    // Kartya f0745809 (2026-09-10, Boss masodik hanguzenete): a feltetel MOST
    // SZUKULT -- a `liveSessions.length > 0 && act.liveRecentlyActive` (BARMELY
    // elo, friss ful) helyett `act.liveMarvinOwnedActive` (CSAK a Marvin altal
    // NYITOTT, friss beszelgetes). Boss SAJAT kezzel hasznalt masik fulje (pl.
    // MetaTrader-elemzes) mar nem szamit "dolgozik"-nak. Lasd
    // `CodeBridgeActivity.liveMarvinOwnedActive`.
    expect(route).toMatch(
      /act\.running\.length > 0 \|\| act\.liveMarvinOwnedActive\s*\n?\s*\? 'working'/
    )
    expect(route).toContain("(act.workerOnline && CODE_BRIDGE_ENABLED ? 'idle' : 'stopped')")
  })

  it('a keret-kimerult hid LIMITED-et mutat, nem "dolgozik" (a kvota elol)', () => {
    // Boss, 2026-09-08: a VS Code hid zold "dolgozik"-ot villogtatott, mikozben
    // a fiokja heti limitbe futott tegnap este. A `live === true` csak azt
    // jelenti, hogy a folyamat cimezheto, nem azt, hogy general -- ezert a
    // tartos kvota-jel elol all, ugyanugy, mint a tmux-agenseknel.
    expect(route).toMatch(/act\.quotaBlocked\s*\n?\s*\? 'limited'/)
  })

  it('nevutkozes eseten a valodi ugynok az erosebb', () => {
    // Ket azonos kulcs a felulet Map-jeben nemaan elnyelne az egyiket.
    expect(route).toContain('const taken = entries.some((e) => e.name === CODE_BRIDGE_ACTIVITY_ID)')
  })

  it('az azonosito nem lehet veletlenul ugynok-nev is', () => {
    expect(CODE_BRIDGE_ACTIVITY_ID).toBe('code-bridge')
  })
})

describe('codeBridgeActivity: kvota-blokk (keret-kimerules)', () => {
  beforeEach(() => { _resetCodeCandidates() })

  // A legutobbi feladatot keret-kimerules hibaval zarja le.
  const failLatestWithLimit = (msg: string): void => {
    recordCodeWorkerSeen('windows', 'discovery', 1)
    const enq = enqueueCodeTask({ project: 'marvin', prompt: 'valami', origin: 'api' })
    const id = 'task' in enq ? enq.task.id : ''
    claimNextCodeTask('windows')
    completeCodeTask(id, { ok: false, error: msg })
  }

  it('a szoveg-felismero a keret-kimerules uzeneteket fogja meg', () => {
    expect(isCodeUsageLimitMessage("You've hit your weekly limit · resets Sep 11, 9am")).toBe(true)
    expect(isCodeUsageLimitMessage('usage limit reached')).toBe(true)
    expect(isCodeUsageLimitMessage('Some other crash')).toBe(false)
    expect(isCodeUsageLimitMessage(null)).toBe(false)
  })

  it('a legutobbi feladat keret-kimerules hibaja -> quotaBlocked', () => {
    upsertCodeSession(WS)
    failLatestWithLimit("You've hit your weekly limit · resets Sep 11, 9am (Europe/Budapest)")
    expect(codeBridgeActivity().quotaBlocked).toBe(true)
  })

  it('egy elo ful (live:true) sem old fel, ha nincs frissebb VALODI tevekenyseg', () => {
    upsertCodeSession(WS)
    const blockedAt = Date.now()
    failLatestWithLimit("You've hit your weekly limit")
    // A ful FOLYAMATA el (live:true), de az utolso tevekenysege a limit ELOTTI:
    // pont ez a hibas eset, amit Boss latott.
    recordCodeCandidates('windows', [
      { workspacePath: WS.workspacePath, sessionId: WS.sessionId, live: true, lastActivity: blockedAt - 60_000 },
    ])
    const act = codeBridgeActivity()
    expect(act.liveSessions.length).toBeGreaterThan(0)
    expect(act.quotaBlocked).toBe(true)
  })

  it('frissebb VALODI tevekenyseg feloldja (a fiok mar dolgozik megint)', () => {
    upsertCodeSession(WS)
    failLatestWithLimit("You've hit your weekly limit")
    recordCodeCandidates('windows', [
      { workspacePath: WS.workspacePath, sessionId: WS.sessionId, live: true, lastActivity: Date.now() + 5_000 },
    ])
    expect(codeBridgeActivity().quotaBlocked).toBe(false)
  })

  it('mas hiba (nem keret-kimerules) NEM blokkol', () => {
    upsertCodeSession(WS)
    failLatestWithLimit('Some other crash')
    expect(codeBridgeActivity().quotaBlocked).toBe(false)
  })

  it('friss telepitesen (nincs lezart feladat) nem blokkolt', () => {
    expect(codeBridgeActivity().quotaBlocked).toBe(false)
  })
})

describe('codeBridgeActivity: liveRecentlyActive (kartya 90a050af utoda -- befejezett/inaktiv beszelgetes)', () => {
  beforeEach(() => { _resetCodeCandidates() })

  // Boss, 2026-09-10: a VS Code hid zold "dolgozik"-ot mutatott, mikozben a
  // konkret beszelgetes mar kb 10 perce megallt. A `live === true` csak azt
  // jelenti, hogy a folyamat cimezheto, nem azt, hogy general -- ugyanaz a
  // hibaosztaly, mint a kvota-blokknal (90a050af), csak itt nincs kvota-hiba,
  // a beszelgetes egyszeruen befejezodott/inaktiv.

  it('regi (elavult) MERT aktivitasu elo ful NEM szamit liveRecentlyActive-nak', () => {
    upsertCodeSession(WS)
    recordCodeCandidates('windows', [
      {
        workspacePath: WS.workspacePath,
        sessionId: WS.sessionId,
        live: true,
        lastActivity: Date.now() - LIVE_SESSION_STALE_MS - 60_000,
      },
    ])
    const act = codeBridgeActivity()
    expect(act.liveSessions.length).toBeGreaterThan(0)
    expect(act.liveRecentlyActive).toBe(false)
  })

  it('friss MERT aktivitasu elo ful liveRecentlyActive marad', () => {
    upsertCodeSession(WS)
    recordCodeCandidates('windows', [
      {
        workspacePath: WS.workspacePath,
        sessionId: WS.sessionId,
        live: true,
        lastActivity: Date.now() - 30_000,
      },
    ])
    expect(codeBridgeActivity().liveRecentlyActive).toBe(true)
  })

  it('meres hianyaban (lastActivity ES mtime is null) NEM szigoritunk -- true marad', () => {
    upsertCodeSession(WS)
    recordCodeCandidates('windows', [
      { workspacePath: WS.workspacePath, sessionId: WS.sessionId, live: true, lastActivity: null },
    ])
    expect(codeBridgeActivity().liveRecentlyActive).toBe(true)
  })

  it('friss telepitesen (nincs elo ful) liveRecentlyActive false, de ez nem szamit -- nincs is liveSessions', () => {
    const act = codeBridgeActivity()
    expect(act.liveSessions).toEqual([])
    expect(act.liveRecentlyActive).toBe(false)
  })
})

describe('codeBridgeActivity: liveMarvinOwnedActive (kartya f0745809 -- Boss sajat fulje ne legyen "dolgozik")', () => {
  beforeEach(() => { _resetCodeCandidates() })

  // Boss, 2026-09-10 (masodik hanguzenet): a kartya 032aa826 ota a Marvin
  // dispatch MINDIG friss, sajat beszelgetest nyit (`marvinOwned`), ezert a
  // "dolgozik" jelzesnek is erre kell szukulnie -- Boss SAJAT kezzel hasznalt,
  // nem Marvin-nyitotta fulje (pl. MetaTrader-elemzes) ne mutasson "dolgozik"-ot.

  it('marvinOwned session friss elo aktivitasa liveMarvinOwnedActive=true', () => {
    upsertCodeSession({ ...WS, marvinOwned: true })
    recordCodeCandidates('windows', [
      { workspacePath: WS.workspacePath, sessionId: WS.sessionId, live: true, lastActivity: Date.now() - 30_000 },
    ])
    const act = codeBridgeActivity()
    expect(act.liveRecentlyActive).toBe(true)
    expect(act.liveMarvinOwnedActive).toBe(true)
  })

  it('NEM marvinOwned (Boss sajat fulje) friss elo aktivitasa NEM szamit liveMarvinOwnedActive-nak', () => {
    upsertCodeSession({ ...WS, marvinOwned: false })
    recordCodeCandidates('windows', [
      { workspacePath: WS.workspacePath, sessionId: WS.sessionId, live: true, lastActivity: Date.now() - 30_000 },
    ])
    const act = codeBridgeActivity()
    // Az altalanos meres tovabbra is "friss elo"-nek latja -- csak a szukebb,
    // marvinOwned-ra szurt mezo lesz false. A liveSessions lista is megmarad
    // (az "Elo nezet" link mukodjon Boss sajat fuljere is).
    expect(act.liveRecentlyActive).toBe(true)
    expect(act.liveSessions.length).toBeGreaterThan(0)
    expect(act.liveMarvinOwnedActive).toBe(false)
  })

  it('nem regisztralt (bekotetlen) elo jelolt sose szamit liveMarvinOwnedActive-nak', () => {
    recordCodeCandidates('windows', [
      { workspacePath: WS.workspacePath, sessionId: WS.sessionId, live: true, lastActivity: Date.now() - 30_000 },
    ])
    expect(codeBridgeActivity().liveMarvinOwnedActive).toBe(false)
  })

  it('elavult MERT aktivitasu marvinOwned ful sem szamit liveMarvinOwnedActive-nak', () => {
    upsertCodeSession({ ...WS, marvinOwned: true })
    recordCodeCandidates('windows', [
      {
        workspacePath: WS.workspacePath,
        sessionId: WS.sessionId,
        live: true,
        lastActivity: Date.now() - LIVE_SESSION_STALE_MS - 60_000,
      },
    ])
    expect(codeBridgeActivity().liveMarvinOwnedActive).toBe(false)
  })
})

describe('felulet: egy meres, egy szam', () => {
  it('a bal menu szamlaloja NEM kap kulon kod-hid agat', () => {
    // A szamlalo valtozatlanul az entries-bol szamol -- a kod-hid azert kerul
    // bele, mert a KISZOLGALO teszi bele. Ha itt kulon ag lenne, ket "dolgozik"
    // fogalom szuletne, es elobb-utobb elternenek egymastol.
    expect(app).toContain("const workingCount = entries.filter((e) => e.state === 'working').length")
  })

  it('a kod-hid kartyaja a 3 masodperces meresbol kapja a "dolgozik" jelzot', () => {
    expect(app).toContain("const cbEntry = entries.find((e) => e.kind === 'code-bridge') || null")
    expect(app).toContain("const cbWorking = !!cbEntry && cbEntry.state === 'working'")
    expect(app).toContain("agentsGrid.querySelectorAll('.code-bridge-agent-card [data-cb-busy]')")
  })

  it('a jelzo a haz meglevo osztalyat hasznalja, nem talal ki ujat', () => {
    // Ugyanaz a lelegzo zold, mint a Tevekenyseg lapon es a Terminal gombon.
    const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')
    expect(css).toContain('.activity-badge.act-working')
    expect(app).toContain('<button type="button" class="activity-badge act-working" data-cb-busy')
    expect(css).toContain('button.activity-badge[data-code-session] { cursor: pointer; }')
  })

  it('a "dolgozik" jelzo megnyitja azt a beszelgetest, amiben a munka fut', () => {
    // A 2. panasz lenyege: ha nem Boss inditotta a munkat, semmi nem latszott.
    // A jelzo a 3 masodperces meresbol kapja a session azonositojat, tehat
    // fuggetlen attol, KI adta ki a feladatot.
    expect(app).toContain('el.dataset.codeSession = cbEntry.codeSessionId')
    expect(app).toContain("if (cbBusyBtn.dataset.codeSession) openCodeConversationModal(cbBusyBtn.dataset.codeSession")
  })

  it('a Tevekenyseg-kartya a BESZELGETEST nyitja, nem egy nem letezo terminalt', () => {
    expect(app).toContain("const isCodeBridge = a.kind === 'code-bridge'")
    expect(app).toContain('const canOpen = isCodeBridge ? !!a.codeSessionId : !!a.running')
    expect(app).toContain('if (card.dataset.codeSession) openCodeConversationModal(card.dataset.codeSession')
    // A regi, feltetel nelkuli alak ne jojjon vissza.
    expect(app).not.toContain('if (card) openTerminalModal(card.dataset.agent)')
  })

  it('az uj szoveg ketnyelvu', () => {
    for (const lang of [hu, en]) expect(lang).toContain("'cb.card.busy_help'")
  })
})
