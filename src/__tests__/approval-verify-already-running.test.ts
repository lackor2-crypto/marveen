// Boss, 2026-09-29: restarting a verification that is already running silently
// reset it under whoever was doing it, and the UI had no "Mégis" (start anyway)
// button. The server now answers 409 already_running unless force:true, and the
// picker turns its button into "Mégis újraindítom".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'

const route = readFileSync(join(PROJECT_ROOT, 'src/web/routes/approvals.ts'), 'utf8')
const app = readFileSync(join(PROJECT_ROOT, 'web/app.js'), 'utf8')

describe('already-running verification guard', () => {
  it('server refuses a restart of a pending run unless force is true', () => {
    expect(route).toContain('busyVerificationAgents(approvalId, agents)')
    expect(route).toContain("body.force !== true")
    expect(route).toContain("error: 'already_running'")
  })

  it('the guard runs before any row is reset', () => {
    expect(route.indexOf("error: 'already_running'")).toBeLessThan(route.indexOf('createOrResetApprovalVerification(approvalId, agent, mode)'))
  })

  it('picker sends force and shows the Mégis button on 409', () => {
    expect(app).toContain('force }),')
    expect(app).toContain("result.error === 'already_running'")
    expect(app).toContain("t('approvals.verify.busy_anyway')")
  })

  it('both languages have the button text', () => {
    for (const l of ['hu', 'en']) {
      expect(readFileSync(join(PROJECT_ROOT, `web/lang/${l}.js`), 'utf8')).toContain("'approvals.verify.busy_anyway'")
    }
  })
})
