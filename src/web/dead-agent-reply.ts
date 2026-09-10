// Dead sub-agent Telegram reply (kanban d3ce7696).
//
// Boss, Telegram uzenet 821 (2026-09-08, sajat szavaival): "amikor en elkezdek
// egy telegram uzenetet irni, es kap a dashboard egy telegram uzenetet, akkor
// kell megvizsgalni, hogy el-e az az ugynok, vagy nem el. Ha nem el, akkor
// jojjon vissza egy uzenet, hogy eppen nem el az ugynok [...] De csak ugy
// onmagatol, hogy most kikapcsol, bekapcsol, ujra reszeteli, meg stb. nem
// kellenek semmilyen uzenet. Csak egy reakcio uzenet kell."
//
// The exact rule: reaction is gated SOLELY on Boss's own inbound message,
// NEVER on an autonomous state change (crash/restart/reset produces zero
// messages on its own). The existing wake-greeting ("felebredtem, itt vagyok")
// stays untouched -- Boss confirmed separately (uzenet 823) it is correct and
// unrelated.
//
// WHY THE AGENT ITSELF CANNOT DO THIS: every sub-agent's Telegram poller
// (scripts/channel-inbound-tee.mjs, wired via buildTelegramMcpServerConfig in
// agent-process.ts) is a CHILD PROCESS of that agent's own tmux/Claude Code
// session. When the session dies, the poller dies with it -- nothing is left
// polling that bot's token, so an inbound message just sits unfetched on
// Telegram's servers. Only a separate, always-on component (the dashboard)
// can notice and answer on the agent's behalf.
//
// HOW WE SEE THE MESSAGE WITHOUT A SECOND LIVE POLLER FIGHTING THE FIRST:
// probeLatestPendingChat uses Telegram's offset=-1 trick, which reads the tail
// of the queue WITHOUT confirming it. Precisely because nothing is confirming
// updates for a dead agent, its inbound stays "pending" until something calls
// getUpdates with a real offset -- so this probe only ever races a REAL
// poller when our own liveness read was wrong, and getUpdates then answers
// with 409 Conflict, which we treat as "actually alive, back off" rather than
// an error. No update is ever consumed here: the agent's own tee still
// delivers the same message into its inbox once it comes back up, so this
// reply changes nothing about how the message is eventually processed.
//
// DEBOUNCE: a session must read as not-running for DOWN_DEBOUNCE consecutive
// ticks before we call it dead -- a restart/redeploy blip must never earn a
// spurious "not alive" reply seconds before the agent comes back.
//
// DELIVERY IS VERIFIED, NEVER ASSUMED (2026-09-10). The first version awaited
// sendMessage and then recorded the update as answered without looking at the
// response at all. Telegram answers 400/403 for "chat not found" / "bot was
// blocked", and it also answers HTTP 200 with ok:false in the body -- so a
// REJECTED send was indistinguishable from a delivered one: the owner got
// nothing, the log said "replied", the state file said "already answered", and
// nothing ever retried. An undelivered message is not a reply, so the state is
// now written only AFTER the Bot API confirms ok:true; a transient failure is
// retried on the next tick (bounded by MAX_SEND_ATTEMPTS so a permanently
// unreachable chat cannot become a 5-second hot loop), and a give-up is logged
// at ERROR saying plainly that it did NOT go out.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { APP_LANG, DEAD_AGENT_REPLY_ENABLED, MAIN_AGENT_ID, STORE_DIR } from '../config.js'
import { listAgentNames, readAgentDisplayName } from './agent-config.js'
import { isAgentRunning } from './agent-process.js'
import { resolveAgentChannelStateDir } from './voice-directive.js'
import { probeLatestPendingChat, TelegramApiError } from '../channel-coordinator/telegram-client.js'
import { atomicWriteFileSync } from './atomic-write.js'

const TICK_MS = 5000
const DOWN_DEBOUNCE = 2
/** How many ticks a TRANSIENT send failure is retried before the module gives
 *  up on that one message. Bounded on purpose: an unbounded retry would turn a
 *  permanently unreachable chat into a 5-second hot loop against the Bot API,
 *  which is a worse failure than the silent one it replaces. */
const MAX_SEND_ATTEMPTS = 3

const STATE_PATH = join(STORE_DIR, 'dead-agent-reply-state.json')

/** Bilingual so a non-Hungarian install still gets a legible reply -- same
 *  convention as main-inbox-receipt.ts's RECEIPT_TEXT. First person, since
 *  the message is sent through the dead agent's OWN bot and reads as if it
 *  were speaking for itself. */
export const DEAD_AGENT_REPLY_TEXT: Record<string, (agent: string) => string> = {
  hu: (agent) =>
    `⚠️ Most nem élek (${agent} folyamata nem fut), ezért nem tudok válaszolni. Amint újraindulok, jelentkezem.`,
  en: (agent) =>
    `⚠️ I am not alive right now (${agent}'s process is not running), so I cannot answer. I will check in once I restart.`,
}

export function deadAgentReplyText(lang: string, agentDisplay: string): string {
  const fn = DEAD_AGENT_REPLY_TEXT[lang] ?? DEAD_AGENT_REPLY_TEXT['hu']!
  return fn(agentDisplay)
}

/**
 * Pure per-tick decision for one agent. No I/O: the caller supplies the
 * already-probed facts (is it running, what is pending) and gets back exactly
 * what state to keep and whether to send a reply. Mirrors
 * shouldWakeForTelegramInbox's split (telegram-inbox-wake.ts) so the rule that
 * decides whether Boss hears "I'm not alive" is testable without tmux, a
 * clock or the network.
 */
export function decideDeadAgentReply(params: {
  isRunning: boolean
  downStreak: number
  debounceThreshold: number
  pending: { updateId: number; chatId: number | null } | null
  lastRepliedUpdateId: number | null
}): {
  downStreak: number
  lastRepliedUpdateId: number | null
  reply: { chatId: number; updateId: number } | null
} {
  const { isRunning, debounceThreshold, pending, lastRepliedUpdateId } = params
  if (isRunning) {
    // Alive (again): the debounce streak AND the reply memory both reset, so a
    // future dead spell -- even one that happens to end on the same
    // update_id -- is treated as fresh, not "already answered".
    return { downStreak: 0, lastRepliedUpdateId: null, reply: null }
  }
  const downStreak = params.downStreak + 1
  if (downStreak < debounceThreshold) {
    return { downStreak, lastRepliedUpdateId, reply: null } // blip, not yet confirmed dead
  }
  if (!pending || pending.chatId == null) {
    return { downStreak, lastRepliedUpdateId, reply: null } // dead, but nothing waiting for it
  }
  if (pending.updateId === lastRepliedUpdateId) {
    return { downStreak, lastRepliedUpdateId, reply: null } // already answered this exact message
  }
  return { downStreak, lastRepliedUpdateId: pending.updateId, reply: { chatId: pending.chatId, updateId: pending.updateId } }
}

/**
 * Pure policy for a send that did NOT go through. Kept separate (and exported)
 * for the same reason decideDeadAgentReply is: the rule that decides whether
 * the owner's message is retried or written off must be testable without the
 * network.
 *
 * 'retry'   -- leave the state untouched, so the next tick sends again.
 * 'give-up' -- record the update as handled so we stop hammering, and say out
 *              loud that the reply was NOT delivered. Never call this
 *              "replied": a message the owner did not receive did not happen.
 */
export function decideAfterSendFailure(params: {
  permanent: boolean
  attempts: number
  maxAttempts: number
}): 'retry' | 'give-up' {
  if (params.permanent) return 'give-up'
  return params.attempts >= params.maxAttempts ? 'give-up' : 'retry'
}

// ---- I/O: token + persisted "already replied to" memory -----------------

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

interface PersistedState {
  lastRepliedUpdateId: number | null
}

// In-memory is the authority (mirrors limit-wake-runner.ts); the file is
// best-effort so a dashboard restart does not re-send the same reply. Losing
// the file just risks one duplicate reply, never a stuck watcher.
let persisted: Record<string, PersistedState> = {}
let persistedLoaded = false
// downStreak is pure runtime debounce state: losing it on restart only delays
// the "confirmed dead" verdict by a few more ticks, never a correctness bug,
// so it is not persisted.
const downStreaks: Record<string, number> = {}
// Consecutive failed send attempts for the message currently being answered.
// Runtime-only, like downStreaks: losing it on restart costs at most a few
// extra attempts, never a wrong verdict.
const sendAttempts: Record<string, { updateId: number; attempts: number }> = {}

function loadPersisted(): void {
  if (persistedLoaded) return
  persistedLoaded = true
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    if (raw && typeof raw === 'object') {
      for (const [agent, v] of Object.entries(raw as Record<string, unknown>)) {
        const id = (v as { lastRepliedUpdateId?: unknown } | null)?.lastRepliedUpdateId
        persisted[agent] = { lastRepliedUpdateId: typeof id === 'number' ? id : null }
      }
    }
  } catch {
    // Fresh install or unreadable: start from empty, worst case one extra reply.
  }
}

function writePersisted(): void {
  try {
    atomicWriteFileSync(STATE_PATH, JSON.stringify(persisted, null, 2))
  } catch (err) {
    logger.warn({ err, path: STATE_PATH }, 'dead-agent-reply: could not persist state')
  }
}

/** What actually happened to the sendMessage call.
 *
 *  WHY THIS IS NOT A `void`: the first version of this module awaited fetch and
 *  then recorded the update as answered, without ever looking at the response.
 *  Telegram answers HTTP 200 for success but also 400/403 for "chat not found"
 *  / "bot was blocked" -- and a rejected send used to be indistinguishable from
 *  a delivered one. The owner then got NOTHING, while the log said "replied"
 *  and the state file said "already answered", so it was never retried. This is
 *  the same silent-send trap the repo's own rule forbids for /api/messages
 *  ("egy uzenet CSAK akkor szamit elkuldottnek, ha visszajott egy id"). */
type SendOutcome =
  | { ok: true }
  /** permanent: retrying cannot help (4xx other than 429) -- stop and say so.
   *  transient: network error, 429 or 5xx -- worth another tick. */
  | { ok: false; permanent: boolean; reason: string }

async function sendReply(token: string, chatId: number, text: string): Promise<SendOutcome> {
  let res: Response
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    return { ok: false, permanent: false, reason: `network error: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (res.ok) {
    // HTTP 200 is not yet proof: the Bot API reports its own failures in the
    // body with ok:false. Read it, and never guess -- an unparseable body is
    // reported as exactly that, not as success.
    try {
      const body = await res.json() as { ok?: boolean; description?: string }
      if (body?.ok === true) return { ok: true }
      return { ok: false, permanent: true, reason: `Bot API ok=false: ${body?.description ?? '(no description)'}` }
    } catch (err) {
      return { ok: false, permanent: false, reason: `unreadable response body: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  let description = ''
  try {
    const body = await res.json() as { description?: string }
    description = body?.description ? ` -- ${body.description}` : ''
  } catch { /* body is optional context, never the verdict */ }
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429
  return { ok: false, permanent, reason: `HTTP ${res.status}${description}` }
}

async function checkAgent(name: string): Promise<void> {
  const running = isAgentRunning(name)
  const stateDir = resolveAgentChannelStateDir(name, 'telegram')
  const token = botToken(stateDir)

  const prevLastReplied = persisted[name]?.lastRepliedUpdateId ?? null
  const prevDownStreak = downStreaks[name] ?? 0

  // No token configured for this agent's Telegram channel: nothing to probe,
  // but still track the debounce streak / alive-reset so behaviour is
  // consistent once a token is added later.
  let pending: { updateId: number; chatId: number | null } | null = null
  if (!running && token) {
    try {
      pending = await probeLatestPendingChat(token)
    } catch (err) {
      if (err instanceof TelegramApiError && err.kind === 'conflict') {
        // 409 = something IS actively polling this token -- our liveness read
        // was wrong (reparented poller, stale tmux info). Trust the token: an
        // agent that is genuinely dead never produces a 409 here (nothing is
        // holding its getUpdates slot), so treat this as alive and back off.
        downStreaks[name] = 0
        delete sendAttempts[name]
        if (prevLastReplied !== null) {
          persisted[name] = { lastRepliedUpdateId: null }
          writePersisted()
        }
        return
      }
      logger.warn({ err: err instanceof Error ? err.message : String(err), agent: name }, 'dead-agent-reply: pending-chat probe failed')
      return // do not advance downStreak on a transient probe failure
    }
  }

  const decision = decideDeadAgentReply({
    isRunning: running,
    downStreak: prevDownStreak,
    debounceThreshold: DOWN_DEBOUNCE,
    pending,
    lastRepliedUpdateId: prevLastReplied,
  })
  downStreaks[name] = decision.downStreak

  if (!decision.reply || !token) {
    // Nothing to send. The only state change worth keeping here is the
    // alive-reset (lastRepliedUpdateId -> null), so a later dead spell is
    // treated as fresh.
    if (decision.lastRepliedUpdateId !== prevLastReplied) {
      persisted[name] = { lastRepliedUpdateId: decision.lastRepliedUpdateId }
      writePersisted()
    }
    delete sendAttempts[name]
    return
  }

  const { chatId, updateId } = decision.reply
  const display = readAgentDisplayName(name) || name
  const outcome = await sendReply(token, chatId, deadAgentReplyText(APP_LANG, display))

  if (!outcome.ok) {
    const prior = sendAttempts[name]
    const attempts = prior && prior.updateId === updateId ? prior.attempts + 1 : 1
    sendAttempts[name] = { updateId, attempts }
    const verdict = decideAfterSendFailure({ permanent: outcome.permanent, attempts, maxAttempts: MAX_SEND_ATTEMPTS })
    if (verdict === 'retry') {
      // State deliberately NOT persisted: the next tick must try again.
      logger.warn({ agent: name, chatId, updateId, attempts, reason: outcome.reason },
        'dead-agent-reply: reply NOT delivered, retrying on the next tick')
      return
    }
    // Written off. Persist so this does not become a 5s hot loop, but the log
    // must say plainly that the owner never got it -- an undelivered message is
    // not a reply.
    persisted[name] = { lastRepliedUpdateId: updateId }
    writePersisted()
    delete sendAttempts[name]
    logger.error({ agent: name, chatId, updateId, attempts, permanent: outcome.permanent, reason: outcome.reason },
      'dead-agent-reply: reply could NOT be delivered, giving up on this message')
    return
  }

  // Delivered -- and only now is it true that this update has been answered.
  persisted[name] = { lastRepliedUpdateId: updateId }
  writePersisted()
  delete sendAttempts[name]
  logger.info({ agent: name, chatId, updateId },
    'dead-agent-reply: replied on Boss\'s behalf-triggered message for a dead sub-agent')
}

export async function runDeadAgentReplyTick(): Promise<void> {
  loadPersisted()
  let names: string[]
  try {
    names = listAgentNames()
  } catch (err) {
    logger.warn({ err }, 'dead-agent-reply: listAgentNames failed')
    return
  }
  for (const name of names) {
    // The main agent's channel runs natively (--channels), not via the
    // per-agent MCP tee this module is built around; touching it here would
    // cross the CATASTROPHE GUARD line other modules already respect
    // (telegram-inbox-wake.ts: "the main agent [...] has no local derived
    // inbox to drain").
    if (name === MAIN_AGENT_ID) continue
    try {
      await checkAgent(name)
    } catch (err) {
      logger.warn({ err, agent: name }, 'dead-agent-reply: check failed')
    }
  }
}

let _tickRunning = false

/** Wired from src/web.ts. Default ON: an install that never touches a
 *  setting still gets Boss's answer when he messages a dead agent. */
export function startDeadAgentReplyWatcher(): NodeJS.Timeout | null {
  if (!DEAD_AGENT_REPLY_ENABLED) {
    logger.info('dead-agent-reply: kikapcsolva (DEAD_AGENT_REPLY_ENABLED=0)')
    return null
  }
  const timer = setInterval(() => {
    if (_tickRunning) return
    _tickRunning = true
    void runDeadAgentReplyTick().finally(() => { _tickRunning = false })
  }, TICK_MS)
  timer.unref?.()
  return timer
}

export function stopDeadAgentReplyWatcher(timer: NodeJS.Timeout | null): void {
  if (timer) clearInterval(timer)
}

// Test-only: reset module state between unit tests.
export function _resetDeadAgentReplyStateForTest(): void {
  persisted = {}
  persistedLoaded = false
  for (const k of Object.keys(downStreaks)) delete downStreaks[k]
}
