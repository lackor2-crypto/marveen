// Boss TG 4734 (#851): the translated letter's head sits where the original's does: the sender table over the text at the
// top right with the same width, the recipient block with the same blank lines above and below.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mirrorRecipientWindow, buildLetterHead, LETTER_LAYOUT_RULES_EN } from '../workbench-letterhead.js'

const Z = '​'
const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const CSS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('mirrorRecipientWindow', () => {
  const src = buildLetterHead('hu', ['Korpás László'], ['Minijob-Zentrale', '45115 Essen']).paragraph

  it('restores the blank lines the model stripped', () => {
    const out = mirrorRecipientWindow(src, 'Empfänger:\nMinijob-Zentrale\n45115 Essen')
    expect(out.split('\n').slice(0, 5)).toEqual([Z, Z, Z, Z, 'Empfänger:'])
    expect(out.split('\n').slice(-2)).toEqual([Z, Z])
  })
  it('does not add more than the original had', () => {
    const out = mirrorRecipientWindow(src, [Z, Z, Z, Z, Z, Z, 'Empfänger:', 'X', Z, Z, Z, Z].join('\n'))
    expect(out).toBe([Z, Z, Z, Z, 'Empfänger:', 'X', Z, Z].join('\n'))
  })
  it('leaves any other paragraph alone', () => {
    expect(mirrorRecipientWindow('Tisztelt Hölgyem!', 'Sehr geehrte Damen!')).toBe('Sehr geehrte Damen!')
    expect(mirrorRecipientWindow('Hello', 'Hallo')).toBe('Hallo')
  })
})

describe('the translation page draws the table like the original', () => {
  it('reads the size and place from the same parts as the work item page', () => {
    const i = JS.indexOf('function twTableHtml')
    expect(JS.slice(i, i + 900)).toContain('dpTableParts(text)')
    expect(JS).toContain("'wb-tw-tbl-over '")
  })
  it('the over-the-text table is a zero-height anchor with the original width', () => {
    expect(CSS).toMatch(/\.wb-tw-block\.wb-tw-tbl-over \{ height: 0;/)
    expect(CSS).toMatch(/\.wb-tw-tbl-over > \.wb-tw-tbl \{ position: absolute;[^}]*var\(--wb-ow\)/)
  })
})

describe('the rule is burnt into every prompt', () => {
  it('the shared letter rules say a translation keeps the head of the original', () => {
    expect(LETTER_LAYOUT_RULES_EN).toContain('TRANSLATION (every language version)')
    expect(LETTER_LAYOUT_RULES_EN).toContain('#w=45&a=l&x=55&y=0&o=1')
  })
})
