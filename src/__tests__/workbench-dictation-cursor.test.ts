// Card #468: dictation goes AT THE CURSOR and nothing the user saw is wiped on stop.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchHarness } from './helpers/workbench-harness.js'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
type D = { before: string; after: string }
const compose = (d: D, parts: string[]) => {
  const h = workbenchHarness()
  return (h.win as unknown as { _wbDictCompose: (d: D, p: string[]) => { value: string; caret: number } })._wbDictCompose(d, parts)
}

describe('dictation: insert at the cursor', () => {
  it('puts the words between the text left and right of the cursor, caret right after them', () => {
    expect(compose({ before: 'ELEJE ', after: 'VEGE' }, ['szia'])).toEqual({ value: 'ELEJE szia VEGE', caret: 'ELEJE szia'.length })
  })
  it('adds a space before the words when the cursor sits right after a word, and none at the very start', () => {
    expect(compose({ before: 'ELEJE', after: '' }, ['szia', 'vilag']).value).toBe('ELEJE szia vilag')
    expect(compose({ before: '', after: 'VEGE' }, ['szia']).value).toBe('szia VEGE')
  })
  it('nothing said leaves the text exactly as it was (a selection is only replaced once words come)', () => {
    expect(compose({ before: 'a ', after: 'b' }, ['', '  ']).value).toBe('a b')
  })
})

describe('dictation: stop keeps the late words', () => {
  it('onresult still accepts results while the dictation is stopping, and onend re-applies the final text', () => {
    expect(js).toContain('if (WB.dict !== d && !(d.stopping && !WB.dict)) return')
    expect(js).toContain('dictApply(d, d.finals)')
    expect(js).not.toContain('dictJoin(d.base')
  })
})
