// THE TWO-PANE EXPLORER (card adf4d1c5): folder tree left, content right.
//
// app.js is one browser file the test runner cannot load as a module, so the
// guards read its source: these are the lines whose loss brings a bug back.
// The behaviour itself was checked in a real browser (desktop + phone width).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
const html = readFileSync(join(process.cwd(), 'web', 'index.html'), 'utf8')
const css = readFileSync(join(process.cwd(), 'web', 'style.css'), 'utf8')
const hu = readFileSync(join(process.cwd(), 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(process.cwd(), 'web', 'lang', 'en.js'), 'utf8')

function fnBody(head: string): string {
  const i = app.indexOf(head)
  if (i < 0) throw new Error('missing function: ' + head)
  const end = app.indexOf('\n}', i)
  return app.slice(i, end + 2)
}

describe('Intezo folder tree', () => {
  it('the page has the tree pane next to the list, and a show/hide button', () => {
    expect(html).toMatch(/<nav id="intezoTree"[^>]*>/)
    const split = html.slice(html.indexOf('class="intezo-split"'))
    expect(split.indexOf('id="intezoTree"')).toBeLessThan(split.indexOf('id="intezoList"'))
    expect(html).toContain('id="intezoTreeBtn"')
    // `display:flex` would beat [hidden] -- the hide button must really hide it.
    expect(css).toContain('.intezo-tree[hidden] { display: none; }')
  })

  it('every list render updates the tree, and a search hit list is never cached as children', () => {
    expect(fnBody('function _intezoRender()')).toContain('_intezoTreeSync()')
    expect(fnBody('async function _intezoSearch()')).toContain('searching: true')
    expect(fnBody('async function _intezoTreeSync()')).toContain('!L.searching')
  })

  it('reopening the same folder (refresh, after a change) drops the stale branches', () => {
    const open = fnBody('async function _intezoOpen(rel)')
    expect(open).toMatch(/if \(uj === _intezoPath\) \{ _intezoTreeKids = new Map\(\)/)
  })

  it('branches load without the slow source probe, and a failure is shown, not an empty branch', () => {
    const sync = fnBody('async function _intezoTreeSync()')
    expect(sync).toContain('deep=0')
    expect(sync).toContain('_intezoTreeErr.set(rel')
  })

  it('a folder KNOWN to have no subfolders gets no arrow; unknown or pending keeps it', () => {
    const leaf = fnBody('function _intezoTreeIsLeaf(entry)')
    expect(leaf).toContain('c.pending) return false')
    expect(leaf).toContain("c.state === 'empty'")
  })

  it('all tree texts exist in both languages', () => {
    for (const k of ['tree_toggle', 'tree_toggle_title', 'tree_aria', 'tree_root_name', 'tree_loading', 'tree_expand', 'tree_collapse', 'tree_failed']) {
      expect(hu).toContain(`'intezo.${k}':`)
      expect(en).toContain(`'intezo.${k}':`)
    }
  })
})

describe('Intezo content list zebra rows', () => {
  it('the right-pane table carries the class the alternating background hangs on', () => {
    expect(app).toContain('<table class="intezo-list"')
    expect(css).toMatch(/table\.intezo-list > tbody > tr:nth-child\(even\) \{ background:/)
    // hover must stay visible over a striped row
    expect(css).toMatch(/table\.intezo-list > tbody > tr:hover \{ background:/)
  })
})
