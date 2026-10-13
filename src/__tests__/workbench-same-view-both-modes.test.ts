import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('manual and simple view draw the same document page (Boss TG 3245)', () => {
  it('the manual view no longer forces the check view on', () => {
    expect(src).not.toContain('dpForceCheck')
  })
  it('the check view is on unless the user switched it off', () => {
    expect(src).toContain("localStorage.getItem('marveen.workbench.dpCheck') !== '0'")
  })
})
