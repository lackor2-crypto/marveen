/**
 * Kanban #214: a fo agens erkezesi nyugtaja.
 *
 * A teszt a MERT valosagot rogziti (2026-09-07, a fo agens sajat naplojabol):
 * az uzenet AZ ERKEZESKOR kerul a naploba egy `queue-operation/enqueue` sorkent,
 * es csak kesobb, az ATVETELKOR keletkezik belole `user` bejegyzes. A nyugta
 * pontosan a ket idopont kozotti resre valaszol.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readTranscriptEvents,
  transcriptDirFor,
  receiptText,
  createReceiptState,
  runReceiptTick,
  type ReceiptDeps,
} from '../web/main-inbox-receipt.js'
import type { AgentRunState } from '../web/ssh-tmux.js'

const ARRIVAL = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: '2026-09-07T10:56:48.894Z',
  sessionId: 'a1e213f1',
  content:
    '<channel source="plugin:telegram:telegram" chat_id="8736799466" message_id="5230" user="8736799466" ts="2026-09-07T10:56:48.000Z">\nadtal ki most feladatot?\n</channel>',
})
const INGEST = JSON.stringify({
  type: 'user',
  timestamp: '2026-09-07T10:57:56.231Z',
  message: {
    role: 'user',
    content:
      '<channel source="plugin:telegram:telegram" chat_id="8736799466" message_id="5230" user="8736799466" ts="2026-09-07T10:56:48.000Z">\nadtal ki most feladatot?\n</channel>',
  },
})

describe('readTranscriptEvents', () => {
  it('az erkezest az enqueue sorbol veszi ki, nem a user bejegyzesbol', () => {
    const ev = readTranscriptEvents(ARRIVAL + '\n')
    expect(ev.arrivals).toHaveLength(1)
    expect(ev.arrivals[0]!.chatId).toBe('8736799466')
    expect(ev.arrivals[0]!.srcMessageId).toBe('5230')
    expect(ev.arrivals[0]!.atMs).toBe(Date.parse('2026-09-07T10:56:48.894Z'))
    expect(ev.ingested).toHaveLength(0)
  })

  it('a user bejegyzest atvetelnek olvassa', () => {
    expect(readTranscriptEvents(INGEST + '\n').ingested).toEqual(['5230'])
  })

  it('a sorbol kivett (remove) uzenet is atvettnek szamit', () => {
    // A 5227-es uzenet a fo agens naplojaban CSAK remove-kent zarul le, user
    // bejegyzes nelkul -- ha ezt nem vennenk figyelembe, a nyugta bennmaradna.
    const removed = JSON.stringify({
      type: 'queue-operation',
      operation: 'remove',
      timestamp: '2026-09-07T10:50:35.511Z',
      content: '<channel source="plugin:telegram:telegram" chat_id="8736799466" message_id="5227">\nszia\n</channel>',
    })
    expect(readTranscriptEvents(removed + '\n').ingested).toEqual(['5227'])
  })

  it('a nem-csatorna sorokat es a felig kiirt utolso sort atlepi', () => {
    const noise =
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '[inbox-wakeup]' }) + '\n{"type":"user","mess'
    const ev = readTranscriptEvents(noise)
    expect(ev.arrivals).toHaveLength(0)
    expect(ev.ingested).toHaveLength(0)
  })
})

describe('transcriptDirFor', () => {
  it('a cwd-bol szarmaztat, nem beegetett utbol', () => {
    expect(transcriptDirFor('/opt/marveen', '/home/geza')).toBe('/home/geza/.claude/projects/-opt-marveen')
  })
})

describe('receiptText', () => {
  it('a telepites nyelvet koveti, ismeretlen nyelvnel magyar', () => {
    expect(receiptText('hu')).toContain('Megkaptam')
    expect(receiptText('en')).toContain('queued')
    expect(receiptText('de')).toBe(receiptText('hu'))
  })
})

describe('runReceiptTick', () => {
  let dir: string
  let transcriptDir: string
  let stateDir: string
  let calls: Array<{ method: string; body: Record<string, unknown> }>
  let now = 0
  /** A fo agens eletjele -- a tesztek ezt allitjak at. */
  let mainState: AgentRunState = 'running'

  const deps = (): ReceiptDeps => ({
    runState: () => mainState,
    transcriptDir,
    stateDir,
    apiBase: 'http://stub',
    graceMs: 15_000,
    lang: 'hu',
    now: () => now,
    fetchImpl: (async (url: unknown, init: unknown) => {
      const u = String(url)
      const method = u.slice(u.lastIndexOf('/') + 1)
      calls.push({ method, body: JSON.parse(String((init as { body: string }).body)) })
      return { json: async () => ({ ok: true, result: { message_id: 991 } }) }
    }) as unknown as typeof fetch,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'main-inbox-receipt-'))
    transcriptDir = join(dir, 'projects')
    stateDir = join(dir, 'telegram')
    mkdirSync(transcriptDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=123:ABC\n')
    calls = []
    mainState = 'running'
    now = Date.parse('2026-09-07T10:56:48.894Z')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a mar meglevo naplot NEM jatssza ujra (ujrainditas nem nyugtaz visszamenoleg)', async () => {
    const f = join(transcriptDir, 's.jsonl')
    writeFileSync(f, ARRIVAL + '\n')
    const st = createReceiptState()
    now += 60_000
    await runReceiptTick(st, deps())
    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(0)
  })

  it('turelmi idon belul atvett uzenetre NEM kuld nyugtat', async () => {
    const f = join(transcriptDir, 's.jsonl')
    writeFileSync(f, '')
    const st = createReceiptState()
    await runReceiptTick(st, deps())
    appendFileSync(f, ARRIVAL + '\n')
    now += 2000
    await runReceiptTick(st, deps())
    appendFileSync(f, INGEST + '\n')
    now += 2000
    await runReceiptTick(st, deps())
    now += 60_000
    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(0)
  })

  it('a sorban rekedt uzenetre nyugtaz, majd atvetelkor torli a nyugtat', async () => {
    const f = join(transcriptDir, 's.jsonl')
    writeFileSync(f, '')
    const st = createReceiptState()
    await runReceiptTick(st, deps())
    appendFileSync(f, ARRIVAL + '\n')
    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(0) // meg turelmi idon belul

    now += 20_000
    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('sendMessage')
    expect(calls[0]!.body['chat_id']).toBe('8736799466')
    expect(String(calls[0]!.body['text'])).toContain('Megkaptam')
    expect(existsSync(join(stateDir, 'progress', 'seen-arrival-8736799466-5230.marker'))).toBe(true)

    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(1) // ketszer nem kuld

    appendFileSync(f, INGEST + '\n')
    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(2)
    expect(calls[1]!.method).toBe('deleteMessage')
    expect(calls[1]!.body['message_id']).toBe(991)
  })

  it('token nelkul hallgat, es megmondja MIERT (nem "nincs uzenet")', async () => {
    rmSync(join(stateDir, '.env'))
    const f = join(transcriptDir, 's.jsonl')
    writeFileSync(f, '')
    const st = createReceiptState()
    await runReceiptTick(st, deps())
    appendFileSync(f, ARRIVAL + '\n')
    now += 20_000
    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(0)
    expect(st.lastSilenceReason).toBe('no-channel-token')
  })

  it('friss telepites: hianyzo naplo-mappa nem "minden rendben", hanem megnevezett ok', async () => {
    const st = createReceiptState()
    const d = deps()
    d.transcriptDir = join(dir, 'nincs-ilyen')
    await runReceiptTick(st, d)
    expect(st.lastSilenceReason).toBe('no-transcript-dir')

    mkdirSync(join(dir, 'nincs-ilyen'))
    await runReceiptTick(st, d)
    expect(st.lastSilenceReason).toBe('no-session-transcript')
  })

  // ---- Eletjel-kapu (a d3ce7696 kartya hatasvizsgalatabol) ----------------
  //
  // A d3ce7696 ota a dead-agent-reply a FO agensre is szol. Ha a fo agens
  // meghal egy mar sorbaallt uzenettel, a ket modul egymasnak dolgozott: a
  // halal-verdikt ~10 mp-nel ment ki, a nyugta 15 mp-nel -- a tulajdonos
  // utolso szava tehat a hamis "megkaptam, sorban all" volt, es az soha nem
  // torlodott, mert az atvetel (ami torolne) mar nem jott el.

  it('halott fo agensnel NEM igeri, hogy az uzenet sorban all', async () => {
    const f = join(transcriptDir, 's.jsonl')
    writeFileSync(f, '')
    const st = createReceiptState()
    await runReceiptTick(st, deps())
    appendFileSync(f, ARRIVAL + '\n')
    mainState = 'stopped'
    now += 20_000 // a turelmi ido MAR letelt: elo agensnel itt menne a nyugta
    await runReceiptTick(st, deps())
    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(0)
    expect(st.lastSilenceReason).toBe('main-agent-not-running')
    // Igazoltan halott (2 kor) utan a fuggo erkezes el is tunik: erre a
    // dead-agent-reply adja a helyes valaszt, nem mi.
    expect(st.pending.size).toBe(0)
  })

  it('EGYETLEN "nem fut" meres meg nem nemitja el a jogos nyugtat', async () => {
    const f = join(transcriptDir, 's.jsonl')
    writeFileSync(f, '')
    const st = createReceiptState()
    await runReceiptTick(st, deps())
    appendFileSync(f, ARRIVAL + '\n')
    now += 20_000
    mainState = 'stopped'
    await runReceiptTick(st, deps()) // egy meresi kihagyas
    expect(calls).toHaveLength(0)
    expect(st.pending.size).toBe(1)
    mainState = 'running'
    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('sendMessage')
  })

  it('a MAR kikuldott nyugtat nem dobja el: az meg torolheto, ha megis atveszi', async () => {
    const f = join(transcriptDir, 's.jsonl')
    writeFileSync(f, '')
    const st = createReceiptState()
    await runReceiptTick(st, deps())
    appendFileSync(f, ARRIVAL + '\n')
    now += 20_000
    await runReceiptTick(st, deps())
    expect(calls).toHaveLength(1)
    mainState = 'stopped'
    await runReceiptTick(st, deps())
    await runReceiptTick(st, deps())
    expect(st.pending.size).toBe(1)
  })
})
