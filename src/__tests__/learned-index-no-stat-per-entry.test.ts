import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #855: the dashboard froze 2-3 s because buildLearnedIndex ran a synchronous statSync for every directory entry on the
// slow depot disk. It must list with file types and stat only symlinks.
describe('buildLearnedIndex (#855)', () => {
  const src = readFileSync(new URL('../life-inbox-analyze.ts', import.meta.url), 'utf8')
  const start = src.indexOf('export function buildLearnedIndex')
  const body = src.slice(start, src.indexOf('\n}\n', start))

  it('lists directories with file types', () => {
    expect(body).toContain('readdirSync(absDir, { withFileTypes: true })')
  })

  it('stats only symlinks, not every entry', () => {
    expect(body).toContain('de.isSymbolicLink()')
    expect(body).not.toMatch(/try \{ st = statSync\(abs\) \} catch \{ continue \}\n\s+if \(st\.isDirectory/)
  })
})
