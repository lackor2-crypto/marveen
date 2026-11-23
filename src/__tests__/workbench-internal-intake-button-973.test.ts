// #973: the Simple view's "What do you want to create?" buttons must offer "Internal work", not only the manual form.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')

describe('Internal work start button (#973)', () => {
  const js = read('web', 'workbench.js')
  it('is among the Simple view start buttons and creates an internal-type item', () => {
    expect(js).toMatch(/INTAKE_UI_KINDS = INTAKE_KINDS\.concat\(\[[^\]]*'internal'[^\]]*\]\)/)
    expect(js).toContain("if (kind === 'internal') { intakeCreateInternal(text, name); return }")
    expect(js).toMatch(/function intakeCreateInternal[\s\S]*?type: 'internal'/)
  })
  it('has a Hungarian and an English label and default title', () => {
    for (const l of ['hu', 'en']) {
      const lang = read('web', 'lang', `${l}.js`)
      expect(lang).toContain('"workbench.intake.kind.internal"')
      expect(lang).toContain('"workbench.internal.default_title"')
    }
  })
})
