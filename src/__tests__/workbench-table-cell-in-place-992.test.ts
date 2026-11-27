// #992 (Boss TG 7794): "when I click into a table, the document must not move". The click swapped the grid for its raw
// "a | b" lines plus a second grid, so the sheet grew by ~500 px under the pointer. A cell is now written in place.
// The REAL functions from web/workbench.js are run here; the geometry itself was measured in a browser (card #992).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')
const CSS = readFileSync(join(ROOT, 'web', 'workbench.css'), 'utf8')

function fnSource(name: string): string {
  const start = SRC.indexOf(`  function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  const end = SRC.indexOf('\n  }\n', start)
  return SRC.slice(start, end + 4)
}

const BLANK = '​'
const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function pure() {
  const body = fnSource('dpTblRowsHtml') + fnSource('dpTblSetCell') + fnSource('dpTblReshape')
    + '\nreturn { rows: dpTblRowsHtml, set: dpTblSetCell, reshape: dpTblReshape }'
  return new Function('esc', 'escA', 'DP_BLANK', body)(esc, esc, BLANK) as {
    rows: (text: string, bid: string, ro: boolean) => string
    set: (body: string, r: number, c: number, value: string) => string
    reshape: (body: string, op: string, r: number, c: number) => string | null
  }
}

describe('#992: a table cell is written in place', () => {
  it('every cell of an editable table is its own field; a read-only one has none', () => {
    const { rows } = pure()
    const html = rows('A | B\n1 | <2>', 'x', false)
    expect(html).toContain('<th contenteditable="true" id="wbDpC_x_0_0" data-wb-cell="0:0">A</th>')
    expect(html).toContain('<td contenteditable="true" id="wbDpC_x_1_1" data-wb-cell="1:1">&lt;2&gt;</td>')
    expect(rows('A | B', 'x', true)).toBe('<tr><th>A</th><th>B</th></tr>')
  })

  it('a click on the table opens nothing: the island is not a button, the text mode has a button of its own', () => {
    const table = fnSource('dpTableHtml')
    expect(table).not.toContain('role="button" tabindex="0" data-wb-act="dp-tbl-edit"')
    expect(table).toMatch(/class="wb-dp-img-al wb-dp-tbl-word" data-wb-act="dp-tbl-edit"/)
  })

  it('typing changes that one cell, every other byte stays', () => {
    const { set } = pure()
    const body = 'A |B|  C\n1 | 2 | 3\n---|---|---'
    expect(set(body, 1, 1, 'kettő')).toBe('A |B|  C\n1 | kettő | 3\n---|---|---')
    expect(set(body, 1, 0, '')).toBe('A |B|  C\n | 2 | 3\n---|---|---')
    expect(set(body, 1, 2, 'x')).toBe('A |B|  C\n1 | 2 | x\n---|---|---')
    expect(set(body, 9, 0, 'x')).toBe(body)
  })

  it('a typed | or line break stays inside the cell; an emptied one-column row stays a row', () => {
    const { set } = pure()
    expect(set('a | b', 0, 0, 'x|y\nz')).toBe('x∣y z | b')
    expect(set('fej\nsor', 1, 0, '')).toBe(`fej\n${BLANK}`)
  })

  it('rows and columns can be added and removed, never the last one', () => {
    const { reshape } = pure()
    expect(reshape('A | B\n1 | 2', 'row-add', 0, 0)).toBe('A | B\n | \n1 | 2')
    expect(reshape('A | B\n1 | 2', 'row-del', 1, 0)).toBe('A | B')
    expect(reshape('A | B\n1 | 2', 'col-add', 0, 0)).toBe('A |  | B\n1 |  | 2')
    expect(reshape('A | B\n1 | 2', 'col-del', 0, 1)).toBe('A\n1')
    expect(reshape('A', 'row-del', 0, 0)).toBeNull()
    expect(reshape('A\n1', 'col-del', 0, 0)).toBeNull()
  })

  it('Ctrl+A in a cell selects the cell only (the browser would take the whole document)', () => {
    let selected: unknown = null
    let prevented = 0
    const key = new Function('WB', 'dpTblCellSelect', fnSource('dpTblCellKey') + '\nreturn dpTblCellKey')(
      {}, (c: unknown) => { selected = c },
    ) as (e: unknown, cell: unknown) => void
    const cell = { name: 'cell' }
    key({ key: 'a', ctrlKey: true, preventDefault: () => { prevented++ } }, cell)
    expect(selected).toBe(cell)
    expect(prevented).toBe(1)
  })

  it('the page save sends the typed lines with the table\'s own size and place', () => {
    const model = fnSource('dpPageModel')
    expect(model).toContain("getAttribute('data-wb-tbl-text')")
    expect(model).toContain('dpTableText(typed.trim() ? typed : DP_BLANK, itp.width, itp.align, itp.x, itp.y, itp.over)')
  })

  it('a click on an empty new line pushes nothing down: the row takes room only once it holds something', () => {
    expect(CSS).not.toMatch(/\.wb-dp-tailrow\.is-cur\s*\{/)
    expect(CSS).toMatch(/\.wb-dp-tailrow\.is-cur > \.wb-dp-tail \{[^}]*pointer-events: none/)
    expect(CSS).toMatch(/\.wb-dp-tailrow\.is-cur:has\(> \.wb-dp-tail:not\(:empty\)\) \{ height: auto; \}/)
  })

  it('the button bar sits above the table, never over a cell, and opens only from its own button', () => {
    expect(CSS).toMatch(/\.wb-dp-tbl \.wb-dp-img-tools \{[^}]*bottom: 100%[^}]*visibility: hidden/)
    expect(CSS).not.toMatch(/\.wb-dp-tbl \.wb-dp-img-tools \{ top: -14px; \}/)
    // hover or a cursor in a cell must not bring the bar over the line above
    expect(CSS).not.toMatch(/\.wb-dp-tbl:(hover|focus-within)[^,{]*\.wb-dp-img-tools/)
    expect(CSS).toMatch(/\.wb-dp-tbl\.is-menu > \.wb-dp-img-tools \{ visibility: visible/)
    expect(fnSource('dpTableHtml')).toContain('data-wb-act="dp-tbl-menu"')
    expect(SRC).toContain("a === 'dp-tbl-menu') dpTblMenu(bid)")
  })

  it('a table aligned to the right keeps the width it was given: its row has no gutter inside that width', () => {
    expect(CSS).toMatch(/\.wb-dp-row-float-r:has\(> \.wb-dp-img\), \.wb-dp-row-float-r:has\(> \.wb-dp-tbl\) \{ padding-left: 0; \}/)
  })

  it('with the page lines off the paper margins still shrink with a narrow sheet', () => {
    expect(CSS).toMatch(/\.wb-dp-page, \.wb-tw-page \{ --pg-pt: min\(57px, 7\.14%\); --pg-pr: min\(76px, 9\.52%\); --pg-pb: min\(57px, 7\.14%\); --pg-pl: min\(95px, 11\.9%\); \}/)
  })

  it('the table button opens one bar at a time; pressing it again closes it', () => {
    const island = (id: string) => {
      const set = new Set<string>()
      return {
        set,
        getAttribute: () => id,
        classList: { contains: (c: string) => set.has(c), toggle: (c: string, on: boolean) => { if (on) set.add(c); else set.delete(c) } },
        querySelector: () => null,
      }
    }
    const all = [island('a'), island('b')]
    const menu = new Function('document', fnSource('dpTblMenu') + '\nreturn dpTblMenu')({ querySelectorAll: () => all }) as (bid: string | null) => void
    const open = () => all.map((i) => i.set.has('is-menu'))
    menu('a'); expect(open()).toEqual([true, false])
    menu('b'); expect(open()).toEqual([false, true])
    menu('b'); expect(open()).toEqual([false, false])
    menu('a'); menu(null); expect(open()).toEqual([false, false])
  })
})
