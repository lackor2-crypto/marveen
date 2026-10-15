// Boss TG 2931: after "start" the first round shows nothing but a greyed button (the running line lived only in the
// session view, which exists once the first answer is back). The setup view must say the round is running.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')

describe('debate: the first round says it is running', () => {
  it('the setup view prints the running line while busy', () => {
    expect(SRC).toMatch(/if \(s\.busy\) out \+= '<p class="wb-db-busy" role="status">' \+ esc\(t\('workbench\.db\.running', \{ n: 1 \}\)\)/)
  })
})
