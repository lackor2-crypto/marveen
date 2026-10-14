// What the debates so far have brought (#597, phase 6): per mode and model pair, how many objections were raised and
// how many the defender accepted, how often the two came to agreement, and what it cost in tokens.
//
// Pure: it works on the sessions debate-run.ts rebuilt from the log (`loadAllDebateSessions`), so it can never
// disagree with the debate pages. A pair that has been used only once or twice is flagged (`enoughData` false):
// a percentage over two debates is an anecdote, and the page says so instead of ranking it.

import type { DebateSessionState } from './debate-run.js'

/** Fewer debates than this and the row is shown, but marked as too little data to compare. */
export const MIN_DEBATES_FOR_COMPARISON = 3

export interface AnalysisRow {
  mode: string
  /** The name of an owner-made mode; null for a built-in one (the page names those). */
  modeName: string | null
  /**
   * A critic / defender mode: `first` is the critic, `second` the defender. A three-sided mode: `first` and `second` are the
   * two critics, `third` the defender. In a peer mode the pair is in alphabetical order.
   */
  roleMode: boolean
  first: string
  second: string
  /** The third model of a three-sided debate; empty otherwise. */
  third: string
  debates: number
  concluded: number
  /** Closed debates that ended in agreement. */
  agreed: number
  rounds: number
  /** Role modes: all objections raised, and how they stand now. `accepted` counts the partly accepted ones too. */
  objections: number
  accepted: number
  /** Three-sided debates: how many of the objections came first from the second critic (the proof it adds something). */
  fromSecond: number
  rejected: number
  withdrawn: number
  open: number
  /** accepted / objections, 0..1; null when no objection was raised. */
  acceptRate: number | null
  tokensIn: number
  tokensOut: number
  enoughData: boolean
}

export interface Analysis {
  rows: AnalysisRow[]
  totals: { debates: number; concluded: number; objections: number; accepted: number; tokensIn: number; tokensOut: number }
}

function isRoleSession(s: DebateSessionState): boolean {
  return s.rounds.some(r => r.responses.some(x => !!x.role))
}

/** `project`: a project id keeps that project's debates, 'none' the ones without a project, null/undefined all of them. */
export function analyzeDebates(sessions: readonly DebateSessionState[], project?: string | null): Analysis {
  const rows = new Map<string, AnalysisRow>()
  for (const s of sessions) {
    if (project === 'none' ? s.project : project ? s.project !== project : false) continue
    const roleMode = isRoleSession(s)
    const pair = roleMode ? s.models.slice(0, 3) : [...s.models].sort()
    const key = `${s.mode}\u0000${pair.join('\u0000')}`
    let row = rows.get(key)
    if (!row) {
      row = {
        mode: s.mode, modeName: s.modeName, roleMode, first: pair[0] ?? '', second: pair[1] ?? '', third: pair[2] ?? '',
        debates: 0, concluded: 0, agreed: 0, rounds: 0, objections: 0, accepted: 0, fromSecond: 0, rejected: 0, withdrawn: 0, open: 0,
        acceptRate: null, tokensIn: 0, tokensOut: 0, enoughData: false,
      }
      rows.set(key, row)
    }
    row.debates++
    if (s.concluded) { row.concluded++; if (s.consensus) row.agreed++ }
    row.rounds += s.rounds.length
    const sum = s.boardSummary
    if (sum) {
      row.objections += sum.total
      row.accepted += sum.accepted + sum.partial
      row.fromSecond += s.board.filter(i => i.by === 'critic2').length
      row.rejected += sum.rejected
      row.withdrawn += sum.withdrawn
      row.open += sum.open
    }
    for (const r of s.rounds) for (const x of r.responses) {
      row.tokensIn += x.tokensIn ?? 0
      row.tokensOut += x.tokensOut ?? 0
    }
  }
  const list = [...rows.values()]
  for (const r of list) {
    r.acceptRate = r.objections > 0 ? r.accepted / r.objections : null
    r.enoughData = r.debates >= MIN_DEBATES_FOR_COMPARISON
  }
  list.sort((a, b) => b.accepted - a.accepted || b.debates - a.debates || a.mode.localeCompare(b.mode) || a.first.localeCompare(b.first))
  const totals = list.reduce((t, r) => ({
    debates: t.debates + r.debates, concluded: t.concluded + r.concluded, objections: t.objections + r.objections,
    accepted: t.accepted + r.accepted, tokensIn: t.tokensIn + r.tokensIn, tokensOut: t.tokensOut + r.tokensOut,
  }), { debates: 0, concluded: 0, objections: 0, accepted: 0, tokensIn: 0, tokensOut: 0 })
  return { rows: list, totals }
}
