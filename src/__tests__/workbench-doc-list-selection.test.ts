// #562: a list button over several selected paragraphs has ONE outcome for all of them, and a numbered list over
// paragraphs that follow each other is ONE list block (the PDF / Word number a block's lines 1, 2, 3).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')

describe('list buttons over a multi-paragraph selection', () => {
  it('the bullet and the numbered button go through one shared decision, not a toggle per paragraph', () => {
    expect(js).toContain('function dpToggleListOver(els, numbered)')
    expect(js).toContain("else if (f === 'list' || f === 'numlist') dpToggleListOver(pels, f === 'numlist')")
    expect(js).not.toContain("else if (f === 'list') pels.forEach")
    expect(js).not.toContain("else if (f === 'numlist') pels.forEach")
  })
  it('the list comes off only when every selected paragraph already is one; otherwise every paragraph becomes one', () => {
    expect(js).toContain('var turnOn = !listable.every(isOn)')
    expect(js).toContain('return isOn(x) !== turnOn')
  })
  it('neighbouring paragraphs become the lines of one numbered list block and the other rows go', () => {
    expect(js).toContain('dpNeighbour(last[last.length - 1], 1) === x')
    expect(js).toMatch(/\(i \+ 1\) \+ '\. ' \+ l/)
    expect(js).toContain('run.slice(1).forEach(function (x) { dpDropRow(x) })')
  })
})
