import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// renderMarkdown lives in the browser script web/app.js; cut it out and run it in isolation.
const src = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
const from = src.indexOf('function mdInline')
const to = src.indexOf('\nviewStateRegister', src.indexOf('function renderMarkdown'))
const esc = "function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}function escapeAttr(s){return escapeHtml(s)}"
// eslint-disable-next-line no-new-func
const renderMarkdown = new Function(`${esc}\n${src.slice(from, to)}\nreturn renderMarkdown`)() as (md: string) => string

describe('renderMarkdown', () => {
  it('does not hang on a table-looking row without a separator row (was an infinite loop)', () => {
    expect(renderMarkdown('| a |\n\ntext')).toBe('<p>| a |</p>\n<p>text</p>')
  })

  it('still renders a real table, headings and lists', () => {
    const html = renderMarkdown('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n- y')
    expect(html).toContain('<h1>T</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('<ul><li>x</li><li>y</li></ul>')
  })

  it('escapes raw HTML', () => {
    expect(renderMarkdown('<script>x</script>')).not.toContain('<script>')
  })
})
