import { describe, it, expect } from 'vitest'
import {
  titleTokens,
  findSimilarCards,
  referencedCardIds,
  crossLinkLine,
  withCrossLink,
  type RelatedCandidate,
} from '../kanban-related.js'

// The rule this enforces: a card that belongs with an existing one must say so,
// in BOTH descriptions. Written guidance was not enough -- the same mistake was
// made five minutes after the linker shipped -- so the creation endpoint refuses
// until the question is answered (Boss: "csinald az AI-oknak hulye biztosra ...
// szazszazalekosan").
const CARDS: RelatedCandidate[] = [
  { id: '85eafd56', seq: 46, title: 'Bovitett jelszokezelo: kategoriak/mappak + URL + jegyzet mezo', status: 'waiting' },
  { id: '21311fdb', seq: 96, title: 'Chrome-autofill a jelszokezelohoz (bongeszo-kiterjesztes)', status: 'planned' },
  { id: 'e88fd8e2', seq: 8, title: 'Egyseges email-nezet a dashboardon', status: 'done' },
  { id: 'aaaa1111', seq: 12, title: 'Level kereses a postafiokban', status: 'done' },
]

describe('titleTokens', () => {
  it('keeps distinctive words, folds accents, drops noise', () => {
    expect(titleTokens('Bővített jelszókezelő: kártya és gomb')).toEqual(['bovitett', 'jelszokezelo'])
  })

  it('is empty for a title made only of common words', () => {
    expect(titleTokens('Új kártya a dashboardon')).toEqual([])
  })
})

describe('findSimilarCards', () => {
  it('spots the card a new one obviously belongs with', () => {
    const hits = findSimilarCards('Jelszokezelo: Chrome-autofill kiterjesztes', CARDS)
    expect(hits.map(c => c.id)).toContain('21311fdb')
  })

  it('matches on one long distinctive word', () => {
    expect(findSimilarCards('Uj postafiokban kereses gyorsitasa', CARDS).map(c => c.id)).toContain('aaaa1111')
  })

  it('stays quiet for an unrelated card, so the check does not become noise', () => {
    expect(findSimilarCards('Arany arfolyam elemzes MT4-bol', CARDS)).toEqual([])
  })

  it('returns nothing for a title with no significant words at all', () => {
    expect(findSimilarCards('Egy uj gomb', CARDS)).toEqual([])
  })
})

describe('referencedCardIds', () => {
  it('finds an 8-hex id', () => {
    expect(referencedCardIds('folytatas: 21311fdb', CARDS)).toEqual(['21311fdb'])
  })

  it('finds a board number, which is what people actually write', () => {
    expect(referencedCardIds('A #46 masodik fele', CARDS)).toEqual(['85eafd56'])
  })

  it('ignores a number no card wears, so a price is not a link', () => {
    expect(referencedCardIds('1200 Ft, verzio 1.29, #9999', CARDS)).toEqual([])
  })

  it('ignores a hex blob that is not a card id (a git sha)', () => {
    expect(referencedCardIds('commit 4ce13831 javitotta', CARDS)).toEqual([])
  })
})

describe('crossLinkLine / withCrossLink', () => {
  it('names both the id and the board number, so either form is readable', () => {
    expect(crossLinkLine([CARDS[0]])).toBe('Kapcsolodo kartya: 85eafd56 (#46).')
  })

  it('appends to an existing description without eating it', () => {
    const out = withCrossLink('Eredeti szoveg.', [CARDS[1]])
    expect(out.startsWith('Eredeti szoveg.')).toBe(true)
    expect(out).toContain('21311fdb')
  })

  it('does not add a second link for a card already referenced', () => {
    const already = 'Lasd 21311fdb.'
    expect(withCrossLink(already, [CARDS[1]])).toBe(already)
  })

  it('recognises an existing reference written as a board number', () => {
    const already = 'A #96 folytatja.'
    expect(withCrossLink(already, [CARDS[1]])).toBe(already)
  })

  it('adds only the ones that are missing', () => {
    const out = withCrossLink('Lasd 21311fdb.', [CARDS[0], CARDS[1]])
    expect(out).toContain('85eafd56')
    expect(out.match(/21311fdb/g)).toHaveLength(1)
  })

  it('handles an empty description', () => {
    expect(withCrossLink('', [CARDS[0]])).toBe('Kapcsolodo kartya: 85eafd56 (#46).')
  })
})
