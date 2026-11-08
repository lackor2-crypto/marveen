// Boss, 2026-11-08: the recipient comes from the letter head; "sent" says HOW it went out.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { recipientHeadOf } from '../workbench-maildraft.js'
import { markSentManually, sentMarkOf, cleanSentDetails, onSentEvent, type SentEvent } from '../workbench-docsent.js'
import { sentLogLine } from '../workbench-sent-context.js'

describe('recipientHeadOf: the recipient block of the letter head', () => {
  it('reads the Hungarian block and its distinctive words', () => {
    const h = recipientHeadOf('Feladó:\nKorpás László\n​\nCímzett:\nDeutsche Rentenversicherung Bund\nClearingstelle\n10704 Berlin\n​\nChemnitz, 2026.')
    expect(h).not.toBeNull()
    expect(h!.lines).toEqual(['Deutsche Rentenversicherung Bund', 'Clearingstelle', '10704 Berlin'])
    expect(h!.names).toContain('rentenversicherung')
    expect(h!.names).not.toContain('deutsche')
    expect(h!.email).toBe('')
  })
  it('an address written in the block is the recipient\'s', () => {
    const h = recipientHeadOf('Empfänger:\nMinijob-Zentrale\nminijob@minijob-zentrale.de\n45115 Essen')
    expect(h!.email).toBe('minijob@minijob-zentrale.de')
  })
  it('a text without a labelled block has no head', () => {
    expect(recipientHeadOf('Tisztelt Hivatal!\nValami szöveg')).toBeNull()
  })
})

describe('sent details', () => {
  beforeEach(() => { initDatabase(':memory:') })
  it('a bad method or day is dropped, a good one kept', () => {
    expect(cleanSentDetails({ method: 'carrier-pigeon', date: '2026-13-45' })).toMatchObject({ method: '', date: '' })
    expect(cleanSentDetails({ method: 'portal', date: '2026-11-08', reference: ' S8003 ' })).toMatchObject({ method: 'portal', date: '2026-11-08', reference: 'S8003' })
  })
  it('marking by hand stores how, and tells the listener', () => {
    const seen: SentEvent[] = []
    onSentEvent((e) => seen.push(e))
    markSentManually('item1', 'owner', { method: 'portal', date: '2026-11-08', recipient: 'DRV Clearingstelle', reference: 'S8003-42' })
    expect(sentMarkOf('item1')).toEqual({ method: 'portal', date: '2026-11-08', recipient: 'DRV Clearingstelle', reference: 'S8003-42', note: '' })
    expect(seen[0]).toMatchObject({ method: 'portal', date: '2026-11-08', how: 'manual' })
    onSentEvent(null)
  })
  it('the log line says how it went out', () => {
    const line = sentLogLine('Level', { date: '2026-11-08', recipient: 'DRV', how: 'manual', method: 'post', reference: 'RT123' })
    expect(line).toContain('2026-11-08')
    expect(line).toContain('postán')
    expect(line).toContain('RT123')
  })
})
void getDb
