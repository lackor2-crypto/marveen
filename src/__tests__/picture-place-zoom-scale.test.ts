import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Boss TG 5100: at editor zoom 90% a dropped picture sat a little higher after the save. The drop is measured in screen
// pixels (getBoundingClientRect), so the divisor (text width) must be screen pixels too: scaled by rect / offset width.
const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')
const start = js.indexOf('function dpOverPlace(')
const body = js.slice(start, js.indexOf('\n  }\n', start))

describe('dpOverPlace reads the drop at any zoom', () => {
  it('the page branch scales the text width and the left edge by the page zoom', () => {
    expect(body).toContain('pr.width / page.offsetWidth')
    expect(body).toContain('full = Math.max(1, full * sc)')
  })
  it('the translation column branch scales its width by the column zoom', () => {
    expect(body).toContain('ar.width / anc.offsetWidth')
    expect(body).toContain('(anc.clientWidth || 1) * scT')
  })
})
