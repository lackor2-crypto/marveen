// The "Google refused this address" walkthrough (2026-08-14).
//
// MEASURED cause: the OAuth app is in "Testing" publishing status, so Google
// answers 403 access_denied to any address that is not on the Test users list,
// and refresh tokens it does hand out die after 7 days (invalid_grant). Both
// are fixed in the Cloud Console, not in Marveen -- so the dashboard's only
// job is to notice, explain, and link. The classifier that notices lives in
// google-accounts.ts and is covered by google-accounts-parse.test.ts; what is
// guarded here are the two properties of the PAGE that are easy to break in a
// later refactor and impossible to catch by reading a diff:
//
//   1. the walkthrough is reachable WITHOUT a failure having been detected
//      (the operator is often staring at a stalled flow, not an error), and
//   2. re-authorizing an existing address reuses its own token slot.
//
// Both are source-level assertions in the style of
// refactor-config-widget-index.test.ts: web/app.js is a classic script with no
// module boundary, so grepping it is the only way to pin an invariant.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const html = readFileSync(join(REPO_ROOT, 'web', 'index.html'), 'utf8')
const app = readFileSync(join(REPO_ROOT, 'web', 'app.js'), 'utf8')

describe('the 403 walkthrough is reachable on its own', () => {
  it('the opener button exists and is not hidden', () => {
    const m = html.match(/<button[^>]*id="gconnBlockedToggle"[^>]*>/)
    expect(m, 'gconnBlockedToggle is gone').not.toBeNull()
    expect(m![0]).not.toMatch(/\bhidden\b/)
  })

  it('the opener sits OUTSIDE the auth flow box, so a stalled flow does not bury it', () => {
    const toggle = html.indexOf('id="gconnBlockedToggle"')
    const flow = html.indexOf('id="gconnFlow"')
    expect(toggle).toBeGreaterThan(-1)
    expect(flow).toBeGreaterThan(-1)
    expect(toggle, 'the toggle must come before (not inside) #gconnFlow').toBeLessThan(flow)
  })

  it('the panel itself starts hidden and reuses the class that survives [hidden]', () => {
    const m = html.match(/<div[^>]*id="gconnBlocked"[^>]*>/)
    expect(m).not.toBeNull()
    // claude-auth-flow is display:flex, which outranks the UA [hidden] rule --
    // the pair is only correct together (hidden-attribute-css-contract.test.ts).
    expect(m![0]).toMatch(/class="[^"]*claude-auth-flow/)
    expect(m![0]).toMatch(/\bhidden\b/)
  })

  it('the console link carries no baked-in project id (it is filled in at runtime)', () => {
    const m = html.match(/<a[^>]*id="gconnConsoleLink"[^>]*>/)
    expect(m).not.toBeNull()
    expect(m![0]).toContain('https://console.cloud.google.com/auth/audience')
    expect(m![0], 'project must come from /api/connections/google, not the markup').not.toContain('?project=')
    expect(app).toContain('_gconnApplyProjectId')
  })
})

describe('re-authorizing an existing address reuses its slot', () => {
  it('a known account id is posted as `id`, an unknown name as `name`', () => {
    // POST /api/connections/google/login de-duplicates a `name` against the
    // accounts on file, so sending the name of an EXISTING account would
    // authorize `munka_2` and leave the broken `munka` in place.
    expect(app).toMatch(/_gconnKnownIds\.has\(name\)\s*\?\s*\{\s*id:\s*name\s*\}\s*:\s*\{\s*name\s*\}/)
  })

  it('the known-id set is refreshed from the rendered account list', () => {
    expect(app).toMatch(/_gconnKnownIds\s*=\s*new Set\(\(accounts \|\| \[\]\)\.map\(a => a\.id\)\)/)
  })
})
