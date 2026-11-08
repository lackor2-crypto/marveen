// Boss, 2026-11-08: a search for a plain word must reach the IMAP server (it used to become an empty criteria set).
import { describe, it, expect } from 'vitest'
import { buildImapSearchCriteria } from '../web/email-imap.js'

describe('IMAP search criteria from the search box', () => {
  it('a plain word is a TEXT search', () => {
    expect(buildImapSearchCriteria('Statusfeststellungsverfahren')).toEqual({ text: 'Statusfeststellungsverfahren' })
  })
  it('an address is a TEXT search', () => {
    expect(buildImapSearchCriteria('minijob@minijob-zentrale.de')).toEqual({ text: 'minijob@minijob-zentrale.de' })
  })
  it('several plain words stay one phrase', () => {
    expect(buildImapSearchCriteria('Antrag Einleitung')).toEqual({ text: 'Antrag Einleitung' })
  })
  it('prefixed fields still work and mix with plain words', () => {
    expect(buildImapSearchCriteria('from:abc subject:xyz')).toEqual({ from: 'abc', subject: 'xyz' })
    expect(buildImapSearchCriteria('from:abc Hiba')).toEqual({ from: 'abc', text: 'Hiba' })
  })
})
