// Kartya 032aa826: a Marvin VS Code dispatch ne az AKTUALIS (felderites altal
// talalt, akar a tulaj altal eppen kezzel hasznalt) fulbe irjon cimzes nelkul.
//
// A store-szintu viselkedest (startFresh szamitasa, marvinOwned oroklodese)
// a code-bridge.test.ts "friss beszelgetes cimzes nelkuli dispatchnal" blokkja
// orzi. Ez a fajl a HTTP-szintu utat zarja: a claim valaszban ott van-e a
// startFresh mezo, es a /result vegpont csak akkor jeloli meg a sessiont
// Marvin-sajatnak, ha a lezarult feladat startFresh volt.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, getCodeSession, enqueueCodeTask,
} from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'

const WS = 'C:\\ws\\marvin'
const OLD = 'aaaaaaaa-0000-4000-8000-000000000001'
const FRESH = 'bbbbbbbb-0000-4000-8000-000000000002'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
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

describe('claim valasz hordozza a startFresh jelzest', () => {
  it('cimzes nelkuli, nem-Marvin-sajat projektnel a claim startFresh=true-t ad', async () => {
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD })
    enqueueCodeTask({ project: 'marvin', prompt: 'valami' })
    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'w' })
    expect(claimed.status).toBe(200)
    expect(claimed.body.task.startFresh).toBe(true)
  })

  // ATIRVA (kartya 2741d289, #252, 2026-09-11): Boss dontese (uzenet 821) szerint
  // kartya nelkul MINDIG uj beszelgetes indul -- a `marvinOwned` jeloles onmagaban
  // mar nem valt ki temat.
  it('mar Marvin-sajat projektnel is startFresh=true, ha a feladat egy kartyat sem nevez meg (#252)', async () => {
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD, marvinOwned: true })
    enqueueCodeTask({ project: 'marvin', prompt: 'valami' })
    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'w' })
    expect(claimed.body.task.cardRef).toBe(null)
    expect(claimed.body.task.startFresh).toBe(true)
  })
})

describe('/result: a session csak startFresh feladatnal lesz marvinOwned', () => {
  it('startFresh feladat vege friss sessionre allitja a projektet ES marvinOwned=true-ra jeloli', async () => {
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD })
    enqueueCodeTask({ project: 'marvin', prompt: 'valami' })
    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'w' })
    expect(claimed.body.task.startFresh).toBe(true)
    const id = claimed.body.task.id as string

    const res = await call('POST', `/api/code/tasks/${id}/result`, {
      ok: true, result: 'kesz', host: 'w', resultSessionId: FRESH,
    })
    expect(res.status).toBe(200)

    const session = getCodeSession('marvin')!
    expect(session.sessionId).toBe(FRESH)
    expect(session.marvinOwned).toBe(true)
  })

  it('nem-startFresh (pl. a meglevo Torles-gombos /clear) vegen a repoint NEM allitja be a marvinOwned-ot', async () => {
    // Mar Marvin-sajat sor. A #252 ota a jeloles onmagaban mar NEM eleg a
    // nem-friss claimhez (kartya nelkul mindig uj szal indul), ezert itt a
    // beszelgetes CIMZESEVEL allitjuk elo ugyanazt a helyzetet -- a cimzett ful
    // valtozatlanul a legerosebb jel, es a teszt targya nem a claim, hanem az,
    // hogy a repoint mit csinal a marvinOwned jelolessel.
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD, marvinOwned: true })
    enqueueCodeTask({ project: 'marvin', prompt: '/clear', sessionId: OLD })
    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'w' })
    expect(claimed.body.task.startFresh).toBe(false)
    const id = claimed.body.task.id as string

    // A CLI mégis uj beszelgetest kezdett (pl. a prompt maga volt "/clear").
    const res = await call('POST', `/api/code/tasks/${id}/result`, {
      ok: true, result: 'kesz', host: 'w', resultSessionId: FRESH,
    })
    expect(res.status).toBe(200)

    const session = getCodeSession('marvin')!
    expect(session.sessionId).toBe(FRESH)
    // A repoint megtortent (mint eddig), de a marvinOwned NEM valtozott a
    // repoint miatt -- mar igaz volt, es igaz is marad, mert az upsert
    // marvinOwned nelkul oriz.
    expect(session.marvinOwned).toBe(true)
  })

  it('explicit celzott (target) fulnel a repoint NEM allitja marvinOwned-ra a sessiont', async () => {
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD })
    const out = enqueueCodeTask({ project: 'marvin', prompt: 'valami', sessionId: OLD })
    expect('task' in out).toBe(true)
    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'w' })
    expect(claimed.body.task.startFresh).toBe(false)
    expect(claimed.body.task.targetSessionId).toBe(OLD)
    const id = claimed.body.task.id as string

    const res = await call('POST', `/api/code/tasks/${id}/result`, {
      ok: true, result: 'kesz', host: 'w', resultSessionId: FRESH,
    })
    expect(res.status).toBe(200)

    const session = getCodeSession('marvin')!
    expect(session.sessionId).toBe(FRESH)
    expect(session.marvinOwned).toBe(false)
  })
})
