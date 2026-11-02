import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

function fn(name: string, len = 2600): string {
  const i = JS.indexOf('function ' + name + '(')
  expect(i).toBeGreaterThan(0)
  return JS.slice(i, i + len)
}

// #837 (Boss TG 4408): the signature (free, over the text) dropped above a line of the German translation jumped back to
// the bottom, because the column only ever measured from the picture's own anchor (y >= 0). The work item page re-anchors
// the picture to the line under the drop; the column must do the same, through the one shared drag path.
describe('a free picture can be put over any line, in the translation column too (#837)', () => {
  it('dpOverPlace picks the line under the drop in the column (not only the picture\'s own anchor)', () => {
    const body = fn('dpOverPlace', 2200)
    const tw = body.slice(0, body.indexOf('var page = box.closest'))
    expect(tw).toContain('twOverAnchor(bid, tbr)')
    expect(tw).toContain('el: tel')
    expect(tw).toContain('tbr.top - er.top')
  })

  it('twOverAnchor takes the last line whose top is at or above the drop, the first one above everything, never its own island', () => {
    const body = fn('twOverAnchor', 1200)
    expect(body).toContain('el === own')
    expect(body).toContain('r.top <= tbr.top + 0.5')
    expect(body).toContain('return anchor || first')
    expect(body).toContain('!(r.height > 0)')
  })

  it('twPicMove puts the island right before that line, so twCollect saves the new order', () => {
    const body = fn('twPicMove', 900)
    expect(body).toContain('host.insertBefore(isl, el)')
    expect(body).toContain("isl.setAttribute('data-tw-sec', sec)")
  })

  it('both ways of putting a picture over the text (drag, "Szabadon" mode switch) move the island before the PATCH', () => {
    const drag = fn('dpOverDragStart', 2200)
    expect(drag.indexOf('if (at.el) twPicMove(bid, at.el)')).toBeGreaterThan(0)
    expect(drag.indexOf('if (at.el) twPicMove')).toBeLessThan(drag.indexOf("dpCall('PATCH'"))
    const mode = fn('dpImageMode', 2200)
    expect(mode.indexOf('if (at && at.el) twPicMove(bid, at.el)')).toBeGreaterThan(0)
    expect(mode.indexOf('twPicMove')).toBeLessThan(mode.indexOf("dpCall('PATCH', '/blocks/' + encodeURIComponent(bid), body)"))
  })

  it('the work item page keeps re-anchoring to the row under the drop (the Hungarian draft)', () => {
    const body = fn('dpOverPlace', 3200)
    expect(body).toContain("r.getBoundingClientRect().top <= br.top + 0.5")
    expect(body).toContain('pos: pos')
  })
})
