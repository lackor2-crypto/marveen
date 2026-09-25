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
    expect(app).toContain(`<span class="hint" id="prjLabelReq">\${escapeHtml(t(_prjLabelHintKey(!edit)))}</span>`)
  })

  it('ticking/unticking the starter box rewrites the hint through the same rule', () => {
    const i = app.indexOf("q('#prjStarter')?.addEventListener('change'")
    expect(i).toBeGreaterThan(0)
    expect(app.slice(i, i + 300)).toContain("_prjLabelHintKey(q('#prjStarter').checked)")
  })

  // Fresh install: the labels table is empty, saving works without a label,
  // so the hint must say "optional" there (review of #382, approval 387b93a5).
  it('says "required" only with a starter card AND at least one label on the board', () => {
    const i = app.indexOf('function _prjLabelHintKey(')
    expect(i).toBeGreaterThan(0)
    const src = app.slice(i, app.indexOf('\n}\n', i) + 2)
    const _prj: any = { form: { labels: [] } }
    // eslint-disable-next-line no-new-func
    const key = new Function('_prj', src + '; return _prjLabelHintKey')(_prj)
    expect(key(true)).toBe('projects.form.optional')
    expect(key(false)).toBe('projects.form.optional')
    _prj.form.labels = [{ id: 'a', name: 'x' }]
    expect(key(true)).toBe('projects.form.label_required_starter')
    expect(key(false)).toBe('projects.form.optional')
  })

  it('the hint rule matches the save check (starter + no label + labels exist)', () => {
    expect(app).toContain('if (body.starter_card && !body.default_label_id && f.labels.length) {')
  })

  it('both languages have the required-hint text', () => {
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(root, 'web', 'lang', `${lang}.js`), 'utf8')
      expect(src).toMatch(/"projects\.form\.label_required_starter": "\(.+\)"/)
    }
  })
})
