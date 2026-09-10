// Tests for the dead sub-agent Telegram reply (kanban d3ce7696, Boss uzenet 821).
//
// decideDeadAgentReply is pure -- no tmux, no filesystem, no network -- so the
// exact rule ("react only to Boss's own inbound message, never to an
// autonomous state change") is exercised without any I/O, mirroring
// shouldWakeForTelegramInbox in telegram-inbox-wake.test.ts.

import { describe, it, expect } from 'vitest'
import { decideDeadAgentReply, deadAgentReplyText, DEAD_AGENT_REPLY_TEXT } from '../web/dead-agent-reply.js'

const BASE = {
  isRunning: false,
  downStreak: 1, // one below the debounce threshold of 2
  debounceThreshold: 2,
  pending: { updateId: 42, chatId: 8736799466 },
  lastRepliedUpdateId: null as number | null,
}

describe('decideDeadAgentReply (pure gate decision)', () => {
  it('replies once the agent has been confirmed dead across the debounce window and a message is pending', () => {
    const r = decideDeadAgentReply(BASE)
    expect(r.downStreak).toBe(2)
    expect(r.reply).toEqual({ chatId: 8736799466, updateId: 42 })
    expect(r.lastRepliedUpdateId).toBe(42)
  })

  it('does NOT reply on the first down reading -- a restart blip must not fire', () => {
    const r = decideDeadAgentReply({ ...BASE, downStreak: 0 })
    expect(r.downStreak).toBe(1)
    expect(r.reply).toBeNull()
  })

  it('does NOT reply, and RESETS state, purely because the agent came back alive (no message)', () => {
    const r = decideDeadAgentReply({ ...BASE, isRunning: true, pending: null, lastRepliedUpdateId: 7 })
    expect(r.downStreak).toBe(0)
    expect(r.lastRepliedUpdateId).toBeNull()
    expect(r.reply).toBeNull()
  })

  it('does NOT reply when the agent is confirmed dead but nothing is pending -- a crash alone must never speak', () => {
    const r = decideDeadAgentReply({ ...BASE, pending: null })
    expect(r.reply).toBeNull()
  })

  it('does NOT reply when the pending update has no chat to answer into', () => {
    const r = decideDeadAgentReply({ ...BASE, pending: { updateId: 42, chatId: null } })
    expect(r.reply).toBeNull()
  })

  it('does NOT reply twice for the exact same pending update_id (no duplicate spam)', () => {
    const r = decideDeadAgentReply({ ...BASE, lastRepliedUpdateId: 42 })
    expect(r.reply).toBeNull()
    expect(r.lastRepliedUpdateId).toBe(42)
  })

  it('replies again when a NEW message arrives after one already answered', () => {
    const r = decideDeadAgentReply({ ...BASE, lastRepliedUpdateId: 41 })
    expect(r.reply).toEqual({ chatId: 8736799466, updateId: 42 })
  })

  it('keeps accumulating downStreak past the threshold without re-triggering extra state churn', () => {
    const r = decideDeadAgentReply({ ...BASE, downStreak: 5, lastRepliedUpdateId: 42 })
    expect(r.downStreak).toBe(6)
    expect(r.reply).toBeNull()
  })
})

describe('deadAgentReplyText', () => {
  it('renders the Hungarian text with the agent name interpolated', () => {
    const text = deadAgentReplyText('hu', 'Segédmunkás')
    expect(text).toContain('Segédmunkás')
    expect(text).toContain('nem élek')
  })

  it('renders English for a non-Hungarian install', () => {
    const text = deadAgentReplyText('en', 'Helper')
    expect(text).toContain('Helper')
    expect(text).toContain('not alive')
  })

  it('falls back to Hungarian for an unknown language code', () => {
    expect(deadAgentReplyText('xx', 'X')).toBe(DEAD_AGENT_REPLY_TEXT['hu']!('X'))
  })
})

// ---------------------------------------------------------------------------
// A HUZAL (2026-09-10, kanban d3ce7696 -- "csinald keszre")
//
// A ket veget mar tesztelte a fenti blokk (a tiszta dontes) es a
// channel-coordinator teszt (a probe). A kozottuk levo szal nem volt tesztelve,
// es pont ott volt a hiba: a modul AWAIT-elte a sendMessage-t, majd a valaszt
// meg sem nezve elmentette, hogy "erre az uzenetre mar valaszolt". Egy 400/403
// (chat not found, bot blocked) igy megkulonboztethetetlen volt a sikertol: a
// gazda semmit nem kapott, a naplo "replied"-ot irt, es SOHA nem probalta ujra.
// Ugyanaz a nema-kuldes csapda, amit a repo sajat szabalya tilt az
// /api/messages-nel ("egy uzenet CSAK akkor szamit elkuldottnek, ha visszajott
// egy id").
import { afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AGENT = 'deadone'
const CHAT = 8736799466
const UPDATE = 4242

let store: string
let stateDir: string
let calls: Array<{ url: string; body: unknown }>
let logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }>
let respond: () => Response | Promise<Response>

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'dead-agent-store-'))
  stateDir = mkdtempSync(join(tmpdir(), 'dead-agent-chan-'))
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=123:FAKE\n')
  calls = []
  logs = []
  respond = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
})

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.doUnmock('../config.js')
  vi.doUnmock('../web/agent-config.js')
  vi.doUnmock('../web/agent-process.js')
  vi.doUnmock('../web/voice-directive.js')
  vi.doUnmock('../channel-coordinator/telegram-client.js')
  vi.doUnmock('../logger.js')
  rmSync(store, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

/** Load the module with every edge stubbed EXCEPT the piece under test: the
 *  path from "a reply was decided" to "the owner actually has it". */
async function loadTick() {
  vi.resetModules()
  vi.doMock('../config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config.js')>()
    return { ...actual, STORE_DIR: store, MAIN_AGENT_ID: 'mainagent', APP_LANG: 'hu', DEAD_AGENT_REPLY_ENABLED: true }
  })
  vi.doMock('../web/agent-config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../web/agent-config.js')>()
    return { ...actual, listAgentNames: () => [AGENT], readAgentDisplayName: () => 'Deadone' }
  })
  vi.doMock('../web/agent-process.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../web/agent-process.js')>()
    return { ...actual, isAgentRunning: () => false }
  })
  vi.doMock('../web/voice-directive.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../web/voice-directive.js')>()
    return { ...actual, resolveAgentChannelStateDir: () => stateDir }
  })
  vi.doMock('../channel-coordinator/telegram-client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../channel-coordinator/telegram-client.js')>()
    return { ...actual, probeLatestPendingChat: async () => ({ updateId: UPDATE, chatId: CHAT }) }
  })
  vi.doMock('../logger.js', () => ({
    logger: {
      error: (obj: Record<string, unknown>, msg: string) => { logs.push({ level: 'error', obj, msg }) },
      warn: (obj: Record<string, unknown>, msg: string) => { logs.push({ level: 'warn', obj, msg }) },
      info: (obj: Record<string, unknown>, msg: string) => { logs.push({ level: 'info', obj, msg }) },
      debug: () => {},
    },
  }))
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return await respond()
  })
  return await import('../web/dead-agent-reply.js')
}

const statePath = () => join(store, 'dead-agent-reply-state.json')
const persistedFor = (agent: string): number | null | undefined => {
  if (!existsSync(statePath())) return undefined
  return (JSON.parse(readFileSync(statePath(), 'utf-8')) as Record<string, { lastRepliedUpdateId: number | null }>)[agent]?.lastRepliedUpdateId
}

describe('dead-agent-reply huzal: a kezbesitest ELLENORIZNI kell, nem felteteleezni', () => {
  it('sikeres kuldes utan kimegy az uzenet ES csak EKKOR jegyzi meg megvalaszoltnak', async () => {
    const { runDeadAgentReplyTick } = await loadTick()
    await runDeadAgentReplyTick() // 1. tick: debounce, meg nem kuld
    expect(calls.length, 'a debounce elso tickjen meg nem szabad kuldeni').toBe(0)
    await runDeadAgentReplyTick() // 2. tick: halottnak szamit

    expect(calls.length).toBe(1)
    expect(calls[0].url).toContain('/sendMessage')
    expect((calls[0].body as { chat_id: number }).chat_id).toBe(CHAT)
    expect(persistedFor(AGENT)).toBe(UPDATE)
    expect(logs.some((l) => l.level === 'info' && l.msg.includes('replied'))).toBe(true)
  })

  it('403-nal NEM allitja hogy valaszolt, es a naplo kimondja hogy nem ment ki', async () => {
    respond = () => new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })
    const { runDeadAgentReplyTick } = await loadTick()
    await runDeadAgentReplyTick()
    await runDeadAgentReplyTick()

    expect(calls.length).toBe(1)
    expect(logs.some((l) => l.level === 'info' && l.msg.includes('replied')), 'egy NEM kezbesitett uzenetet tilos "replied"-nak naplozni').toBe(false)
    const gaveUp = logs.find((l) => l.level === 'error')
    expect(gaveUp?.msg).toContain('could NOT be delivered')
    expect(String(gaveUp?.obj['reason'])).toContain('403')
  })

  it('atmeneti hiba utan a KOVETKEZO tick ujraprobalja (nem irja le a kerdest)', async () => {
    respond = () => { throw new Error('fetch failed') }
    const { runDeadAgentReplyTick } = await loadTick()
    await runDeadAgentReplyTick()
    await runDeadAgentReplyTick() // 1. kuldesi kiserlet -> halozati hiba

    expect(calls.length).toBe(1)
    expect(persistedFor(AGENT), 'egy meg nem kezbesitett uzenetet tilos megvalaszoltkent elmenteni').toBeUndefined()

    respond = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    await runDeadAgentReplyTick() // 2. kiserlet -> sikerul
    expect(calls.length).toBe(2)
    expect(persistedFor(AGENT)).toBe(UPDATE)
  })

  it('tartos atmeneti hiba eseten HARMADIK kiserlet utan feladja, nem lesz 5 masodperces forro hurok', async () => {
    respond = () => { throw new Error('fetch failed') }
    const { runDeadAgentReplyTick } = await loadTick()
    for (let i = 0; i < 6; i++) await runDeadAgentReplyTick()

    expect(calls.length, 'MAX_SEND_ATTEMPTS utan meg kell allnia').toBe(3)
    expect(persistedFor(AGENT)).toBe(UPDATE)
    expect(logs.some((l) => l.level === 'error' && l.msg.includes('could NOT be delivered'))).toBe(true)
  })

  it('HTTP 200 de ok:false (a Bot API sajat hibaja) NEM szamit kezbesitesnek', async () => {
    respond = () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 200 })
    const { runDeadAgentReplyTick } = await loadTick()
    await runDeadAgentReplyTick()
    await runDeadAgentReplyTick()

    expect(logs.some((l) => l.level === 'info' && l.msg.includes('replied'))).toBe(false)
    expect(logs.some((l) => l.level === 'error' && String(l.obj['reason']).includes('chat not found'))).toBe(true)
  })
})

describe('decideAfterSendFailure (tiszta ujraprobalasi szabaly)', () => {
  it('tartos hibanal (4xx) azonnal felad -- az ujraproba nem segit', async () => {
    const { decideAfterSendFailure } = await import('../web/dead-agent-reply.js')
    expect(decideAfterSendFailure({ permanent: true, attempts: 1, maxAttempts: 3 })).toBe('give-up')
  })

  it('atmeneti hibanal a kuszob alatt ujraprobal, a kuszobon felad', async () => {
    const { decideAfterSendFailure } = await import('../web/dead-agent-reply.js')
    expect(decideAfterSendFailure({ permanent: false, attempts: 1, maxAttempts: 3 })).toBe('retry')
    expect(decideAfterSendFailure({ permanent: false, attempts: 2, maxAttempts: 3 })).toBe('retry')
    expect(decideAfterSendFailure({ permanent: false, attempts: 3, maxAttempts: 3 })).toBe('give-up')
  })
})
