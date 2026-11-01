// #823: regression locks for three front-end fixes that landed without a test (#1530, #1527, #1524). They are
// source-contract tests: they pin the fixing lines in web/workbench.js, so undoing a fix turns the CI red. They cannot
// see runtime behaviour (that is what the browser clickthrough is for), only that the fix is still in the code.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('#1530: the trigger-document mark also finds an own-file item by its container folder', () => {
  it('the item lookup accepts x.container_folder when the item has no folder of its own', () => {
    expect(src).toContain('x.folder === parent || (!x.folder && x.container_folder === parent)')
  })
  it('the mark and the cross are small (font-size 11px), not a full-size line', () => {
    expect(src).toMatch(/class="wb-trig-mark" style="[^"]*font-size:11px/)
    expect(src).toMatch(/class="wb-trig-x"[^>]*font-size:11px/)
  })
})

describe('#1527: a work item made from a file is not listed a second time as a loose file', () => {
  it('files whose rel is some item\'s source_path are filtered out of the loose list', () => {
    expect(src).toContain('items.forEach(function (it) { if (it.source_path) ownRels[it.source_path] = true })')
    expect(src).toContain('.filter(function (f) { return !(f && f.rel && ownRels[f.rel]) })')
  })
})

describe('#1524: the Life-tree move toast says what happened to a file that met a same-name file', () => {
  it('the per-file messages of the moved files are collected once and appended to the toast', () => {
    expect(src).toContain('res.forEach(function (x) { if (x.ok && !x.trashed && x.message && notes.indexOf(x.message) < 0) notes.push(x.message) })')
    expect(src).toContain("(notes.length ? ' ' + notes.join(' ') : '')")
  })
})
