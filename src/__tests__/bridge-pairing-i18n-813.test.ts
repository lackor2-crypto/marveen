// BRIDGEHU813: every error code the bridge-enroll route can send has a Hungarian AND an English sentence, and the pairing UI
// uses them (a code without a message is how the pairing panel fell back to English).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const core = read('src/remote-enroll-core.ts')
const codes = new Set<string>([...core.matchAll(/RemoteEnrollError\([\s\S]*?'([a-z_0-9]+)'\s*(?:,\s*\{[^}]*\})?\s*,?\s*\)/g)].map((m) => m[1]))
for (const c of ['enroll813', 'enroll_failed']) codes.add(c)

describe('bridge pairing error translation (#824/BRIDGEHU813)', () => {
  it('finds the codes', () => { expect(codes.size).toBeGreaterThanOrEqual(14) })
  for (const lang of ['hu', 'en']) {
    it(`every code has a ${lang} sentence`, () => {
      const lng = read(`web/lang/${lang}.js`)
      for (const c of codes) expect(lng, `${lang}: ${c}`).toContain(`'auth.bridge.err.${c}'`)
    })
  }
  it('the pairing handler maps the code through the language table', () => {
    const app = read('web/app.js')
    expect(app).toContain('function bridgeEnrollErrorText(data)')
    expect(app).toContain('msg.textContent = bridgeEnrollErrorText(data)')
  })
})
