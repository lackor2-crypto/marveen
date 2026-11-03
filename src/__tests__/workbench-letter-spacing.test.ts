// Boss TG 4582: parts of an official letter stand apart by blank lines; the rule reaches every layer and a watch flags glued lines.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
import { LETTER_LAYOUT_RULES_EN, letterSpacingMissing } from '../workbench-letterhead.js'
import { buildLetterHeadBody } from '../web/agent-scaffold.js'

const Z = '​'
const p = (text: string) => ({ kind: 'paragraph', text })
const read = (f: string) => readFileSync(join(PROJECT_ROOT, f), 'utf-8')

describe('letter spacing watch', () => {
  it('flags a subject and salutation glued to the lines before (the Minijob letter)', () => {
    const glued = [p('Chemnitz, 2026. 11. 03.\nTárgy: Kérés\nMunkáltató: X\nBiztosítási szám: 1\nTisztelt Minijob-Zentrale!\nSzöveg.')]
    expect(letterSpacingMissing(glued)).toBe(1)
  })
  it('is quiet when the parts are set apart by blank lines', () => {
    const ok = [
      p(`Chemnitz, 2026. 11. 03.\n${Z}\nTárgy: Kérés\n${Z}\nMunkáltató: X\nBiztosítási szám: 1\n${Z}\nTisztelt Minijob-Zentrale!\n${Z}\nSzöveg.\n${Z}\nTisztelettel,\n${Z}\n${Z}\n${Z}\nKorpás László`),
    ]
    expect(letterSpacingMissing(ok)).toBe(0)
  })
  it('is quiet when the blank lines come as separate empty blocks / not a letter', () => {
    expect(letterSpacingMissing([p('Chemnitz\n' + Z), p('Tárgy: Kérés\n' + Z), p('Tisztelt Hivatal!\n' + Z), p('Szöveg')])).toBe(0)
    expect(letterSpacingMissing([p('Jegyzet\nTárgy: valami\nszöveg')])).toBe(0)
  })
})

describe('letter spacing rule reaches every layer', () => {
  it('has the one source text in the agent CLAUDE.md body, the prompts, the template, the skills', () => {
    expect(LETTER_LAYOUT_RULES_EN).toContain('LETTER SPACING')
    expect(buildLetterHeadBody()).toContain(LETTER_LAYOUT_RULES_EN)
    expect(read('src/workbench-agent/context.ts')).toContain('${LETTER_LAYOUT_RULES_EN}')
    expect(read('src/web/routes/workbench-agent.ts')).toContain('${LETTER_LAYOUT_RULES_EN}')
    expect(read('templates/CLAUDE.md.template')).toContain('letter_spacing_missing')
    expect(read('seed-skills/letter-head-sender-recipient/SKILL.md')).toContain('Levél tördelése')
    expect(read('seed-skills/marveen-learned-rules/SKILL.md')).toContain('### R28')
  })
  it('has the check labels in both languages', () => {
    expect(read('web/lang/hu.js')).toContain('check.letter_spacing_missing')
    expect(read('web/lang/en.js')).toContain('check.letter_spacing_missing')
    expect(read('src/workbench-check-todos.ts')).toContain('letter_spacing_missing')
  })
})

import { enforceRecipientWindow } from '../workbench-letterhead.js'
describe('recipient window position (Boss TG 4597)', () => {
  it('restores the 4 blank lines above a recipient the agent wrote without them', () => {
    const out = enforceRecipientWindow('Címzett:\nMinijob-Zentrale\n45115 Essen')
    expect(out.split('\n').slice(0, 4)).toEqual([Z, Z, Z, Z])
    expect(out.split('\n')[4]).toBe('Címzett:')
    expect(enforceRecipientWindow('Empfänger:\nX').split('\n')[4]).toBe('Empfänger:')
  })
  it('tops up a partial gap, leaves a correct block and other text alone', () => {
    expect(enforceRecipientWindow(`${Z}\nRecipient:\nX`).split('\n').filter((l) => l === Z).length).toBe(4)
    const ok = `${Z}\n${Z}\n${Z}\n${Z}\nCímzett:\nX\n${Z}\n${Z}`
    expect(enforceRecipientWindow(ok)).toBe(ok)
    expect(enforceRecipientWindow('Chemnitz, 2026. 11. 03.\nCímzett: ismeretlen')).toBe('Chemnitz, 2026. 11. 03.\nCímzett: ismeretlen')
  })
})
