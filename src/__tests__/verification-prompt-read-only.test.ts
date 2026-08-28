// An approval-verification agent must never write to the live system.
//
// Measured incident, 2026-08-24: five agents were dispatched to verify the
// "forgot password" card. The dispatch prompt told them to "probald ki
// tenylegesen is amennyire tudod". For a password feature, "try it out" means
// pressing Save -- so dashboard_users.updated_at changed at 13:16:40, every
// auth session was invalidated, and the owner was logged out of the dashboard.
// The agent followed its instructions; the instructions were the defect.
//
// Both prompts have to carry the limit, because they are delivered as separate
// messages: the dispatch prompt (routes/approvals.ts) and the reminder that the
// sweep job sends later (verification-sweep-job.ts). A reminder that repeats
// only the reporting call would silently re-open the hole.
//
// This is a source-text assertion on purpose. The dispatch prompt moved into
// ../approval-verification-dispatch.ts when the fix mode was added (Boss
// 2026-08-24) -- so the assertion follows it there. What matters is unchanged:
// neither text can quietly drift back to "try it out for real", and the SECOND
// mode that module now knows how to build must not be able to launder write
// permission into the review prompt.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
import { buildVerificationPrompt } from '../approval-verification-dispatch.js'

const DISPATCH = join(PROJECT_ROOT, 'src', 'approval-verification-dispatch.ts')
const REMINDER = join(PROJECT_ROOT, 'src', 'web', 'verification-sweep-job.ts')

function read(path: string): string {
  return readFileSync(path, 'utf-8')
}

describe('verification prompts state the read-only limit', () => {
  it('the dispatch prompt says the check is read-only and names the forbidden verbs', () => {
    const text = read(DISPATCH)
    expect(text).toContain('CSAK-OLVASO ELLENORZES')
    expect(text).toContain('POST/PUT/PATCH/DELETE')
    // The wording that produced the incident must not come back.
    expect(text).not.toContain('probald ki tenylegesen')
  })

  it('the reminder repeats the limit, because it arrives as a separate message', () => {
    const text = read(REMINDER)
    expect(text).toContain('CSAK-OLVASO')
    expect(text).toContain('POST/PUT/PATCH/DELETE')
  })

  it('leaves exactly one writing call allowed: the verify-result report', () => {
    for (const path of [DISPATCH, REMINDER]) {
      const text = read(path)
      expect(text).toContain('verify-result')
    }
  })

  // The read-only guarantee is a property of the REVIEW mode, and the module
  // now builds two prompts. Asserted against the built strings, not the file
  // text, so a future edit cannot satisfy the file-level checks above while
  // handing the reviewer write permission.
  it('the built review prompt is read-only; only the fix prompt may write', () => {
    const common = {
      approvalId: 'x', category: 'c', actionDescription: 'd', agent: 'a',
      ownerName: 'o', tokenPath: '/t', baseUrl: 'http://localhost:1',
    } as const
    const review = buildVerificationPrompt({ ...common, mode: 'verify' })
    expect(review).toContain('CSAK-OLVASO ELLENORZES')
    expect(review).toContain('POST/PUT/PATCH/DELETE')
    expect(review).not.toContain('JAVITASI FELADAT')

    const fix = buildVerificationPrompt({ ...common, mode: 'fix' })
    expect(fix).not.toContain('CSAK-OLVASO')
  })
})
