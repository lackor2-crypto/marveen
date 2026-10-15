import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync('web/workbench.js', 'utf8')
const css = readFileSync('web/workbench.css', 'utf8')

describe('workbench zoom slider', () => {
  it('persists the chosen zoom and restores it', () => {
    expect(js).toContain("'marveen.workbench.frZoom'")
    expect(js).toContain('frZoom: frZoomLoad()')
    expect(js).not.toMatch(/WB\.frZoom = FR_ZOOM_DEFAULT/)
  })
  it('applies the zoom live to both the scrolling and the fixed frame', () => {
    expect(js).toContain(".wb-fr-scroll, .wb-fr-fixed")
    expect(js).toContain('frZoomSave(v)')
  })
  it('scales the paged document page', () => {
    expect(css).toMatch(/\.wb-fr-scroll \.wb-dp-wrap[^{]*\{ zoom: var\(--wb-zoom/)
  })
})
