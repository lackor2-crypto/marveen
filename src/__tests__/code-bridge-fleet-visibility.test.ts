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

  it('a "dolgozik" a FUTO feladatbol jon, nem a bekapcsolt allapotbol', () => {
    expect(route).toMatch(/act\.running\.length > 0\s*\n?\s*\? 'working'/)
    expect(route).toContain("(act.workerOnline && CODE_BRIDGE_ENABLED ? 'idle' : 'stopped')")
  })

  it('nevutkozes eseten a valodi ugynok az erosebb', () => {
    // Ket azonos kulcs a felulet Map-jeben nemaan elnyelne az egyiket.
    expect(route).toContain('const taken = entries.some((e) => e.name === CODE_BRIDGE_ACTIVITY_ID)')
  })

  it('az azonosito nem lehet veletlenul ugynok-nev is', () => {
    expect(CODE_BRIDGE_ACTIVITY_ID).toBe('code-bridge')
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
