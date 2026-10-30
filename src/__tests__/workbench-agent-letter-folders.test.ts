// Boss 2026-10-30: a correspondence case holds exactly four folders (Kérelem, Bejövő levelek, Kimenő levelek, Egyéb), no numbers, no dates.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_PROMPT } from '../workbench-agent/context.js'

const skill = readFileSync(join(__dirname, '..', '..', 'seed-skills', 'inbox-document-sorting', 'SKILL.md'), 'utf8')

describe('levelezéses ügy: négy mappa', () => {
  it('az asszisztens szabálya megnevezi a négy mappát, és tiltja a levelenkénti mappát', () => {
    for (const n of ['Kérelem', 'Bejövő levelek', 'Kimenő levelek', 'Egyéb']) expect(SYSTEM_PROMPT).toContain(`"${n}"`)
    expect(SYSTEM_PROMPT).toContain('Never open a numbered or dated folder per letter')
    expect(SYSTEM_PROMPT).toContain('never recreate, rename or overwrite')
  })
  it('a globális skill ugyanezt mondja', () => {
    for (const n of ['Kérelem', 'Bejövő levelek', 'Kimenő levelek', 'Egyéb']) expect(skill).toContain(`\`${n}\``)
  })
})
