import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const root = join(__dirname, '..', '..')
const wb = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')

describe('debate panel without an OpenRouter key (#596)', () => {
  it('shows numbered steps with a key-page link and a jump to the Vault page', () => {
    const block = wb.slice(wb.indexOf('m.has_key === false'), wb.indexOf('m.has_key === false') + 900)
    expect(block).toContain('https://openrouter.ai/keys')
    expect(block).toContain('href="#vault"')
    for (const k of ['no_key', 'no_key_s1', 'no_key_s2', 'no_key_s3', 'no_key_s4']) {
      expect(block).toContain(`workbench.db.${k}'`)
    }
  })
  it('has every step in both languages', () => {
    for (const lang of ['hu', 'en']) {
      const l = readFileSync(join(root, 'web', 'lang', `${lang}.js`), 'utf8')
      for (const k of ['no_key', 'no_key_s1', 'no_key_s2', 'no_key_s3', 'no_key_s4']) {
        expect(l).toContain(`"workbench.db.${k}"`)
      }
    }
  })
})
