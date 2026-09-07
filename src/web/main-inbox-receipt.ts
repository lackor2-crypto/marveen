/**
 * Erkezesi nyugta a FO agensnek (kanban #214).
 *
 * Boss, 2026-09-03: "11.55 kor irtam neked. de meg mindig nem jott visszajelzes
 * hogy vetted e a lapot. miert? ez bug."
 *
 * A hianyzo darab pontosan korulhatarolhato volt (merve 2026-09-07):
 *
 *  - Az al-agenseknel MAR VAN nyugta: a csatorna-plugin a tee wrapperen at indul
 *    (scripts/channel-inbound-tee.mjs), az minden bejovo ertesitest lat, es
 *    azonnal kikuldi a "Megkaptam, sorban all..." uzenetet.
 *  - A FO agens csatornaja nem igy indul (scripts/channels.sh, natív
 *    `--channels`), es az agent-process.ts szandekosan ki is zarja
 *    (`name !== MAIN_AGENT_ID`, CATASTROPHE GUARD): a fo agens plugin-jenek
 *    atkotese a tulajdonos sajat Telegram-vonalat nemithatja el.
 *  - A fo agens egyetlen nyugta-szeru eleme a telegram_progress.py
 *    (UserPromptSubmit), az viszont a FORDULO INDULASAKOR sul el. Egy mar futo,
 *    hosszu fordulo kozben erkezo uzenetre ezert semmi nem valaszol.
 *
 * Amit ez a modul kihasznal: a fo agens sajat beszelgetes-naploja (a Claude Code
 * transcript JSONL) az uzenetet MAR AZ ERKEZESKOR rogziti, egy
 * `{"type":"queue-operation","operation":"enqueue","content":"<channel ...>"}`
 * sorral -- a `user` bejegyzes csak kesobb, az ATVETELKOR keletkezik. A ket
 * idobelyeg kulonbsege maga a panasz: 2026-09-07 10:56:48-kor erkezett,
 * 10:57:56-kor lett atveve.
 *
 * Ezert itt nem nyulunk sem a pluginhoz, sem a tokenhez masodik lekerdezovel
 * (masodik getUpdates = Telegram 409 Conflict): csak OLVASSUK a naplot, es ha
 * egy erkezes a turelmi idon belul nem lett atveve, kikuldjuk a nyugtat. Amikor
 * az agens vegre atveszi, a nyugtat toroljuk -- a helyet a telegram_progress.py
 * "Dolgozom rajta..." helyorzoje veszi at, tehat nem marad szemet a chatben.
 *
 * Friss telepites: nincs mit beallitani. Ha meg nincs beszelgetes-naplo vagy
 * nincs csatorna-token, a modul NEM hallgat bele a semmibe: kimondja a naploban,
 * hogy melyik ok miatt nem mer (a nulla ket jelentese).
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { PROJECT_ROOT, APP_LANG, MAIN_INBOX_RECEIPT, MAIN_INBOX_RECEIPT_GRACE_SEC } from '../config.js'

/** Same wording as the sub-agent path (scripts/channel-inbound-tee.mjs), so the
 *  owner sees one receipt style across the whole fleet. */
export const RECEIPT_TEXT: Record<string, string> = {
  hu: '\u{1F4E5} Megkaptam, sorban \u00e1ll\u2026',
  en: '\u{1F4E5} Got it, queued\u2026',
}

export function receiptText(lang: string): string {
  return RECEIPT_TEXT[lang] ?? RECEIPT_TEXT['hu']!
}

/** Claude Code derives a project transcript directory from the cwd by replacing
 *  every non-alphanumeric character with a dash. Derived, never hardcoded, so a
 *  fork installed anywhere finds its own directory. */
export function transcriptDirFor(projectRoot: string, home: string = homedir()): string {
  return join(home, '.claude', 'projects', projectRoot.replace(/[^A-Za-z0-9]/g, '-'))
}

export interface Arrival {
  chatId: string
  srcMessageId: string
  atMs: number
}

export interface TranscriptEvents {
  arrivals: Arrival[]
  /** src message ids the session has actually taken into a turn */
  ingested: string[]
}

const CHANNEL_FRAME = /<channel\s+source="[^"]*telegram[^"]*"/i
const CHAT_ID = /chat_id="([^"]+)"/
const MSG_ID = /message_id="([^"]+)"/

/** Parse a transcript chunk. Pure: the tests drive this directly. */
export function readTranscriptEvents(chunk: string): TranscriptEvents {
  const arrivals: Arrival[] = []
  const ingested: string[] = []
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue // a half-written last line: the next tick re-reads it whole
    }
    const type = rec['type']
    if (type === 'queue-operation' && rec['operation'] === 'remove') {
      // MERT viselkedes (2026-09-07): a sorbol kivett uzenet nem mindig kap
      // kulon `user` bejegyzest -- a 5227-es uzenet csak `remove`-kent latszik.
      // A `remove` ugyanugy azt jelenti, hogy mar nem all sorban, tehat a
      // nyugtat itt is le kell venni, kulonben orokre a chatben maradna.
      const content = typeof rec['content'] === 'string' ? (rec['content'] as string) : ''
      if (!CHANNEL_FRAME.test(content)) continue
      const mid = MSG_ID.exec(content)?.[1]
      if (mid) ingested.push(mid)
      continue
    }
    if (type === 'queue-operation' && rec['operation'] === 'enqueue') {
      const content = typeof rec['content'] === 'string' ? (rec['content'] as string) : ''
      if (!CHANNEL_FRAME.test(content)) continue
      const chat = CHAT_ID.exec(content)?.[1]
      const mid = MSG_ID.exec(content)?.[1]
      if (!chat || !mid) continue
      const at = Date.parse(String(rec['timestamp'] ?? ''))
      arrivals.push({ chatId: chat, srcMessageId: mid, atMs: Number.isFinite(at) ? at : Date.now() })
      continue
    }
    if (type === 'user') {
      // The frame reaches the model as the user turn's content; whatever shape
      // it has (string or content blocks), the id is in the serialized text.
      // JSON.stringify escapes the frame's quotes (source=\" ...), so normalise
      // them back before matching -- otherwise the frame is never recognised and
      // an ingested message would keep its receipt forever.
      const serialized = JSON.stringify(rec['message'] ?? '').replace(/\\"/g, '"')
      if (!CHANNEL_FRAME.test(serialized)) continue
      for (const m of serialized.matchAll(/message_id="([^"]+)"/g)) ingested.push(m[1]!)
    }
  }
  return { arrivals, ingested }
}

interface PendingArrival extends Arrival {
  /** id of the receipt we posted, so it can be removed on ingestion */
  receiptMessageId?: number
}

export interface ReceiptDeps {
  transcriptDir: string
  /** telegram state dir of the agent (token + progress markers live here) */
  stateDir: string
  apiBase: string
  graceMs: number
  lang: string
  now: () => number
  fetchImpl: typeof fetch
}

export interface ReceiptState {
  offsets: Map<string, number>
  pending: Map<string, PendingArrival>
  lastSilenceReason?: string
}

export function createReceiptState(): ReceiptState {
  return { offsets: new Map(), pending: new Map() }
}

function botToken(stateDir: string): string | null {
  try {
    const raw = readFileSync(join(stateDir, '.env'), 'utf8')
    const line = raw.split('\n').find((l) => l.startsWith('TELEGRAM_BOT_TOKEN='))
    const tok = line ? line.slice('TELEGRAM_BOT_TOKEN='.length).trim() : ''
    return tok || null
  } catch {
    return null
  }
}

/** O_EXCL claim, sharing the marker convention with the tee: a restart, a second
 *  notification or a second reader must never post the same receipt twice. */
function claimArrival(stateDir: string, chatId: string, srcMid: string): boolean {
  try {
    const dir = join(stateDir, 'progress')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `seen-arrival-${chatId}-${srcMid}.marker`), '', { flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false
    return true // a broken marker dir must not swallow the receipt
  }
}

/** Follow the appended tail of every recently written transcript in the dir.
 *  A file seen for the FIRST time starts at its current end: an install that
 *  restarts must not re-notify yesterday's messages. */
function pullNewLines(state: ReceiptState, dir: string): string {
  if (!existsSync(dir)) {
    state.lastSilenceReason = 'no-transcript-dir'
    return ''
  }
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    state.lastSilenceReason = 'transcript-dir-unreadable'
    return ''
  }
  if (names.length === 0) {
    state.lastSilenceReason = 'no-session-transcript'
    return ''
  }
  state.lastSilenceReason = undefined
  let out = ''
  for (const name of names) {
    const path = join(dir, name)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      continue
    }
    const seen = state.offsets.get(path)
    if (seen === undefined) {
      state.offsets.set(path, size)
      continue
    }
    if (size < seen) {
      state.offsets.set(path, size) // truncated or rotated
      continue
    }
    if (size === seen) continue
    let fd: number | null = null
    try {
      fd = openSync(path, 'r')
      const len = size - seen
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, seen)
      out += buf.toString('utf8')
      state.offsets.set(path, size)
    } catch {
      // unreadable right now: keep the old offset and retry next tick
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }
  return out
}

async function callApi(deps: ReceiptDeps, token: string, method: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const res = await deps.fetchImpl(`${deps.apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return (await res.json()) as Record<string, unknown>
  } catch (err) {
    logger.warn(`main-inbox-receipt: ${method} nem ment at: ${(err as Error)?.message ?? err}`)
    return null
  }
}

/** One pass: read the tail, retire ingested arrivals, post the due receipts. */
export async function runReceiptTick(state: ReceiptState, deps: ReceiptDeps): Promise<void> {
  const chunk = pullNewLines(state, deps.transcriptDir)
  if (chunk) {
    const { arrivals, ingested } = readTranscriptEvents(chunk)
    for (const a of arrivals) {
      if (!state.pending.has(a.srcMessageId)) state.pending.set(a.srcMessageId, { ...a })
    }
    for (const mid of ingested) {
      const p = state.pending.get(mid)
      if (!p) continue
      state.pending.delete(mid)
      // Taken into a turn: telegram_progress.py posts its own "working on it"
      // placeholder now, so our receipt has done its job and is removed.
      if (p.receiptMessageId !== undefined) {
        const token = botToken(deps.stateDir)
        if (token) await callApi(deps, token, 'deleteMessage', { chat_id: p.chatId, message_id: p.receiptMessageId })
      }
    }
  }

  const due = [...state.pending.values()].filter((p) => p.receiptMessageId === undefined && deps.now() - p.atMs >= deps.graceMs)
  if (due.length === 0) return
  const token = botToken(deps.stateDir)
  if (!token) {
    state.lastSilenceReason = 'no-channel-token'
    return // unconfigured install: stay silent, never guess a token
  }
  for (const p of due) {
    if (!claimArrival(deps.stateDir, p.chatId, p.srcMessageId)) {
      state.pending.delete(p.srcMessageId)
      continue
    }
    const body = await callApi(deps, token, 'sendMessage', {
      chat_id: p.chatId,
      text: receiptText(deps.lang),
      disable_notification: true,
    })
    const result = body?.['result'] as Record<string, unknown> | undefined
    const mid = result?.['message_id']
    p.receiptMessageId = typeof mid === 'number' ? mid : -1
  }
}

let timer: NodeJS.Timeout | null = null

/** Wired from src/index.ts. Default ON: an install that never touches a setting
 *  still gets the receipt, which is the whole point of #214. */
export function startMainInboxReceipt(): NodeJS.Timeout | null {
  if (!MAIN_INBOX_RECEIPT) {
    logger.info('main-inbox-receipt: kikapcsolva (MAIN_INBOX_RECEIPT=0)')
    return null
  }
  const state = createReceiptState()
  const deps: ReceiptDeps = {
    transcriptDir: transcriptDirFor(PROJECT_ROOT),
    stateDir: join(homedir(), '.claude', 'channels', 'telegram'),
    apiBase: process.env['TELEGRAM_API_BASE'] || 'https://api.telegram.org',
    graceMs: MAIN_INBOX_RECEIPT_GRACE_SEC * 1000,
    lang: APP_LANG,
    now: () => Date.now(),
    fetchImpl: fetch,
  }
  let loggedSilence = ''
  const tick = () => {
    void runReceiptTick(state, deps)
      .then(() => {
        const reason = state.lastSilenceReason ?? ''
        if (reason && reason !== loggedSilence) {
          // "Nem lattam oda" es "nincs bejovo uzenet" nem ugyanaz: ki kell mondani.
          logger.warn(`main-inbox-receipt: nem tudok merni (${reason}), ezert nem kuldok nyugtat`)
          loggedSilence = reason
        } else if (!reason && loggedSilence) {
          logger.info('main-inbox-receipt: a beszelgetes-naplo ujra olvashato, a nyugta el')
          loggedSilence = ''
        }
      })
      .catch((err) => logger.warn(`main-inbox-receipt: kor sikertelen: ${(err as Error)?.message ?? err}`))
  }
  tick()
  timer = setInterval(tick, 5000)
  timer.unref?.()
  logger.info(`main-inbox-receipt: figyelem a fo agens beszelgetes-naplojat (turelmi ido ${MAIN_INBOX_RECEIPT_GRACE_SEC}s)`)
  return timer
}

export function stopMainInboxReceipt(): void {
  if (timer) clearInterval(timer)
  timer = null
}
