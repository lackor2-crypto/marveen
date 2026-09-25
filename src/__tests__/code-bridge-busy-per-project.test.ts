// #397 -- A VS CODE KARTYA "DOLGOZIK" JELZESE A SAJAT PROJEKTJET MUTASSA.
//
// Boss, Telegram 6436: a Jovahagyasok oldalrol a Marveen projektnek adott
// javitast, es az Ugynokok oldalon a "Marvin VS Code tozsde Windows" kartya is
// "Dolgozik" volt -- ugy nezett ki, mintha a tozsde kapta volna a munkat.
//
// Mert: a szerver jol routolt (code_tasks project=marveen running / queued). A
// hiba a kijelzes volt: minden kod-hid kartya a HID-SZINTU running/queued
// szambol rajzolta a jelvenyt, tehat barmelyik projekt munkaja minden kartyat
// zoldre festett. Ez a teszt ket projektet kot be, az egyiken fut feladat, es
// azt varja, hogy csak az az egy kartya "dolgozik".
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeWorkerSeen, recordCodeCandidates,
  _resetCodeCandidates, enqueueCodeTask, claimNextCodeTask, completeCodeTask,
  codeBridgeActivity, codeBridgeDisplayState, codeBridgeProjectDisplayStates, codeTaskCountsByProject,
} from '../web/code-bridge-store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const codeRoute = readFileSync(join(ROOT, 'src', 'web', 'routes', 'code.ts'), 'utf8')
const agentsRoute = readFileSync(join(ROOT, 'src', 'web', 'routes', 'agents.ts'), 'utf8')

const MARVEEN = { project: 'marveen', workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }
const TOZSDE = { project: 'tozsde', workspacePath: 'C:\\Users\\boss\\tozsde', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
  upsertCodeSession(MARVEEN)
  upsertCodeSession(TOZSDE)
  recordCodeWorkerSeen('windows', 'discovery', 1)
  recordCodeCandidates('windows', [])
})

describe('#397: a kod-hid kartya a sajat projektje munkajat mutatja', () => {
  it('a marveen projekt feladata csak a marveen kartyat festi zoldre, a tozsdet nem', () => {
    const a = enqueueCodeTask({ project: 'marveen', prompt: 'Javitas', origin: 'api' })
    expect('task' in a).toBe(true)
    expect(claimNextCodeTask('windows')).not.toBeNull()
    const b = enqueueCodeTask({ project: 'marveen', prompt: 'Kovetkezo', origin: 'api' })
    expect('task' in b).toBe(true)

    expect(codeTaskCountsByProject()).toEqual({ marveen: { queued: 1, running: 1 } })

    const act = codeBridgeActivity()
    // A hid egeszeben dolgozik -- ez a Tevekenyseg lap egyetlen VS Code sora.
    expect(codeBridgeDisplayState(act, true).state).toBe('working')

    const per = codeBridgeProjectDisplayStates(act, true)
    expect(per.marveen?.state).toBe('working')
    expect(per.marveen?.queuedOnly).toBe(false)
    // A tozsde projektnek nincs munkaja: nincs a terkepen, tehat a felulet
    // tetlennek veszi -- NEM kolcsonzi a hid-szintu "dolgozik"-ot.
    expect(per.tozsde).toBeUndefined()
  })

  it('csak sorban allo munka: "indulasra var" csak annal a projektnel', () => {
    const a = enqueueCodeTask({ project: 'tozsde', prompt: 'Elemzes', origin: 'api' })
    expect('task' in a).toBe(true)
    const per = codeBridgeProjectDisplayStates(codeBridgeActivity(), true)
    expect(per.tozsde).toMatchObject({ state: 'working', queuedOnly: true })
    expect(per.marveen).toBeUndefined()
  })

  it('a munka vege utan egyik kartya sem dolgozik', () => {
    enqueueCodeTask({ project: 'marveen', prompt: 'Javitas', origin: 'api' })
    const c = claimNextCodeTask('windows')
    completeCodeTask(c!.id, { ok: true, result: 'kesz' })
    expect(codeTaskCountsByProject()).toEqual({})
    expect(codeBridgeProjectDisplayStates(codeBridgeActivity(), true)).toEqual({})
  })

  it('leallitott worker mellett a projekt allapota sem "dolgozik"', () => {
    enqueueCodeTask({ project: 'marveen', prompt: 'Javitas', origin: 'api' })
    const per = codeBridgeProjectDisplayStates(codeBridgeActivity(), false)
    expect(per.marveen?.state).toBe('stopped')
  })
})

describe('#397: a vegpontok es a felulet a projektenkenti szamot hasznaljak', () => {
  it('GET /api/code/projects soronkent kuldi a running/queued szamot', () => {
    expect(codeRoute).toMatch(/const taskCounts = codeTaskCountsByProject\(\)/)
    expect(codeRoute).toMatch(/running: taskCounts\[p\.project\]\?\.running \?\? 0/)
    expect(codeRoute).toMatch(/queued: taskCounts\[p\.project\]\?\.queued \?\? 0/)
  })

  it('az /api/agents/activity kod-hid sora projektenkenti allapotot is visz', () => {
    expect(agentsRoute).toMatch(/projects: codeBridgeProjectDisplayStates\(act, CODE_BRIDGE_ENABLED\)/)
  })

  it('a kartya jelvenye nem a hid-szintu szambol rajzolodik', () => {
    const start = app.indexOf('function renderCodeBridgeAgentCards(')
    const body = app.slice(start, app.indexOf('\nfunction ', start + 10))
    expect(body).not.toMatch(/codeBridgeCards\.running > 0 \|\|/)
    expect(body).toMatch(/card\.dataset\.cbProject = e\.project/)
    // A 3 mp-es frissites a kartya sajat projektjet keresi a terkepen.
    expect(app).toMatch(/cbEntry\.projects\[project\]/)
  })

  it('regi szerver (hianyzo mezo) -> nincs kitalalt "dolgozik"', () => {
    const start = app.indexOf('function cbRowTaskCounts(')
    const fn = app.slice(start, app.indexOf('\n}\n', start) + 3)
    // eslint-disable-next-line no-new-func
    const cbRowTaskCounts = new Function(fn + '; return cbRowTaskCounts')() as (r: unknown) => unknown
    expect(cbRowTaskCounts({ project: 'x' })).toBeNull()
    expect(cbRowTaskCounts({ project: 'x', running: 2, queued: 1 })).toEqual({ running: 2, queued: 1 })
  })
})
