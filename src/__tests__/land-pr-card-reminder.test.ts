// Card #332 (876b2833): the landing trigger that reminds the agent to move a
// finished card to 'waiting'. The trigger itself shipped untested -- it lived
// as a one-liner inside land-pr.sh -- and carried two real defects:
//
//   1. "could not look" was printed exactly like "no such card": a stopped
//      dashboard, an unreadable token file or a curl timeout all produced an
//      empty answer, and the script then said the same soft sentence it says
//      for a card that is genuinely not on the board. Zero means two things.
//   2. an archived card raised a FALSE alarm: the lookup used /api/kanban,
//      which filters `archived_at IS NULL` and auto-archives old 'done' cards,
//      so a later commit referencing a long-closed card was told to "move it
//      to waiting". A nagging reminder teaches agents to ignore reminders.
//
// These tests pin the behaviour of the extracted module, the same way
// ci-verdict.mjs and empty-run-diagnosis.mjs are pinned.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
// @ts-expect-error -- plain .mjs helper, no type declarations by design
import { cardRefFromTitle, lookupCard, reminderLine } from '../../scripts/lib/card-reminder.mjs'

const cards = JSON.stringify([
  { id: '876b2833', seq: 332, title: 'Kesz kartya azonnal a varakozoba', status: 'in_progress' },
  { id: '63f6162e', seq: 327, title: 'Beerkezo kijeloles', status: 'waiting' },
  { id: '5679a835', seq: 328, title: 'Duplikatum', status: 'done' },
])

describe('cardRefFromTitle', () => {
  it('a hexa kartya-azonositot veszi ki', () => {
    expect(cardRefFromTitle('fix(#876b2833): valami')).toBe('876b2833')
  })

  it('a sorszamot is felismeri', () => {
    expect(cardRefFromTitle('feat(#332): valami')).toBe('332')
  })

  it('az ELSO referenciat veszi, nem a PR-szamot a vegerol', () => {
    expect(cardRefFromTitle('fix(#876b2833): valami (#212)')).toBe('876b2833')
  })

  it('referencia nelkuli cimre ures', () => {
    expect(cardRefFromTitle('chore: takaritas')).toBe('')
  })
})

describe('lookupCard: a nulla ket dolgot jelenthet', () => {
  it('megtalalt kartyara az allapotat adja', () => {
    expect(lookupCard(cards, '876b2833')).toEqual({ ok: true, found: true, status: 'in_progress' })
  })

  it('sorszam szerint is megtalalja', () => {
    expect(lookupCard(cards, '332')).toEqual({ ok: true, found: true, status: 'in_progress' })
  })

  it('nem letezo kartyara "found: false", NEM hiba', () => {
    expect(lookupCard(cards, 'deadbeef')).toEqual({ ok: true, found: false, status: '' })
  })

  it('ertelmezhetetlen valasz NEM "nincs ilyen kartya"', () => {
    expect(lookupCard('<html>502 Bad Gateway</html>', '876b2833').ok).toBe(false)
    expect(lookupCard('', '876b2833').ok).toBe(false)
    expect(lookupCard('{"error":"unauthorized"}', '876b2833').ok).toBe(false)
  })
})

describe('reminderLine', () => {
  it('nem waiting/done kartyara hangosan szol', () => {
    const line = reminderLine('fix(#876b2833): valami', cards, '')
    expect(line).toContain('EMLEKEZTETO')
    expect(line).toContain('#876b2833')
    expect(line).toContain("in_progress")
  })

  it('waiting es done kartyara HALLGAT', () => {
    expect(reminderLine('fix(#63f6162e): valami', cards, '')).toBe('')
    expect(reminderLine('fix(#5679a835): valami', cards, '')).toBe('')
  })

  it('a lekerdezes hibajat KIMONDJA, nem "nincs ilyen kartya"-nak olvassa', () => {
    const line = reminderLine('fix(#876b2833): valami', '', 'a dashboard nem valaszolt a localhost:3420 cimen')
    expect(line).toContain('NEM TUDTAM MEGNEZNI')
    expect(line).toContain('nem valaszolt')
    expect(line).not.toContain('EMLEKEZTETO:')
  })

  it('ismeretlen referenciara halk megjegyzes, nem riasztas', () => {
    const line = reminderLine('fix(#deadbeef): valami', cards, '')
    expect(line).not.toContain('EMLEKEZTETO')
    expect(line).toContain('nem szerepel')
  })

  it('kartya-referencia nelkuli cimre semmit nem ir', () => {
    expect(reminderLine('chore: takaritas', cards, '')).toBe('')
  })
})

describe('land-pr.sh: a trigger a tesztelt modult es a TELJES kartyalistat hasznalja', () => {
  const script = readFileSync(join(PROJECT_ROOT, 'scripts', 'land-pr.sh'), 'utf8')

  it('a kulon fajlba emelt, tesztelheto modult hivja', () => {
    expect(existsSync(join(PROJECT_ROOT, 'scripts', 'lib', 'card-reminder.mjs'))).toBe(true)
    expect(script).toContain('card-reminder.mjs')
  })

  it('a card-ids vegpontot kerdezi (az archivalt kartyakat is latja)', () => {
    expect(script).toContain('/api/kanban/card-ids')
    // A regi, archivaltakat kihagyo lekerdezes nem maradhat benne.
    expect(script).not.toMatch(/localhost:\$PORT\/api\/kanban"/)
  })

  it('a "nem lattam oda" okat atadja a modulnak, nem nyeli le', () => {
    expect(script).toContain('LOOKUP_ERR')
    expect(script).toContain('nincs olvashato dashboard-token')
  })
})
