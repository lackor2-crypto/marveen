import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('Simple view zoom slider on text documents (card #466)', () => {
  it('the scrolling document area carries --wb-zoom from the first render', () => {
    expect(js).toContain(`'<div class="wb-fr-scroll" style="--wb-zoom:' + zoom + '">'`)
  })
  it('the slider handler writes --wb-zoom onto that same area', () => {
    expect(js).toMatch(/querySelector\('\.wb-fr-scroll'\)[\s\S]{0,200}setProperty\('--wb-zoom'/)
  })
  it('text (rendered markdown, plain text, the editor) scales with it, without transform', () => {
    expect(css).toMatch(/\.wb-fr-scroll \.wb-md-live[^{]*\{\s*zoom: var\(--wb-zoom, 1\)/)
    expect(css).toMatch(/\.wb-fr-scroll \.wb-text-edit \{\s*font-size: calc\(0\.9rem \* var\(--wb-zoom, 1\)\)/)
    expect(css).not.toMatch(/\.wb-fr-scroll[^{]*\{[^}]*transform:\s*scale/)
  })
})
