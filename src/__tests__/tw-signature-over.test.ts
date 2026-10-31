import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const CSS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('signature in the translation column (TG 3915)', () => {
  it('a free picture (o=1) is drawn as the same zero-height anchor as on the work item page', () => {
    const i = JS.indexOf('function twBlockHtml')
    const body = JS.slice(i, i + 1600)
    expect(body).toContain('if (pic.over)')
    expect(body).toContain('class="wb-tw-over"')
    expect(body).toContain('--wb-ox:')
    expect(body).toContain('--wb-oy:')
    expect(body).toContain('--wb-ow:')
  })

  it('the anchor takes no room and places the picture from its own corner, in percent of the column width', () => {
    expect(CSS).toMatch(/\.wb-tw-over \{ height: 0; position: relative; \}/)
    expect(CSS).toContain('.wb-tw-over > .wb-tw-img { position: absolute; left: 0; top: 0;')
    expect(CSS).toContain('var(--wb-oy) / 100')
    expect(CSS).toContain('var(--wb-ox) / 100')
  })
})
