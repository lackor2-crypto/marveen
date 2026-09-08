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

async function sendReply(token: string, chatId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    logger.warn({ err }, 'dead-agent-reply: sendMessage failed')
  }
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
  if (decision.lastRepliedUpdateId !== prevLastReplied) {
    persisted[name] = { lastRepliedUpdateId: decision.lastRepliedUpdateId }
    writePersisted()
  }
  if (!decision.reply || !token) return

  const display = readAgentDisplayName(name) || name
  await sendReply(token, decision.reply.chatId, deadAgentReplyText(APP_LANG, display))
  logger.info({ agent: name, chatId: decision.reply.chatId, updateId: decision.reply.updateId },
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
