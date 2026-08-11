/**
 * Enforcement test for the similar-card sweep at close time (Boss, 2026-08-11).
 *
 * The rule "when a card is done, check the board for cards the same work
 * covers" had lived in the kanban-approval-workflow skill since 2026-08-05 --
 * and was still skipped often enough that Boss was handed five cards to do, of
 * which three were long finished and never submitted. His instruction was to
 * stop relying on remembering: "kenyszeritsd ki hogy vegye eszre".
 *
 * So the server refuses the close instead. These tests pin that refusal, and
 * equally pin the escape hatches -- an enforcement nobody can satisfy just gets
 * worked around.
 */

import { describe, it, expect } from 'vitest'
import { findSimilarCards, similarCardsBeforeClose } from '../kanban-related.js'

type Card = { id: string; seq: number | null; title: string; status: string }

const board: Card[] = [
  { id: 'aa55180c', seq: 14, title: 'Fajlbongeszo/projekt-panel a dashboardon (Windows Intezo-szeru)', status: 'in_progress' },
  { id: 'fc904177', seq: 97, title: 'Teljes Windows-beallitas mentes/visszaallitas (asztali ikonok, mappanezetek)', status: 'waiting' },
  { id: '45c3cfad', seq: 72, title: 'Kozos, fiok-szintu rate-limiter az ingyenes OpenRouter agenteknek', status: 'waiting' },
  { id: '3b8bb1c5', seq: 92, title: 'Token-naplo alulmeri az OpenRouter hasznalatot', status: 'waiting' },
]

describe('similar-card sweep before closing a card', () => {
  it('finds the neighbouring card that shares a subject', () => {
    const self = board[1] // the Windows settings card
    const others = board.filter(c => c.id !== self.id)
    const similar = findSimilarCards(self.title, others)
    // The Windows file-browser card shares enough of the subject to be worth a
    // look before declaring the settings work finished -- which is exactly the
    // hit the live endpoint produced when this was wired up.
    expect(similar.map(c => c.id)).toContain('aa55180c')
  })

  it('does not flag cards about a different subject', () => {
    const self = board[2] // rate limiter
    const others = [board[0]] // file browser
    expect(findSimilarCards(self.title, others)).toEqual([])
  })

  it('an empty board produces no obligation', () => {
    expect(findSimilarCards(board[0].title, [])).toEqual([])
  })

  it('a card with an unmatchable title does not block on everything', () => {
    // Guards against the enforcement becoming noise: a title with no usable
    // tokens must not suddenly "resemble" every open card, or the rule gets
    // routed around with similar_reviewed: [] every time.
    expect(findSimilarCards('', board)).toEqual([])
  })
})

describe('similarCardsBeforeClose -- the decision the approval endpoint makes', () => {
  it('blocks the close while the neighbours are unreviewed', () => {
    const blocking = similarCardsBeforeClose('fc904177', board, undefined)
    expect(blocking.map(c => c.id)).toEqual(['aa55180c'])
  })

  it('accepts #seq as the card reference, not only the hex id', () => {
    // Boss refers to cards both ways on the board, and the dashboard linkifies
    // both. A reference style the check silently ignores is a hole in it.
    expect(similarCardsBeforeClose('#97', board, undefined).map(c => c.id)).toEqual(['aa55180c'])
  })

  it('lets the close through once the caller lists what it reviewed', () => {
    expect(similarCardsBeforeClose('fc904177', board, ['aa55180c'])).toEqual([])
  })

  it('accepts an empty similar_reviewed as a real answer', () => {
    // "I looked, none of them relate" has to be sayable. Without this the
    // enforcement is unsatisfiable for genuinely unrelated work, and an
    // unsatisfiable rule gets worked around rather than followed.
    expect(similarCardsBeforeClose('fc904177', board, [])).toEqual([])
  })

  it('does not block when the approval names no card at all', () => {
    expect(similarCardsBeforeClose(null, board, undefined)).toEqual([])
  })

  it('does not block on a card id that is not on the board', () => {
    expect(similarCardsBeforeClose('deadbeef', board, undefined)).toEqual([])
  })

  it('never reports the card itself as its own neighbour', () => {
    const blocking = similarCardsBeforeClose('fc904177', board, undefined)
    expect(blocking.map(c => c.id)).not.toContain('fc904177')
  })

  it('ignores a done card that the work already covers', () => {
    // Only OPEN cards are worth stopping for; a finished one needs nothing.
    const withDone = board.map(c => (c.id === 'aa55180c' ? { ...c, status: 'done' } : c))
    expect(similarCardsBeforeClose('fc904177', withDone, undefined)).toEqual([])
  })
})
