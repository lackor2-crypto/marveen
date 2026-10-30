// Boss 2026-10-30: a correspondence case holds exactly three folders (Kérelem, Bejövő levelek, Kimenő levelek), no numbers, no dates.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_PROMPT } from '../workbench-agent/context.js'

const skill = readFileSync(join(__dirname, '..', '..', 'seed-skills', 'inbox-document-sorting', 'SKILL.md'), 'utf8')

describe('levelezéses ügy: három mappa', () => {
  it('az asszisztens szabálya megnevezi a három mappát, és tiltja a levelenkénti mappát', () => {
    for (const n of ['Kérelem', 'Bejövő levelek', 'Kimenő levelek']) expect(SYSTEM_PROMPT).toContain(`"${n}"`)
    expect(SYSTEM_PROMPT).toContain('Never open a numbered or dated folder per letter')
    expect(SYSTEM_PROMPT).toContain('never recreate, rename or overwrite')
  })
  it('a globális skill ugyanezt mondja', () => {
    for (const n of ['Kérelem', 'Bejövő levelek', 'Kimenő levelek']) expect(skill).toContain(`\`${n}\``)
  })
})
