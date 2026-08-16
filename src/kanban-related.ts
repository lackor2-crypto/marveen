// Server-side enforcement of the "link the related card" rule.
//
// Boss, 2026-08-10, after being asked to trust a written rule: "Marvin, ha
// visszajon, nehogy o is azt csinalja, hogy ezeket nem vegzi el, mert akkor egy
// felesleges funkciot tettunk be, amit nem hasznalunk. Tehat csinald az AI-oknak
// hulye biztosra, hogy ezt biztosan hasznaljak, de szazszazalekosan."
//
// He is right, and there is precedent in this very endpoint: the label rule was
// documented for weeks and still broken repeatedly, until POST /api/kanban began
// rejecting a card without labels. Documentation is a reminder; a 400 is a
// guarantee. So the same shape is used here -- when a new card looks related to
// existing ones, the request is refused until the caller either links them or
// says outright that nothing relates.
//
// What the server cannot do is DECIDE the relationship; only the caller knows
// that. What it can do is refuse to let the question go unasked, list the
// candidates, and -- once an answer comes back -- write BOTH directions itself,
// so the reverse link cannot be forgotten. That last part matters most: the
// failure this rule exists for was a one-directional reference.

export interface RelatedCandidate {
  id: string
  seq: number | null
  title: string
  status: string
}

// Words too common in this board's titles to imply a relationship on their own.
// Without this, "javitas" or "dashboard" would tie half the board together and
// the check would be noise the caller learns to bypass.
const STOPWORDS = new Set([
  'javitas', 'javítás', 'hiba', 'fix', 'feature', 'dashboard', 'marveen', 'marvin',
  'kartya', 'kártya', 'oldal', 'gomb', 'mezo', 'mező', 'rendszer', 'uj', 'új',
  'nem', 'meg', 'meg-', 'egy', 'ami', 'hogy', 'ezt', 'azt', 'kell', 'lehet',
  'and', 'the', 'for', 'with', 'from',
])

/**
 * A token counts as noise if it IS a stopword or is a suffixed form of one.
 * Hungarian agglutinates, so exact matching lets "dashboardon" through while
 * "dashboard" is filtered -- the same word, one of them scoring matches. The
 * length guard keeps it to inflection: "dashboardon" is a suffixed
 * "dashboard", but "kartyakezelo" is a compound and stays significant.
 */
function isNoise(word: string): boolean {
  if (STOPWORDS.has(word)) return true
  for (const stop of STOPWORDS) {
    if (stop.length >= 5 && word.startsWith(stop) && word.length - stop.length <= 3) return true
  }
  return false
}

/** Significant words of a title, accent-folded and lowercased. */
export function titleTokens(title: string): string[] {
  return (title || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !isNoise(w))
}

/**
 * Existing cards that share enough distinctive vocabulary with `title` to be
 * worth asking about. Deliberately narrow: two shared significant words, or one
 * long distinctive one. A check that fires on everything gets bypassed.
 */
export function findSimilarCards<T extends RelatedCandidate>(title: string, cards: T[]): T[] {
  const tokens = new Set(titleTokens(title))
  if (tokens.size === 0) return []
  const scored: Array<{ card: T; score: number }> = []
  for (const card of cards) {
    const other = titleTokens(card.title)
    let shared = 0
    let longShared = false
    for (const w of other) {
      if (!tokens.has(w)) continue
      shared++
      if (w.length >= 7) longShared = true
    }
    if (shared >= 2 || longShared) scored.push({ card, score: shared * 10 + (longShared ? 5 : 0) })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 8).map(x => x.card)
}

/**
 * Card references already present in a piece of text: 8-hex ids, and #seq board
 * numbers that actually belong to a card. Mirrors what the dashboard linkifies,
 * so "already linked" means the same thing on both sides.
 */
export function referencedCardIds(text: string, cards: RelatedCandidate[]): string[] {
  if (!text) return []
  const byId = new Set(cards.map(c => c.id.toLowerCase()))
  const bySeq = new Map(cards.filter(c => c.seq != null).map(c => [c.seq as number, c.id]))
  const out = new Set<string>()
  for (const m of text.matchAll(/\b([0-9a-f]{8})\b|#(\d{1,4})\b/gi)) {
    if (m[2] !== undefined) {
      const id = bySeq.get(Number(m[2]))
      if (id) out.add(id)
      continue
    }
    const id = (m[1] || '').toLowerCase()
    if (byId.has(id)) out.add(id)
  }
  return [...out]
}

/**
 * The card an approval is about: the structured payload first, then an 8-hex id
 * in the description text.
 *
 * Shared rather than duplicated because two routes now need the same answer --
 * the approval endpoint, and the card-move endpoint that has to find out
 * whether a waiting card already has an approval on it. Two copies of this
 * would drift, and the failure mode of drift here is silent: a card looks
 * unsubmitted to one side and submitted to the other.
 */
export function approvalCardId(actionPayload: unknown, actionDescription: string): string | null {
  if (typeof actionPayload === 'string') {
    try {
      const parsed = JSON.parse(actionPayload) as { kanban_card_id?: unknown }
      if (typeof parsed?.kanban_card_id === 'string' && parsed.kanban_card_id) return parsed.kanban_card_id
    } catch { /* fall through to the text scrape */ }
  }
  const m = (actionDescription || '').match(/\b[0-9a-f]{8}\b/i)
  return m ? m[0] : null
}

/**
 * The same "look at the neighbours" question the create path asks, asked again
 * at the moment a card is declared finished.
 *
 * Boss, 2026-08-11: he was handed five cards as work, and three of them had
 * been finished long before and simply never moved or submitted. The rule to
 * check had been written in the kanban-approval-workflow skill since
 * 2026-08-05 and was still skipped, so it moved here where it is enforced
 * rather than remembered: "kenyszeritsd ki hogy vegye eszre".
 *
 * Lives here, next to findSimilarCards, rather than inline in the route, so the
 * decision is testable on its own -- including the way OUT of it. An
 * enforcement whose escape hatch is untested is one nobody can satisfy, and
 * that is the kind that gets routed around instead of followed.
 *
 * @param cardId       card the approval is about; an 8-hex id or a `#seq`
 * @param cards        the whole open board (done/archived cards are ignored)
 * @param alreadyReviewed  the caller's answer; any array (even empty) means
 *                     the question was asked and answered, so nothing blocks
 * @returns the open cards that must be looked at first, or [] if none do
 */
export function similarCardsBeforeClose<T extends RelatedCandidate>(
  cardId: string | null,
  cards: T[],
  alreadyReviewed: unknown,
): T[] {
  // Any array is an answer -- including []. The caller has seen the list.
  if (Array.isArray(alreadyReviewed)) return []
  if (!cardId) return []
  // referencedCardIds resolves both spellings Boss uses on the board (the
  // 8-hex id and the #seq board number), so `#97` is not a silent miss.
  const [resolved] = referencedCardIds(cardId, cards)
  const self = cards.find(c => c.id === (resolved ?? cardId))
  if (!self) return []
  const open = cards.filter(c => c.status !== 'done' && c.id !== self.id)
  return findSimilarCards(self.title, open)
}

/** The line appended to a description to record a cross-link. */
export function crossLinkLine(cards: RelatedCandidate[]): string {
  if (cards.length === 0) return ''
  const refs = cards.map(c => (c.seq != null ? `${c.id} (#${c.seq})` : c.id)).join(', ')
  return `Kapcsolodo kartya: ${refs}.`
}

/**
 * Boss's rule, 2026-08-16: "a varakozoban levo elemek szamanak meg kell
 * egyeznie pontosan mint a jovahagyasban levo varakozo statusz szamaval."
 *
 * A `waiting` card MEANS "the work is finished, somebody has to decide". If no
 * pending approval belongs to it, nobody is being asked and the card sits in
 * silence -- which is exactly what he found on the live board: 11 waiting cards
 * and 5 pending approvals, of which only 4 actually paired up.
 *
 * The pairing MUST use approvalCardId, not the raw action_payload: approvals
 * raised by hand carry the card id only in the description text, and a check
 * built on the payload alone reports them as orphans. That false alarm was made
 * once already while measuring this very imbalance, and a guard that cries wolf
 * is a guard people learn to ignore.
 *
 * Pure on purpose: the same function answers for the live board (the audit
 * sweep) and for the test suite, so the rule cannot pass in one and fail in the
 * other. It only REPORTS -- deciding whether a waiting card is genuinely
 * finished needs judgement about the code behind it, which neither a cron job
 * nor a test has.
 */
export interface BalanceCard {
  id: string
  seq?: number | null
  title?: string
  status: string
}

export interface BalanceApproval {
  id: string
  status?: string
  action_payload?: unknown
  action_description?: string
}

/** Why a pending approval has no waiting card behind it. */
export type UnpairedApprovalReason = 'no-card' | 'unknown-card' | 'card-not-waiting'

export interface WaitingApprovalBalance {
  waitingCount: number
  pendingCount: number
  balanced: boolean
  /** Waiting cards nobody is being asked about. */
  waitingWithoutApproval: BalanceCard[]
  /** Pending approvals whose card is missing, unknown, or no longer waiting. */
  pendingWithoutWaitingCard: Array<{
    approval: BalanceApproval
    cardId: string | null
    reason: UnpairedApprovalReason
    cardStatus?: string
  }>
}

/** The same prefix-tolerant match the server uses (ids appear truncated to 8 hex). */
function sameCard(cardId: string, approvalRef: string): boolean {
  return cardId === approvalRef || cardId.startsWith(approvalRef) || approvalRef.startsWith(cardId)
}

export function waitingApprovalBalance(
  cards: BalanceCard[],
  approvals: BalanceApproval[],
): WaitingApprovalBalance {
  const pending = approvals.filter(a => (a.status ?? 'pending') === 'pending')
  const waiting = cards.filter(c => c.status === 'waiting')

  const refs = pending.map(a => ({
    approval: a,
    cardId: approvalCardId(a.action_payload, a.action_description || ''),
  }))

  const waitingWithoutApproval = waiting.filter(
    c => !refs.some(r => r.cardId != null && sameCard(c.id, r.cardId)),
  )

  // A visszateresi tipust KI KELL irni: a harom ag harom kulonbozo alakot ad, es
  // a flatMap ilyenkor az ELSO agbol vezeti le a tipust (cardId: null), amitol a
  // masik ketto -- ahol a cardId string -- forditasi hibat okoz.
  type Parositatlan = WaitingApprovalBalance['pendingWithoutWaitingCard'][number]
  const pendingWithoutWaitingCard = refs.flatMap((r): Parositatlan[] => {
    if (r.cardId == null) return [{ approval: r.approval, cardId: null, reason: 'no-card' as const }]
    const card = cards.find(c => sameCard(c.id, r.cardId!))
    if (!card) return [{ approval: r.approval, cardId: r.cardId, reason: 'unknown-card' as const }]
    if (card.status === 'waiting') return []
    return [{ approval: r.approval, cardId: r.cardId, reason: 'card-not-waiting' as const, cardStatus: card.status }]
  })

  return {
    waitingCount: waiting.length,
    pendingCount: pending.length,
    balanced: waitingWithoutApproval.length === 0 && pendingWithoutWaitingCard.length === 0,
    waitingWithoutApproval,
    pendingWithoutWaitingCard,
  }
}

/** Append a cross-link line without duplicating one that is already there. */
export function withCrossLink(description: string, cards: RelatedCandidate[]): string {
  const line = crossLinkLine(cards)
  if (!line) return description
  const base = (description || '').trimEnd()
  const missing = cards.filter(c => referencedCardIds(base, [c]).length === 0)
  if (missing.length === 0) return description
  return `${base}${base ? '\n\n' : ''}${crossLinkLine(missing)}`
}
