// Kartya 5603b3d4 (#340) -- A ZOLD "DOLGOZIK" JELZES ELALSZIK, MIKOZBEN A MUNKA FOLYIK.
//
// Boss, Telegram, 2026-09-20: "nem lattam volna, hogy az ugynokok alatt a Marvin
// VS Code dolgozott volna. Nem vilagitott ott zolden, hogy dolgozik. [...] amikor
// dolgozik, akkor mindig zoldnek kene, hogy legyen az a dolgozik gomb. meg akkor
// is, hogyha egy par masodperc[re] kicsit leall vagy var valamire [...] vagy egy
// tesztre var [...] Szoval nem kene leallitani azt a zold gombot, csak akkor,
// amikor mar keszen van a munka, vagy eppen lefagyott, vagy eppen megallt a
// keret hianya miatt."
//
// VALODI KAR: Boss ezert adta ki a #337 javitast MASODSZOR is egy masik agensnek,
// mikozben a kod-hid mar meg volt bizva vele -- ket agens ugyanazon a munkan.
//
// MERT IDOVONAL (store/claudeclaw.db, code_tasks, 2026-09-20):
//   15:39:24  a #337 javitasi feladat (cac4fcd2) KIADVA        -> queued
//   15:46:58  az elotte futo ellenorzes (fdccde8b) befejezodott -> nincs running
//   15:48:23  Boss megnezi: a hid SZURKE, ezert kiadja ujra a munkat
//   15:49:24  a javitasi feladat elindul                        -> running
// Ugyanez megismetlodott: 38a75067 KIADVA 15:54:52, INDULT 16:01:56.
//
// Ez a teszt azt a KET perc harminc masodperces ablakot jatssza ujra, ahol a
// munka ki volt adva, de meg nem indult el.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeWorkerSeen, recordCodeCandidates,
  _resetCodeCandidates, enqueueCodeTask, claimNextCodeTask, completeCodeTask,
  codeBridgeActivity, codeBridgeDisplayState,
} from '../web/code-bridge-store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

const WS = { project: 'marveen', workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
})

describe('kod-hid: a kiadott munka a sorban allas alatt is "dolgozik"', () => {
  it('a 2026-09-20-i ablak ujrajatszva: az elozo feladat vege utan is zold, amig a kiadott munka el nem indul', () => {
    upsertCodeSession(WS)
    recordCodeWorkerSeen('windows', 'discovery', 1)
    // Nincs semmilyen elo beszelgetes-meres: a jelzesnek EGYEDUL a kiadott
    // munkabol kell zoldnek lennie (igy szigorubb a teszt).
    recordCodeCandidates('windows', [])

    // 15:30 -- az ellenorzesi feladat fut.
    const elso = enqueueCodeTask({ project: 'marveen', prompt: 'Ellenorzesi feladat', origin: 'api' })
    expect('task' in elso).toBe(true)
    const claimed = claimNextCodeTask('windows')
    expect(claimed).not.toBeNull()
    expect(codeBridgeDisplayState(codeBridgeActivity(), true).state).toBe('working')

    // 15:39 -- Boss kiadja a javitasi feladatot. Meg mindig fut az elso.
    const masodik = enqueueCodeTask({ project: 'marveen', prompt: 'Javitasi feladat (#337)', origin: 'api' })
    expect('task' in masodik).toBe(true)

    // 15:46:58 -- az elso feladat befejezodik. A masodik ki van adva, de a
    // worker meg nem igenyelte. EZ AZ ABLAK, amit Boss szurken latott.
    completeCodeTask(claimed!.id, { ok: true, result: 'kesz' })
    const act = codeBridgeActivity()
    expect(act.running).toEqual([])
    expect(act.queued).toBe(1)
    expect(codeBridgeDisplayState(act, true)).toEqual({ state: 'working', queuedOnly: true })

    // 15:49:24 -- elindul: tovabbra is zold, de mar nem "indulasra var".
    const masodikClaim = claimNextCodeTask('windows')
    expect(masodikClaim).not.toBeNull()
    expect(codeBridgeDisplayState(codeBridgeActivity(), true)).toEqual({ state: 'working', queuedOnly: false })

    // A munka VEGE az egyetlen ok, amitol elalszik (a masik ketto a lefagyas es
    // a keret-hiany, azokat kulon teszt fogja).
    completeCodeTask(masodikClaim!.id, { ok: true, result: 'kesz' })
    expect(codeBridgeDisplayState(codeBridgeActivity(), true).state).toBe('idle')
  })

  it('a farok-sor megmondja, MI az a kiadott munka (nem csak azt, hogy van)', () => {
    upsertCodeSession(WS)
    recordCodeWorkerSeen('windows', 'discovery', 1)
    enqueueCodeTask({ project: 'marveen', prompt: 'Javitasi feladat (#337)\nmasodik sor', origin: 'api' })
    const act = codeBridgeActivity()
    expect(act.queuedTasks).toEqual([{ project: 'marveen', prompt: 'Javitasi feladat (#337)\nmasodik sor' }])
  })

  it('elnemult worker: a kiadott munkat senki nem viszi -- ez a "lefagyott" eset, nem a zold', () => {
    upsertCodeSession(WS)
    // Worker-jelentes nelkul a hid nincs online.
    enqueueCodeTask({ project: 'marveen', prompt: 'senki nem viszi', origin: 'api' })
    const act = codeBridgeActivity()
    expect(act.queued).toBe(1)
    expect(act.workerOnline).toBe(false)
    expect(codeBridgeDisplayState(act, true).state).toBe('stopped')
  })
})

describe('felulet: EGY meresbol lesz zold minden kartyan', () => {
  it('a 3 masodperces szavazas a kiszolgalo allapotat hasznalja, nem szamol ujra', () => {
    // Ha a felulet maga dontene, ket kulonbozo "dolgozik" fogalom lenne.
    expect(app).toContain("const cbWorking = !!cbEntry && cbEntry.state === 'working'")
    expect(app).toContain("const workingCount = entries.filter((e) => e.state === 'working').length")
  })

  it('a kod-hid kartyajanak elso kirajzolasa UGYANAZT a feltetelt hasznalja (nincs 3 masodperces villogas)', () => {
    expect(app).toContain('(codeBridgeCards.running > 0 || (codeBridgeCards.queued > 0 && codeBridgeCards.workerOnline))')
  })

  it('a zold cimkeje kimondja, ha a munka meg csak ki van adva', () => {
    expect(app).toContain("meta.label = t('activity.state.working_queued')")
    expect(app).toContain("cbEntry.queuedOnly ? t('activity.state.working_queued') : t('activity.state.working')")
  })

  it('a ket uj kulcs MINDKET nyelvben megvan', () => {
    for (const kulcs of ['activity.state.working_queued', 'activity.state_tip.working_queued']) {
      expect(hu).toContain(`'${kulcs}'`)
      expect(en).toContain(`'${kulcs}'`)
    }
  })
})
