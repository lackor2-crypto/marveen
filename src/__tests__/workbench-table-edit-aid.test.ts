// #649 (Boss TG 3087): a table opened for editing showed only its raw "a | b" lines, so it looked as if the table had
// vanished (and Undo had nothing to undo). The page now keeps a live grid under the lines plus one sentence.
// The REAL functions from web/workbench.js are run here; the page ties the first render and every keystroke to the same one.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')

function fnSource(name: string): string {
  const start = SRC.indexOf(`  function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = SRC.indexOf('\n  }\n', start)
  return SRC.slice(start, end + 4)
}

function load(drafts: Record<string, string> = {}) {
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = fnSource('dpTableGridRowsHtml') + fnSource('dpTableEditAidHtml') + '\nreturn { rows: dpTableGridRowsHtml, aid: dpTableEditAidHtml }'
  const fn = new Function('esc', 't', 'dpDraft', 'dpBlockShown', body)
  return fn(
    esc,
    (k: string) => `[${k}]`,
    (key: string, fallback: string) => (key in drafts ? drafts[key] : fallback),
    (b: { text: string }) => b.text,
  ) as { rows: (text: string) => string; aid: (b: { id: string; text: string }) => string }
}

describe('#649: the open table keeps a grid and a sentence', () => {
  it('turns "a | b" lines into a grid: first row is the header, cells are trimmed and escaped', () => {
    const { rows } = load()
    expect(rows('Nev | Ar\nKenyer | <5>')).toBe(
      '<tr><th>Nev</th><th>Ar</th></tr><tr><td>Kenyer</td><td>&lt;5&gt;</td></tr>')
  })
  it('a trailing empty line (Enter at the end) does not draw an empty row, a blank line in the middle does', () => {
    const { rows } = load()
    expect(rows('a | b\n')).toBe('<tr><th>a</th><th>b</th></tr>')
    expect(rows('a | b\n\nc | d')).toContain('<tr><td></td></tr>')
  })
  it('the first render shows the explaining sentence and the grid of the stored text', () => {
    const { aid } = load()
    const html = aid({ id: 'x1', text: 'A | B\n1 | 2' })
    expect(html).toContain('[workbench.dp.tbl_editing]')
    expect(html).toContain('class="wb-dp-tbl-prev"')
    expect(html).toContain('<tr><td>1</td><td>2</td></tr>')
    expect(html).toContain('contenteditable="false"')
  })
  it('an unsaved draft wins over the stored text (the grid shows what is in the field)', () => {
    const { aid } = load({ 'b:x1': 'A | B\n9 | 8' })
    const html = aid({ id: 'x1', text: 'A | B\n1 | 2' })
    expect(html).toContain('<td>9</td><td>8</td>')
    expect(html).not.toContain('<td>1</td>')
  })
  it('the keystroke handler uses the same grid builder as the first render', () => {
    const at = SRC.indexOf('#649: the grid under an open table')
    expect(at).toBeGreaterThan(-1)
    expect(SRC.slice(at, at + 400)).toContain('prev.innerHTML = dpTableGridRowsHtml(tf.innerText)')
  })
})
