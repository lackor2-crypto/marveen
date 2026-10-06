import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('Workbench tree root + layers (TG 2399/2402)', () => {
  it('the project is the root row of the tree and everything is one level deeper', () => {
    expect(js).toContain('wb-root-row')
    expect(js).toContain('walk(box, 1, null)')
    expect(js).toContain("data-wb-drop-box=\"1\"")
  })
  it('the panel upload only stores the file, it does not place it on the page', () => {
    expect(js).toContain('canvasDropImage(f, null, null, true)')
    expect(js).toContain('if (uploadOnly)')
  })
  it('there is a Layers tab with select and multi-move', () => {
    expect(js).toContain("['layers', '☰']")
    expect(js).toContain('fr-layer-sel')
    expect(js).toContain('pk.length > 1')
  })
  it('Layers rows have show/hide and forward/back, and a Format box sends one update per field (TG 2597)', () => {
    expect(js).toContain('fr-layer-vis')
    expect(js).toContain("op: 'order', id: act.getAttribute('data-wb-obj'), to: act.getAttribute('data-wb-arg')")
    expect(js).toContain('function frFormatHtml')
    expect(js).toContain("el.getAttribute('data-wb-act') !== 'fr-fmt'")
    for (const k of ['text_color', 'size', 'background', 'transparent', 'opacity']) expect(js).toContain('workbench.fr.fmt.' + k)
  })
})
