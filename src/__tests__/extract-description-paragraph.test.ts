import { describe, it, expect } from 'vitest'
import { extractDescriptionFromClaudeMd } from '../web/agent-config.js'

describe('extractDescriptionFromClaudeMd', () => {
  it('joins a hand-wrapped multi-line paragraph instead of cutting at the first line break', () => {
    // Boss 2026-08-08: gypsy's card showed "...Sokoldalu ugynok, akit" with
    // the rest of the sentence lost -- the source had it wrapped onto a
    // second line, and the old implementation only read line 1.
    const claudeMd = `# gypsy

## Szerepkor

Fogalmazasok, jogi dolgok, programozas, vitatkozas. Sokoldalu ugynok, akit
Boss ilyen jellegu feladatokra vesz igenybe.

## Alapelvek

- Ne csinald ezt.
`
    expect(extractDescriptionFromClaudeMd(claudeMd)).toBe(
      'Fogalmazasok, jogi dolgok, programozas, vitatkozas. Sokoldalu ugynok, akit Boss ilyen jellegu feladatokra vesz igenybe.'
    )
  })

  it('stops at the paragraph boundary (blank line), not the whole file', () => {
    const claudeMd = `# x

Elso bekezdes egy sorban.

Masodik bekezdes, ezt mar nem szabad latni.
`
    expect(extractDescriptionFromClaudeMd(claudeMd)).toBe('Elso bekezdes egy sorban.')
  })

  it('a single-line paragraph still works exactly as before', () => {
    const claudeMd = `# x\n\nEgyetlen sor a leiras.\n\n## Masik\n`
    expect(extractDescriptionFromClaudeMd(claudeMd)).toBe('Egyetlen sor a leiras.')
  })

  it('returns empty string when there is no body after the heading', () => {
    expect(extractDescriptionFromClaudeMd('# x\n')).toBe('')
    expect(extractDescriptionFromClaudeMd('')).toBe('')
  })

  it('still truncates to 200 chars for a very long paragraph', () => {
    const claudeMd = '# x\n\n' + 'a'.repeat(250) + '\n'
    expect(extractDescriptionFromClaudeMd(claudeMd).length).toBe(200)
  })
})
