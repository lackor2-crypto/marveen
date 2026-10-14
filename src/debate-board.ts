// The objection board of a critic / defender debate (#597, phase 2).
//
// A review debate is a list of numbered objections (K1, K2, ...) that the critic raises and the defender answers,
// round after round. The board folds all rounds into ONE line per objection: what was objected to, what the
// defender said last, and where it stands now. Everything here is pure (no I/O, no model) and is computed from
// the rounds each time, so the log stays the only record and the board can never drift from it.

import type { DebateModeDef, DebateRoleId, ObjectionKind, ParsedObjection, ParsedReply, ReplyVerdict } from './debate-modes.js'
import { isRoleMode } from './debate-modes.js'

export interface BoardResponse {
  role?: DebateRoleId
  ok: boolean
  objections?: ParsedObjection[]
  replies?: ParsedReply[]
  noObjections?: boolean
}
export interface BoardRound { round: number; responses: BoardResponse[] }

/**
 * accepted  -- the defender accepted it, nothing is left to argue
 * partial   -- the defender accepted it in part
 * rejected  -- the defender rejected it and the critic has not (yet) given it up
 * withdrawn -- the defender rejected it and the critic let it go in a later round
 * open      -- raised and not answered (yet), or raised again after the last answer
 */
export type BoardStatus = 'open' | 'accepted' | 'partial' | 'rejected' | 'withdrawn'

export interface BoardStep { round: number; verdict: ReplyVerdict | null; reason: string; rewrite: string }

export interface BoardItem {
  id: string
  num: number
  kind: ObjectionKind | null
  quote: string
  text: string
  raisedIn: number
  lastRaisedIn: number
  steps: BoardStep[]
  status: BoardStatus
  /** The newest wording the defender offered while accepting (fully or in part); empty when there is none. */
  rewrite: string
}

export interface BoardSummary { total: number; accepted: number; partial: number; rejected: number; withdrawn: number; open: number }

function numOf(id: string): number {
  const n = Number(/\d+/.exec(id)?.[0])
  return Number.isFinite(n) ? n : 0
}

/** The board after the given rounds. Rounds without a critic (a peer debate) give an empty board. */
export function buildObjectionBoard(rounds: readonly BoardRound[]): BoardItem[] {
  const items = new Map<string, BoardItem>()
  const make = (id: string, round: number): BoardItem => {
    const it: BoardItem = { id, num: numOf(id), kind: null, quote: '', text: '', raisedIn: round, lastRaisedIn: 0, steps: [], status: 'open', rewrite: '' }
    items.set(id, it)
    return it
  }
  let lastRound = 0
  for (const r of [...rounds].sort((a, b) => a.round - b.round)) {
    let seen = false
    for (const x of r.responses) {
      if (!x.ok) continue
      if (x.role === 'critic') {
        seen = true
        for (const o of x.objections ?? []) {
          const it = items.get(o.id) ?? make(o.id, r.round)
          it.lastRaisedIn = r.round
          // The newest statement wins, but a restatement that dropped the quote keeps the one that was given.
          if (o.kind) it.kind = o.kind
          if (o.quote) it.quote = o.quote
          if (o.text) it.text = o.text
        }
      } else if (x.role === 'defender') {
        seen = true
        for (const p of x.replies ?? []) {
          const it = items.get(p.id) ?? make(p.id, r.round)
          it.steps.push({ round: r.round, verdict: p.verdict, reason: p.reason, rewrite: p.rewrite })
        }
      }
    }
    if (seen) lastRound = r.round
  }
  for (const it of items.values()) {
    const last = it.steps[it.steps.length - 1]
    it.rewrite = [...it.steps].reverse().find(s => (s.verdict === 'accept' || s.verdict === 'partial') && s.rewrite)?.rewrite ?? ''
    if (!last || last.verdict === null || it.lastRaisedIn > last.round) { it.status = 'open'; continue }
    // The critic did not restate it after the answer: it let the objection go.
    const letGo = lastRound > last.round
    it.status = last.verdict === 'accept' ? 'accepted' : last.verdict === 'partial' ? 'partial' : letGo ? 'withdrawn' : 'rejected'
  }
  return [...items.values()].sort((a, b) => a.num - b.num || a.id.localeCompare(b.id))
}

export function summarizeBoard(items: readonly BoardItem[]): BoardSummary {
  const s: BoardSummary = { total: items.length, accepted: 0, partial: 0, rejected: 0, withdrawn: 0, open: 0 }
  for (const it of items) s[it.status]++
  return s
}

/** The highest objection number used in any round, so the critic can number new ones after it. */
export function maxObjectionNumber(rounds: readonly BoardRound[]): number {
  let max = 0
  for (const r of rounds) for (const x of r.responses) {
    for (const o of x.objections ?? []) max = Math.max(max, numOf(o.id))
    for (const p of x.replies ?? []) max = Math.max(max, numOf(p.id))
  }
  return max
}

// ---------------------------------------------------------------------------
// Adaptive stop
// ---------------------------------------------------------------------------

export type StopReason = 'no_objections' | 'all_settled' | 'stalled' | 'round_limit'

export interface StopAdvice { stop: boolean; reason?: StopReason }

/** The most rounds this debate may still have; null = no limit. */
export function roundsLeft(mode: DebateModeDef, played: number): number | null {
  return mode.maxRounds ? Math.max(0, mode.maxRounds - played) : null
}

/**
 * Whether another round is worth it. It is ADVICE: the owner can always go on (except past the mode's round limit,
 * which the runner enforces). The three signs, in this order:
 *   no_objections -- the critic found nothing, so there is nothing to answer
 *   all_settled   -- everything the critic raised this round, the defender accepted
 *   stalled       -- the same objections came back with the same answers: another round would repeat itself
 *   round_limit   -- the mode's round limit is reached
 */
export function stopAdvice(mode: DebateModeDef, rounds: readonly BoardRound[]): StopAdvice {
  if (!isRoleMode(mode) || !rounds.length) return { stop: false }
  const sorted = [...rounds].sort((a, b) => a.round - b.round)
  const last = sorted[sorted.length - 1]
  const critic = last.responses.find(x => x.ok && x.role === 'critic')
  if (critic?.noObjections) return { stop: true, reason: 'no_objections' }

  const board = buildObjectionBoard(sorted)
  const live = board.filter(i => i.lastRaisedIn === last.round)
  if (live.length && live.every(i => i.status === 'accepted')) return { stop: true, reason: 'all_settled' }

  if (sorted.length >= 2 && live.length) {
    const prev = sorted[sorted.length - 2]
    const verdictAt = (i: BoardItem, round: number): ReplyVerdict | null | undefined => i.steps.find(s => s.round === round)?.verdict
    const same = live.every(i => {
      const before = verdictAt(i, prev.round)
      const now = verdictAt(i, last.round)
      return i.raisedIn <= prev.round && before !== undefined && before !== null && before === now
    })
    if (same) return { stop: true, reason: 'stalled' }
  }
  if (roundsLeft(mode, sorted.length) === 0) return { stop: true, reason: 'round_limit' }
  return { stop: false }
}

// ---------------------------------------------------------------------------
// For the closing write-up
// ---------------------------------------------------------------------------

const FIELD_MAX = 1200

function clip(s: string): string {
  const t = s.trim()
  return t.length > FIELD_MAX ? `${t.slice(0, FIELD_MAX)} ...` : t
}

/** The board as plain text for the closing prompt: the closer works from this table, not from memory of the last round. */
export function boardForPrompt(items: readonly BoardItem[]): string {
  if (!items.length) return ''
  return items.map(it => {
    const last = it.steps[it.steps.length - 1]
    return [
      `${it.id}${it.kind ? ` [${it.kind}]` : ''} -- status: ${it.status}`,
      it.quote ? `Quote: "${clip(it.quote)}"` : '',
      it.text ? `Objection: ${clip(it.text)}` : '',
      last ? `Defender (round ${last.round}): ${last.verdict ? last.verdict.toUpperCase() : 'unclear'}${last.reason ? ` -- ${clip(last.reason)}` : ''}` : 'Defender: no answer',
      it.rewrite ? `Offered wording: ${clip(it.rewrite)}` : '',
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}
