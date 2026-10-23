// #716: the "Mellekletek (n)" counter of the folder tree and the annex list under the page must agree. An annex
// change (link from the Life tree, remove, rename, move) redrew only the list, so the tree kept the old number
// until the 20 s poll; the owner saw two different counts on one screen.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')

describe('annex counter of the folder tree', () => {
  const start = js.indexOf('function outlineCall(method, sub, body)')
  const body = js.slice(start, js.indexOf('function findBlock(bid)', start))

  it('an annex call redraws the folder tree at once, not at the next poll', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/sub\.indexOf\('\/annexes'\) === 0\) refreshTree\(\)/)
  })
  it('other outline calls do not reload the tree (only annexes change its counters)', () => {
    expect(body.match(/refreshTree\(/g)?.length).toBe(1)
  })
})
