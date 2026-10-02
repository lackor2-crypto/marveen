// Pure decisions for the open-card nudge (kanban #461, phase 2b).
//
// Boss, 2026-10-02: "amig a munka nincs kesz, a dashboard folyamatosan adja ki,
// hogy folytasd a munkat... mindenhol, nem csak a munkapadnal, hanem a tobbi
// agentnel is. Kiveve ha mar nem tud dolgozni az agent, mert nincs tokenje."
//
// The approval-verification sweep already does this for verify tasks. This is
// the same idea for ANY kanban card an agent owns: an agent that is idle, can
// work (the availability watcher says so) and still holds an open card (in
// progress / testing) gets told to carry on, with growing gaps and a hard cap,
// so a card that cannot move never turns into an endless stream of paid turns.
//
// No I/O: the agent facts and the clock are passed in.

export interface NudgeCard {
  seq: number
  id: string
  title: string
  /** Epoch seconds of the card's last change (a comment or a move touches it). */
  updatedAt: number
  /** The agent id the card is assigned to, already resolved by the caller. */
  agent: string
  /** True while at least one sub-card is not done: the children are the work. */
  hasOpenChildren: boolean
}

export interface CardNudgeEntry {
  /** Reminders sent since the card last changed. */
  count: number
  /** Epoch ms of the last reminder. */
  lastAt: number
  /** The card's updatedAt (s) when the count started; a change resets the count. */
  cardUpdatedAt: number
}

export type CardNudgeState = Record<string, CardNudgeEntry>

/** Quiet time on the card before the first reminder. */
export const CARD_NUDGE_FIRST_MS = 10 * 60_000
/** Gap before reminder n+1, indexed by the number already sent; the last value repeats. */
export const CARD_NUDGE_BACKOFF_MS: readonly number[] = [10 * 60_000, 20 * 60_000, 40 * 60_000, 60 * 60_000]
/** After this many reminders without the card changing, stop: it cannot move. */
export const CARD_NUDGE_MAX = 6
/** Hard ceiling per agent, whatever the cards: a message storm costs real money. */
export const CARD_NUDGE_AGENT_PER_HOUR = 3

export type AgentWork = 'idle' | 'busy' | 'unknown'

export interface CardNudgeFacts {
  now: number
  /** Can this agent work now (running, not at its quota wall)? */
  canWork(agent: string): boolean
  /** Is it idle at this moment? Probed lazily, once per agent. */
  activity(agent: string): Promise<AgentWork>
  /** An undelivered message already waits for the agent: the router delivers it. */
  hasUndelivered(agent: string): boolean
}

export interface CardNudge {
  agent: string
  cards: NudgeCard[]
  /** Highest reminder number among the cards (for the text). */
  nth: number
}

export interface CardNudgeResult {
  nudges: CardNudge[]
  state: CardNudgeState
}

/** Whether this card is due a reminder, on the clock and the stored count alone. */
export function cardDue(card: NudgeCard, entry: CardNudgeEntry | undefined, nowMs: number): boolean {
  if (card.hasOpenChildren) return false
  const quietMs = nowMs - card.updatedAt * 1000
  if (!entry || entry.cardUpdatedAt !== card.updatedAt) return quietMs >= CARD_NUDGE_FIRST_MS
  if (entry.count >= CARD_NUDGE_MAX) return false
  const gap = CARD_NUDGE_BACKOFF_MS[Math.min(entry.count, CARD_NUDGE_BACKOFF_MS.length - 1)]!
  return nowMs - entry.lastAt >= gap
}

/** Drop state for cards that are no longer open (moved on, done, gone). */
export function pruneState(state: CardNudgeState, openIds: Set<string>): CardNudgeState {
  const out: CardNudgeState = {}
  for (const id of Object.keys(state)) if (openIds.has(id)) out[id] = state[id]!
  return out
}

/** One pass. Cheap checks first; the pane is only read for an agent that has a due card. */
export async function planCardNudges(
  cards: NudgeCard[],
  prev: CardNudgeState,
  facts: CardNudgeFacts,
  sentThisHour: Record<string, number> = {},
): Promise<CardNudgeResult> {
  const state = pruneState(prev, new Set(cards.map((c) => c.id)))
  const byAgent = new Map<string, NudgeCard[]>()
  for (const c of cards) {
    if (!cardDue(c, state[c.id], facts.now)) continue
    const list = byAgent.get(c.agent) ?? []
    list.push(c)
    byAgent.set(c.agent, list)
  }
  const nudges: CardNudge[] = []
  for (const [agent, due] of byAgent) {
    if ((sentThisHour[agent] ?? 0) >= CARD_NUDGE_AGENT_PER_HOUR) continue
    if (!facts.canWork(agent)) continue
    if (facts.hasUndelivered(agent)) continue
    if ((await facts.activity(agent)) !== 'idle') continue
    let nth = 1
    for (const c of due) {
      const e = state[c.id]
      const count = e && e.cardUpdatedAt === c.updatedAt ? e.count + 1 : 1
      state[c.id] = { count, lastAt: facts.now, cardUpdatedAt: c.updatedAt }
      if (count > nth) nth = count
    }
    nudges.push({ agent, cards: due, nth })
  }
  return { nudges, state }
}

/** The message the idle agent receives. ASCII like the other generated agent texts. */
export function cardNudgeMessage(n: CardNudge): string {
  const lines = n.cards.map((c) => `- #${c.seq} ${c.title}`)
  return [
    `[FOLYTASD A MUNKAT] ${n.agent}: nyitott kartyad van, es most tetlen vagy (${n.nth}. emlekezteto, legfeljebb ${CARD_NUDGE_MAX}).`,
    ...lines,
    'Folytasd, amig kesz. Ha MAR kesz (landolt, tesztelt), tedd waiting-be (a done-t Boss teszi). Ha nem tudsz tovabbmenni, ird a kartyara, miert.',
  ].join('\n')
}
