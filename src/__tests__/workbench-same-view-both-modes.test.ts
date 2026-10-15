import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('manual and simple view draw the same document page (Boss TG 3245)', () => {
  it('the manual view no longer forces the check view on', () => {
    expect(src).not.toContain('dpForceCheck')
  })
  it('there is no check view at all: no switch, no preference, no extra marks on the work item (Boss TG 3431)', () => {
    expect(src).not.toContain('dpCheckView')
    expect(src).not.toContain('dp-check-toggle')
    expect(src).not.toContain('marveen.workbench.dpCheck')
  })
})
