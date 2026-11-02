// Boss TG 4543: the window-envelope letter head is ONE builder; it must satisfy the parser, the check and the owner's own sample.
import { describe, expect, it } from 'vitest'
import { buildLetterHead, hasLetterHead, LETTER_HEAD_SENDER_TAIL } from '../workbench-letterhead.js'
import { tableBlockParts } from '../workbench-docmodel.js'

describe('window-envelope letter head', () => {
  const h = buildLetterHead('hu', ['Korpás László', 'Erich-Steinfurth-Straße 25', '09131 Chemnitz'], ['Minijob-Zentrale', '45115 Essen'])
  it('sender table sits top right over the text and takes no room', () => {
    const p = tableBlockParts(h.table)
    expect(p.over).toBe(true)
    expect(p.width).toBe(45)
    expect(p.x).toBe(55)
    expect(p.y).toBe(0)
    expect(p.text.startsWith('Feladó:\nKorpás László')).toBe(true)
    expect(h.table.endsWith(LETTER_HEAD_SENDER_TAIL)).toBe(true)
  })
  it('recipient is pushed down 4 empty lines above and 2 below, label first', () => {
    const lines = h.paragraph.split('\n')
    expect(lines.slice(0, 4).every((l) => l === '​')).toBe(true)
    expect(lines[4]).toBe('Címzett:')
    expect(lines.slice(-2).every((l) => l === '​')).toBe(true)
  })
  it('the letter-head check accepts it, in every language', () => {
    for (const lang of ['hu', 'de', 'en']) {
      const x = buildLetterHead(lang, ['A'], ['B'])
      expect(hasLetterHead([{ kind: 'table', text: x.table }, { kind: 'paragraph', text: x.paragraph }])).toBe(true)
    }
    expect(buildLetterHead('de', ['A'], ['B']).table.startsWith('Absender:')).toBe(true)
    expect(buildLetterHead('de', ['A'], ['B']).paragraph).toContain('Empfänger:')
  })
})
