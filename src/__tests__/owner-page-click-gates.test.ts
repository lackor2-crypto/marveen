import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf8')

describe('owner content buttons work for a page opened with the token only (TG 3936)', () => {
  it('defines one shared rule: a session OR a same-origin page click', () => {
    expect(SRC).toMatch(/function isOwnerOrPageClick\(ctx: RouteContext\): boolean \{\s*return isOwnerClick\(ctx\) \|\| isBrowserPageClick\(ctx\)/)
  })
  it('claim confirm, rewrite accept/dismiss, consistency ack, deadline to-do and source review use it', () => {
    for (const marker of ["sub === 'claims'", "segs[4] === 'rewrite'", "segs[4] === 'ack'", "'deadline_owner_only'", 'recordReview(']) {
      const i = SRC.indexOf(marker)
      expect(i, marker).toBeGreaterThan(0)
      expect(SRC.slice(Math.max(0, i - 200), i + 700), marker).toContain('isOwnerOrPageClick(ctx)')
    }
  })
  it('finalising, the sensitive switch and the court rules keep the strict session rule', () => {
    expect(SRC).toMatch(/if \(!isOwnerClick\(ctx\)\) return fail\(res, 403, 'outline_finalize_owner_only'/)
    expect(SRC).toMatch(/sensitive'\] === false && !isOwnerClick\(ctx\)\) return fail\(res, 403, 'privacy_owner_only'/)
  })
})
