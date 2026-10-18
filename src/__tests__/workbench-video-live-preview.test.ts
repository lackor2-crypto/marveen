// #669: the live preview in the player must know every look the ffmpeg render knows, and must fade/zoom from the same fields.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOOK_FILTERS } from '../workbench-video-render.js'

const src = readFileSync(resolve(__dirname, '../../web/workbench.js'), 'utf8')

describe('video live preview (#669)', () => {
  it('has a CSS twin for every ffmpeg look', () => {
    const m = /var VT_LOOK_CSS = \{([\s\S]*?)\n  \}/.exec(src)
    expect(m).not.toBeNull()
    const keys = [...m![1]!.matchAll(/^\s+(\w+):/gm)].map((x) => x[1]).sort()
    expect(keys).toEqual(Object.keys(LOOK_FILTERS).sort())
  })

  it('drives the player from the clip fields the render uses', () => {
    for (const f of ['c.speed', 'c.rot', 'c.flip', 'c.zoom', 'c.panX', 'c.panY', 'c.fadeIn', 'c.fadeOut', 'doc.background', 'doc.aspect']) {
      expect(src).toContain(f)
    }
  })

  it('moves on to the next clip by itself when a clip ends while playing', () => {
    expect(src).toContain('WB.vtAutoplay = nx.id')
    expect(src).toContain('WB.vtAutoplay === c.id')
  })
})
