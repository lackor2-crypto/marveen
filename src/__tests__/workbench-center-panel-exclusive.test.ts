// Boss TG 2926: the top-bar buttons (debate, documents, finalize) share ONE middle area. The button pressed last
// must be the one shown; an open debate panel used to cover the others (the debate won every time).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')

describe('workbench: the last pressed centre button wins', () => {
  it('opening the debate closes the documents and finalize panels', () => {
    const fn = SRC.slice(SRC.indexOf('function dbOpenPanel()'))
    const body = fn.slice(0, fn.indexOf('function dbResume'))
    expect(body).toMatch(/WB\.pdOpen = false;\s*WB\.shFinal = false/)
  })
  it('opening documents or finalize closes the debate', () => {
    expect(SRC).toMatch(/a === 'sh-final'\) \{[^}]*WB\.dbOpen = false/)
    expect(SRC).toMatch(/a === 'pd-open'\) \{[^}]*WB\.dbOpen = false/)
    expect(SRC).toMatch(/a === 'item-finalize'\) \{ WB\.dbOpen = false/)
  })
})
