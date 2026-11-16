import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactSkillText, compactSkillsDir, shortenDescription, SKILL_DESC_MAX, FULL_DESC_MARKER } from '../web/skill-desc-digest.js'

// #799: the skill listing is ~10k tokens at every start. Long descriptions are shortened, the original text
// is kept as the first body line -- no information is lost.
const long = 'Mikor hasznald: ' + 'ez egy nagyon hosszu leiras, rengeteg kulcsszoval. '.repeat(12) + 'Vege.'
const skill = (d: string) => `---\nname: x\nscope: global\ndescription: ${d}\n---\n\n# Cim\n\nTorzs.\n`

describe('skill description digest (#799)', () => {
  it('shortens a long description and keeps the original in the body', () => {
    const out = compactSkillText(skill(long))!
    const desc = out.match(/^description: (.*)$/m)![1]
    expect(desc.length).toBeLessThanOrEqual(SKILL_DESC_MAX)
    expect(out).toContain(FULL_DESC_MARKER + long)
    expect(out).toContain('# Cim')
    expect(out.startsWith('---\nname: x\nscope: global\n')).toBe(true)
  })

  it('is idempotent and leaves short descriptions alone', () => {
    expect(compactSkillText(skill('Rovid.'))).toBeNull()
    const once = compactSkillText(skill(long))!
    expect(compactSkillText(once)).toBeNull()
  })

  it('never ends the description on a colon (unsafe plain YAML scalar)', () => {
    expect(shortenDescription('a '.repeat(50) + 'Akkor hasznald: ' + 'b '.repeat(80)).endsWith(':')).toBe(false)
  })

  it('leaves quoted and block descriptions untouched', () => {
    expect(compactSkillText(`---\nname: x\ndescription: "${long}"\n---\nT\n`)).toBeNull()
    expect(compactSkillText(`---\nname: x\ndescription: >\n  ${long}\n---\nT\n`)).toBeNull()
  })

  it('rewrites a directory and reports the savings', () => {
    const d = mkdtempSync(join(tmpdir(), 'skilldiet-'))
    try {
      mkdirSync(join(d, 'a')); writeFileSync(join(d, 'a', 'SKILL.md'), skill(long))
      mkdirSync(join(d, 'b')); writeFileSync(join(d, 'b', 'SKILL.md'), skill('Rovid.'))
      const r = compactSkillsDir(d)
      expect(r.changed).toBe(1)
      expect(r.saved).toBeGreaterThan(300)
      expect(readFileSync(join(d, 'a', 'SKILL.md'), 'utf-8')).toContain(FULL_DESC_MARKER)
      expect(compactSkillsDir(d).changed).toBe(0)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
