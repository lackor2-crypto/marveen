// #547 (owner, 2026-10-10): deleting the open work item threw the owner out of the editor to the start page.
// Measured in Chromium on an isolated instance (three items + an empty folder): the neighbour opens, deleting an
// empty folder changes nothing on the right, and the start page comes only when no item is left.
// This pins the rule and its wiring.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

/** The rule, taken from the page source so the test runs the real code. */
function neighbour(): (before: { id: string }[], gone: string, now: { id: string }[]) => string | null {
  const at = src.indexOf('function neighbourItemId(before, goneId, now) {')
  const end = src.indexOf('\n  }\n', at) + 4
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(src.slice(at, end) + '\nreturn neighbourItemId')() as never
}
const ids = (...x: string[]): { id: string }[] => x.map((id) => ({ id }))

describe('which work item opens after the open one is deleted (#547)', () => {
  const n = neighbour()
  it('the next one in the order the owner was looking at', () => {
    expect(n(ids('a', 'b', 'c'), 'b', ids('a', 'c'))).toBe('c')
  })
  it('the one before it when it was the last', () => {
    expect(n(ids('a', 'b', 'c'), 'c', ids('a', 'b'))).toBe('b')
  })
  it('skips neighbours that left together with it (a folder with several items)', () => {
    expect(n(ids('a', 'b', 'c', 'd'), 'b', ids('a', 'd'))).toBe('d')
  })
  it('nothing left: null, and only then the start page', () => {
    expect(n(ids('a'), 'a', [])).toBeNull()
  })
  it('an item that was not in the old list: the first of what is there', () => {
    expect(n(ids('a'), 'x', ids('a'))).toBe('a')
  })
})

describe('wiring (#547)', () => {
  it('trashing the open item and deleting its folder both stay in the editor', () => {
    expect(src).toContain('if (deleted && WB.selectedId === id) stayAfterRemoval(before, id)')
    expect(src).toContain('if (WB.selectedId && !(WB.items || []).some(function (x) { return x.id === WB.selectedId })) stayAfterRemoval(before, WB.selectedId)')
    expect(src).not.toContain('if (deleted && WB.selectedId === id) { WB.selectedId = null; WB.detail = null }')
  })
})
