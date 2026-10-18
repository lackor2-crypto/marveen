import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// #696 (Boss TG 9643/9650): in the Workbench left tree a work item's own files/sub-items come FIRST, its (sub)folders after,
// at every level -- no folder sits between a work item header and its files.
describe('workbench tree: files before folders (#696)', () => {
  const js = readFileSync(join(process.cwd(), 'web/workbench.js'), 'utf-8')
  const body = (from: string, to: string) => {
    const a = js.indexOf(from)
    const b = js.indexOf(to, a)
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    return js.slice(a, b)
  }
  it('walk(): the mixed files/items rows are pushed before the folder loop', () => {
    const w = body('function walk(path, depth, grp) {', '// Items directly in the box come first')
    expect(w.indexOf('mixed.forEach(function (m) { rows.push(')).toBeGreaterThan(-1)
    expect(w.indexOf('mixed.forEach(function (m) { rows.push(')).toBeLessThan(w.indexOf('(kids[path] || []).forEach(function (f) {'))
  })
  it('walkOutside(): the files rows are pushed before the folder loop', () => {
    const w = body('function walkOutside(path, depth, grp) {', 'if (box) walkOutside')
    expect(w.indexOf('(out.files || {})[path] || []).slice().sort(nameCmp).forEach')).toBeGreaterThan(-1)
    expect(w.indexOf('(out.files || {})[path] || []).slice().sort(nameCmp).forEach')).toBeLessThan(w.indexOf('kidsHere.forEach(function (e) {'))
  })
})
