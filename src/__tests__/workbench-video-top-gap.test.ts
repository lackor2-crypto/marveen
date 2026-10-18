// #704: a light gap between the header and the top of the video preview; the player gives up the same height.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('video preview top gap (#704)', () => {
  it('the player has an 8 px margin on top and its clamped height gives up the same 8 px', () => {
    expect(css).toContain('.wb-fr-center-vid .wb-fr-vid { flex: 0 0 auto; margin-top: 8px; height: clamp(220px, calc(46vh - 8px), 452px); }')
  })
  it('the phone height gives up the gap too, and the phone column stays overflow visible', () => {
    expect(css).toMatch(/@media \(max-width: 900px\) \{ \.wb-fr-center\.wb-fr-center-vid \{ overflow: visible; \} \.wb-fr-center-vid \.wb-fr-vid \{ height: calc\(40vh - 8px\); \} \}/)
  })
})
