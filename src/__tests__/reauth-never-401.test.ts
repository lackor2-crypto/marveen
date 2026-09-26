// Card #410 (owner, TG 6587, 2026-09-26): the emergency kit's Show / Download
// buttons signed the owner OUT of the dashboard. The kit asks for the
// dashboard password again; an empty or wrong one answered 401, and the
// dashboard's fetch wrapper (web/app.js) treats every /api 401 as "session
// gone": it drops the token and shows the login. The session was fine.
//
// Rule pinned here: a route that asks for the password AGAIN on a valid
// session answers a wrong/missing password with 403, never 401. The route
// tests (backup-routes, backup-restore-routes, auth-routes) check the status
// by calling the handlers; this test keeps the reason next to the wrapper.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('re-typed password never answers 401 (#410)', () => {
  it('the dashboard still signs out on any /api 401 -- which is why re-auth must not use it', () => {
    expect(read('web/app.js')).toMatch(/res\.status === 401 && isSameOriginApi/)
  })

  for (const [file, pattern] of [
    ['src/web/routes/backup.ts', /fail\(ctx, 401, 'password_(required|wrong)'\)/],
    ['src/web/routes/backup-restore.ts', /fail\(ctx, 401, confirmed\)/],
    ['src/web/routes/auth.ts', /INVALID_CREDENTIALS[^\n]*,\s*401\)[\s\S]{0,40}\/\/ ?current/],
  ] as const) {
    it(file + ': no 401 for the re-typed password', () => {
      expect(read(file)).not.toMatch(pattern)
    })
  }

  it('the kit panel does not even ask the server with an empty password box', () => {
    const src = read('web/backup.js')
    const fetchKit = src.slice(src.indexOf('async function fetchKit'), src.indexOf('function kitText'))
    expect(fetchKit).toMatch(/!pwEl\.value/)
    expect(fetchKit).toContain("tr('fbk.kit.pw_needed')")
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) expect(read(f)).toContain('"fbk.kit.pw_needed"')
  })
})
