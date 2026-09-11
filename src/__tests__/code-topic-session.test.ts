/**
 * Kanban 2741d289 (#252), 1. resz -- tema-alapu ujrahasznalas-hatar.
 *
 * Boss ket dontese (Telegram, uzenet 821, 2026-09-11):
 *   (a) "ugyanaz a tema" = UGYANAZ A KANBAN KARTYA AZONOSITO (merheto, nem
 *       megitelés kerdese),
 *   (c) ha NINCS kartya a temahoz -> MINDIG uj beszelgetes.
 *
 * Amit ez a suite lezar:
 *   1. a tiszta dontes mind az ot kimenete (kartya nelkul, elozmeny nelkul,
 *      lezart szalnal, eltunt szalnal, es amikor NEM LATUNK ODA),
 *   2. a vegponti ut: ugyanarra a kartyara a kovetkezo feladat abba a
 *      beszelgetesbe megy, AMIBEN AZ ELOZO FUTAS VEGZODOTT (nem abba, amit a
 *      claim a futas elott feljegyzett),
 *   3. mas kartya -> uj szal,
 *   4. a NULLA KET DOLGOT JELENT: ures jeloltlista = "nem latok oda", nem
 *      "nincs ilyen szal" -- es olyankor is uj szal indul, nem talalgatas.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, getDb, createKanbanCard } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, getCodeSession, enqueueCodeTask,
  claimNextCodeTask, getCodeTask, _resetCodeCandidates, recordCodeCandidates,
} from '../web/code-bridge-store.js'
import { decideTopicSession, type TopicSessionDeps } from '../web/code-topic-session.js'
import { tryHandleCode } from '../web/routes/code.js'

const WS = 'C:\\ws\\marvin'
const OLD = 'aaaaaaaa-0000-4000-8000-000000000001'
const FRESH = 'bbbbbbbb-0000-4000-8000-000000000002'
const CARD = 'abcd1234-0000-4000-8000-000000000252'
const OTHER_CARD = 'ef567890-0000-4000-8000-000000000253'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
})

function seedCard(id: string, title: string): void {
  createKanbanCard({ id, title, status: 'in_progress' })
}

// ---------------------------------------------------------------- a dontes maga

function deps(over: Partial<TopicSessionDeps> = {}): TopicSessionDeps {
  return {
    priorSessionsForCard: () => [],
    wasClosed: () => false,
    sessionVisible: () => 'yes',
    ...over,
  }
}

describe('decideTopicSession -- Boss (a) es (c) dontese', () => {
  it('kartya NELKUL mindig uj beszelgetes (Boss (c) dontese)', () => {
    const d = decideTopicSession({ cardRef: null, project: 'marvin', taskId: 't1' }, deps({
      // Meg ha volna is elozmeny, kartya nelkul nincs mihez tartoznia.
      priorSessionsForCard: () => [OLD],
    }))
    expect(d).toEqual({ kind: 'fresh', why: 'no_card' })
  })

  it('ures/whitespace kartya-hivatkozas ugyanaz, mint a hianyzo', () => {
    const d = decideTopicSession({ cardRef: '   ', project: 'marvin', taskId: 't1' }, deps())
    expect(d).toEqual({ kind: 'fresh', why: 'no_card' })
  })

  it('van kartya, de meg nem futott ra munka -> uj beszelgetes', () => {
    const d = decideTopicSession({ cardRef: CARD, project: 'marvin', taskId: 't1' }, deps())
    expect(d).toEqual({ kind: 'fresh', why: 'no_prior_run' })
  })

  it('ugyanaz a kartya + elo, meg nem lezart szal -> FOLYTATAS ugyanabban', () => {
    const d = decideTopicSession({ cardRef: CARD, project: 'marvin', taskId: 't2' }, deps({
      priorSessionsForCard: () => [OLD],
    }))
    expect(d).toEqual({ kind: 'reuse', sessionId: OLD, cardRef: CARD })
  })

  it('a LEGFRISSEBB elozmeny szamit, nem a regebbi', () => {
    const d = decideTopicSession({ cardRef: CARD, project: 'marvin', taskId: 't3' }, deps({
      priorSessionsForCard: () => [FRESH, OLD],
    }))
    expect(d).toEqual({ kind: 'reuse', sessionId: FRESH, cardRef: CARD })
  })

  it('mar ment "lezarva" uzenet abba a szalba -> oda nem irunk tobbet', () => {
    const d = decideTopicSession({ cardRef: CARD, project: 'marvin', taskId: 't2' }, deps({
      priorSessionsForCard: () => [OLD],
      wasClosed: (c, s) => c === CARD && s === OLD,
    }))
    expect(d).toEqual({ kind: 'fresh', why: 'closed' })
  })

  it('lattuk a projekt szalait, es ez mar nincs koztuk -> uj beszelgetes', () => {
    const d = decideTopicSession({ cardRef: CARD, project: 'marvin', taskId: 't2' }, deps({
      priorSessionsForCard: () => [OLD],
      sessionVisible: () => 'no',
    }))
    expect(d).toEqual({ kind: 'fresh', why: 'session_gone' })
  })

  it('NEM LATUNK ODA -> uj beszelgetes, es ez KULON kimenet, nem "eltunt"', () => {
    const d = decideTopicSession({ cardRef: CARD, project: 'marvin', taskId: 't2' }, deps({
      priorSessionsForCard: () => [OLD],
      sessionVisible: () => 'unknown',
    }))
    expect(d).toEqual({ kind: 'fresh', why: 'cannot_see' })
  })
})

// ------------------------------------------------------------ a vegponti ut

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

/** Egy teljes kor: kiadas -> claim -> a futas egy MASIK szalban vegzodik. */
async function runOnce(prompt: string, endedIn: string): Promise<string> {
  enqueueCodeTask({ project: 'marvin', prompt })
  const claimed = await call('POST', '/api/code/tasks/claim', { host: 'w' })
  const id = claimed.body.task.id as string
  await call('POST', `/api/code/tasks/${id}/result`, {
    ok: true, result: 'kesz', host: 'w', resultSessionId: endedIn,
  })
  return id
}

describe('tema-folytatas a teljes uton', () => {
  it('a feladat sora ATALL arra a szalra, amiben a futas VEGZODOTT', async () => {
    seedCard(CARD, 'tema-kartya')
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD })
    const id = await runOnce(`dolgozz a ${CARD.slice(0, 8)} kartyan`, FRESH)

    // Ez a lenyeg: a claim meg az OLD-ot jegyezte fel (a futas ELOTT), a CLI
    // viszont FRESH-ben fejezte be. Ha a sor az OLD-on maradna, a zaro uzenet
    // es a kovetkezo kiadas is IDEGEN csetbe menne.
    expect(getCodeTask(id)!.sessionId).toBe(FRESH)
    expect(getCodeSession('marvin')!.sessionId).toBe(FRESH)
  })

  it('UGYANARRA a kartyara a kovetkezo feladat a REGI szalba megy tovabb', async () => {
    seedCard(CARD, 'tema-kartya')
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD })
    await runOnce(`dolgozz a ${CARD.slice(0, 8)} kartyan`, FRESH)

    enqueueCodeTask({ project: 'marvin', prompt: `folytasd a ${CARD.slice(0, 8)} kartyat` })
    const next = claimNextCodeTask('w')!
    expect(next.cardRef).toBe(CARD)
    expect(next.startFresh).toBe(false)
    expect(next.sessionId).toBe(FRESH)
  })

  it('MAS kartyara mar uj beszelgetes indul, nem a masik tema szalaba ir', async () => {
    seedCard(CARD, 'tema-kartya')
    seedCard(OTHER_CARD, 'masik tema')
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD })
    await runOnce(`dolgozz a ${CARD.slice(0, 8)} kartyan`, FRESH)

    enqueueCodeTask({ project: 'marvin', prompt: `most a ${OTHER_CARD.slice(0, 8)} kartya jon` })
    const next = claimNextCodeTask('w')!
    expect(next.cardRef).toBe(OTHER_CARD)
    expect(next.startFresh).toBe(true)
  })

  it('lezart (kartya, szal) parosnal a folytatas helyett uj beszelgetes indul', async () => {
    seedCard(CARD, 'tema-kartya')
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD })
    await runOnce(`dolgozz a ${CARD.slice(0, 8)} kartyan`, FRESH)

    // Ugyanaz a tabla, amit a zaro uzenet ir (code-session-close-notice.ts).
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS code_session_close_notices (
        card_id TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY (card_id, session_id))
    `)
    getDb()
      .prepare('INSERT INTO code_session_close_notices (card_id, session_id, task_id, created_at) VALUES (?,?,?,?)')
      .run(CARD, FRESH, null, Date.now())

    enqueueCodeTask({ project: 'marvin', prompt: `folytasd a ${CARD.slice(0, 8)} kartyat` })
    const next = claimNextCodeTask('w')!
    expect(next.startFresh).toBe(true)
  })

  it('ha a worker mar jelentett es a szal NINCS koztuk, uj beszelgetes indul', async () => {
    seedCard(CARD, 'tema-kartya')
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: OLD })
    await runOnce(`dolgozz a ${CARD.slice(0, 8)} kartyan`, FRESH)
    // A projekt sora kozben MASIK szalra allt (a tulaj nyitott ujat), es a
    // worker jelentette is, mit lat: a tema szala (FRESH) nincs koztuk.
    const MOVED = 'cccccccc-0000-4000-8000-000000000003'
    upsertCodeSession({ project: 'marvin', workspacePath: WS, sessionId: MOVED })
    recordCodeCandidates('w', [{ sessionId: MOVED, workspacePath: WS, title: 'mas' }])

    enqueueCodeTask({ project: 'marvin', prompt: `folytasd a ${CARD.slice(0, 8)} kartyat` })
    const next = claimNextCodeTask('w')!
    expect(next.startFresh).toBe(true)
  })
})
