// I/O half of the open-card nudge (kanban #461, phase 2b): reads the board and
// the agents' real state, asks src/card-work-nudge.ts who is due, and puts the
// reminder in that agent's inbox. State lives in store/card-nudge-state.json so
// a dashboard restart cannot replay reminders.
//
// Fail-closed on purpose (unlike the availability watcher): a reminder is a
// paid turn, so anything unreadable means "no reminder this tick".
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, STORE_DIR } from '../config.js'
import { createAgentMessage, getPendingMessages, listKanbanCards } from '../db.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { listAgentNames } from './agent-config.js'
import { assigneeMatchesAgent } from './pending-work.js'
import { codeBridgeProjectOf } from '../approval-verification-dispatch.js'
import { probeAgentActivity } from './verification-sweep-job.js'
import { currentAvailability } from './agent-availability-watch.js'
import { cardNudgeMessage, planCardNudges, type CardNudgeState, type NudgeCard } from '../card-work-nudge.js'

export const CARD_NUDGE_INTERVAL_MS = 60_000
export const CARD_NUDGE_INITIAL_DELAY_MS = 90_000
const HOUR_MS = 3_600_000

const STATE_PATH = join(STORE_DIR, 'card-nudge-state.json')
const LOG_PATH = join(STORE_DIR, 'card-nudge.log')

interface StoredState { cards: CardNudgeState; sent: Record<string, number[]> }

function readStored(): StoredState {
  try {
    if (!existsSync(STATE_PATH)) return { cards: {}, sent: {} }
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    return { cards: raw?.cards && typeof raw.cards === 'object' ? raw.cards : {}, sent: raw?.sent && typeof raw.sent === 'object' ? raw.sent : {} }
  } catch {
    return { cards: {}, sent: {} }
  }
}

/** Open cards an agent owns. Cards assigned to anyone who is not an agent (the owner) are skipped. */
export function collectNudgeCards(): NudgeCard[] {
  const all = listKanbanCards().filter((c) => !c.archived_at)
  const names = [MAIN_AGENT_ID, ...listAgentNames()]
  const openParents = new Set(all.filter((c) => c.parent_id && c.status !== 'done').map((c) => c.parent_id as string))
  const out: NudgeCard[] = []
  for (const c of all) {
    if (c.status !== 'in_progress' && c.status !== 'testing') continue
    const agent = names.find((n) => assigneeMatchesAgent(c.assignee, n))
    if (!agent || codeBridgeProjectOf(agent) !== null) continue
    out.push({ seq: c.seq ?? 0, id: c.id, title: c.title, updatedAt: c.updated_at, agent, hasOpenChildren: openParents.has(c.id) })
  }
  return out
}

let inFlight = false

export async function cardNudgeTick(now: number = Date.now()): Promise<number> {
  if (inFlight) return 0
  inFlight = true
  try {
    const stored = readStored()
    const available = new Map(currentAvailability(now).map((a) => [a.agent, a.available]))
    const sentThisHour: Record<string, number> = {}
    for (const agent of Object.keys(stored.sent)) {
      stored.sent[agent] = (stored.sent[agent] ?? []).filter((t) => now - t < HOUR_MS)
      sentThisHour[agent] = stored.sent[agent]!.length
    }
    const { nudges, state } = await planCardNudges(collectNudgeCards(), stored.cards, {
      now,
      canWork: (agent) => available.get(agent) === true,
      activity: probeAgentActivity,
      hasUndelivered: (agent) => {
        try { return getPendingMessages(agent).length > 0 } catch { return true }
      },
    }, sentThisHour)
    let sent = 0
    for (const n of nudges) {
      try {
        createAgentMessage('system', n.agent, cardNudgeMessage(n), 'card-nudge')
        stored.sent[n.agent] = [...(stored.sent[n.agent] ?? []), now]
        sent++
        try { appendFileSync(LOG_PATH, `${new Date(now).toISOString()} ${n.agent} ${n.nth}. ${n.cards.map((c) => '#' + c.seq).join(',')}\n`) } catch { /* trace only */ }
        logger.info({ cardNudge: true, agent: n.agent, cards: n.cards.map((c) => c.seq), nth: n.nth }, 'open-card nudge sent')
      } catch (err) {
        logger.warn({ err, agent: n.agent }, 'open-card nudge could not be queued')
        for (const c of n.cards) delete state[c.id]
      }
    }
    atomicWriteFileSync(STATE_PATH, JSON.stringify({ cards: state, sent: stored.sent }, null, 2))
    return sent
  } catch (err) {
    logger.warn({ err }, 'open-card nudge: tick error')
    return 0
  } finally {
    inFlight = false
  }
}

export function startCardNudge(): NodeJS.Timeout | undefined {
  if (process.env.MARVEEN_CARD_NUDGE === '0') return undefined
  setTimeout(() => { void cardNudgeTick() }, CARD_NUDGE_INITIAL_DELAY_MS).unref()
  return setInterval(() => { void cardNudgeTick() }, CARD_NUDGE_INTERVAL_MS)
}
