// #382: the New project form said the default label is "(optional)" while the
// starter-card box (ticked by default) made saving refuse without one. The
// hint next to the label must follow the checkbox, in both languages.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const app = readFileSync(join(root, 'web', 'app.js'), 'utf8')

describe('New project form: label hint follows the starter-card box (#382)', () => {
  it('the label hint is not hard-wired to "optional" on create', () => {
    expect(app).toContain(`<span class="hint" id="prjLabelReq">\${escapeHtml(t(edit ? 'projects.form.optional' : 'projects.form.label_required_starter'))}</span>`)
  })

  it('ticking/unticking the starter box rewrites the hint', () => {
    const i = app.indexOf("q('#prjStarter')?.addEventListener('change'")
    expect(i).toBeGreaterThan(0)
    const block = app.slice(i, i + 400)
    expect(block).toContain("'projects.form.label_required_starter'")
    expect(block).toContain("'projects.form.optional'")
  })

  it('both languages have the required-hint text', () => {
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(root, 'web', 'lang', `${lang}.js`), 'utf8')
      expect(src).toMatch(/"projects\.form\.label_required_starter": "\(.+\)"/)
    }
  })
})
