// Boss (TG 2425): the Approvals page kept an hourglass for a VS Code verification whose bridge task had
// already ended in "worker stopped responding". A task that ended in error must close the row.
// #499 follow-up: a task that ran to the end (or was stopped) WITHOUT a report spun the same 4-hour
// hourglass, and the sweep's call site was never exercised -- only the helper was.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
import { initDatabase, createApproval, createOrResetApprovalVerification, listApprovalVerifications, resolveApprovalVerification } from '../db.js'
import { resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask, completeCodeTask, cancelCodeTask } from '../web/code-bridge-store.js'
import { settleFailedCodeVerifications, sweepApprovalVerifications, TASK_ENDED_REPORT_GRACE_MS } from '../web/verification-sweep-job.js'

const APPROVAL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AFTER_GRACE = TASK_ENDED_REPORT_GRACE_MS + 1000

function setup(): void {
  upsertCodeSession({ project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
  createApproval({ id: APPROVAL, agent_id: 'x', category: 'kanban_done', action_description: 'Kartya: valami' })
  createOrResetApprovalVerification(APPROVAL, 'code:marvin', 'verify')
  enqueueCodeTask({ project: 'marvin', prompt: `verify ${APPROVAL}`, requestedBy: 'code:marvin' })
}
const row = () => listApprovalVerifications(APPROVAL)[0]!

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

describe('settleFailedCodeVerifications', () => {
  it('keeps the row pending while the task is queued or running', () => {
    setup()
    expect(settleFailedCodeVerifications(Date.now() + 1000)).toBe(0)
    claimNextCodeTask('w')
    expect(settleFailedCodeVerifications(Date.now() + AFTER_GRACE)).toBe(0)
    expect(row().status).toBe('pending')
  })

  it('closes the row when the task ended in an error', () => {
    setup()
    const t = claimNextCodeTask('w')!
    completeCodeTask(t.id, { ok: false, error: 'worker stopped responding after 3 attempt(s)' })
    expect(settleFailedCodeVerifications(Date.now() + 1000)).toBe(1)
    expect(row().status).toBe('noresponse')
    expect(row().report).toBe('noresponse:worker_error')
  })

  it('a task that ran to the end without a report closes the row after the grace, as task_ended', () => {
    setup()
    const t = claimNextCodeTask('w')!
    const finished = Date.now()
    completeCodeTask(t.id, { ok: true, result: 'Standing by for the background test run.' }, finished)
    // The report may still be on its way for a moment.
    expect(settleFailedCodeVerifications(finished + 1000)).toBe(0)
    expect(row().status).toBe('pending')
    expect(settleFailedCodeVerifications(finished + AFTER_GRACE)).toBe(1)
    expect(row().status).toBe('noresponse')
    expect(row().report).toBe('noresponse:task_ended')
  })

  it('a stopped task is task_ended, not "stopped with an error"', () => {
    setup()
    const t = claimNextCodeTask('w')!
    const stopped = Date.now()
    cancelCodeTask(t.id, stopped)
    expect(settleFailedCodeVerifications(stopped + AFTER_GRACE)).toBe(1)
    expect(row().report).toBe('noresponse:task_ended')
  })

  it('a reported task is left alone', () => {
    setup()
    const t = claimNextCodeTask('w')!
    resolveApprovalVerification(APPROVAL, 'code:marvin', 'pass', 'ok')
    completeCodeTask(t.id, { ok: true, result: 'done' })
    expect(settleFailedCodeVerifications(Date.now() + AFTER_GRACE)).toBe(0)
    expect(row().status).toBe('pass')
  })

  it('the newest task decides: a re-run that is still queued keeps the row pending', () => {
    setup()
    const t = claimNextCodeTask('w')!
    completeCodeTask(t.id, { ok: false, error: 'worker stopped responding after 3 attempt(s)' })
    enqueueCodeTask({ project: 'marvin', prompt: `verify again ${APPROVAL}`, requestedBy: 'code:marvin', force: true })
    expect(settleFailedCodeVerifications(Date.now() + AFTER_GRACE)).toBe(0)
    expect(row().status).toBe('pending')
  })

  it('a task from an earlier round (before the row was re-requested) does not close the new round', () => {
    setup()
    const t = claimNextCodeTask('w')!
    completeCodeTask(t.id, { ok: false, error: 'boom' })
    // Re-dispatch a second later: the row gets a fresh requested_at, the old task is history.
    const later = Date.now() + 5000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      createOrResetApprovalVerification(APPROVAL, 'code:marvin', 'fix')
    } finally {
      clock.mockRestore()
    }
    expect(settleFailedCodeVerifications(later + AFTER_GRACE)).toBe(0)
    expect(row().status).toBe('pending')
  })

  it('a late report from a still-running orphan session overrides the settled row', () => {
    setup()
    const t = claimNextCodeTask('w')!
    completeCodeTask(t.id, { ok: false, error: 'worker stopped responding after 3 attempt(s)' })
    settleFailedCodeVerifications(Date.now() + 1000)
    expect(row().status).toBe('noresponse')
    expect(resolveApprovalVerification(APPROVAL, 'code:marvin', 'pass', 'late but real')).toBe(true)
    expect(row().status).toBe('pass')
  })
})

describe('the 30-second sweep actually runs the settle step', () => {
  it('sweepApprovalVerifications closes an errored VS Code row', async () => {
    setup()
    const t = claimNextCodeTask('w')!
    completeCodeTask(t.id, { ok: false, error: 'worker stopped responding after 3 attempt(s)' })
    await sweepApprovalVerifications(Date.now() + 1000)
    expect(row().status).toBe('noresponse')
    expect(row().report).toBe('noresponse:worker_error')
  })
})

describe('the Approvals page explains both endings, in both languages', () => {
  const APP = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')

  it('renders the explanation line under the row for both reason codes', () => {
    expect(APP).toMatch(/v\.report === 'noresponse:worker_error' \|\| v\.report === 'noresponse:task_ended'/)
    expect(APP).toContain("if (v.report === 'noresponse:worker_error') return t('approvals.verify.noresponse_worker_error')")
    expect(APP).toContain("if (v.report === 'noresponse:task_ended') return t('approvals.verify.noresponse_task_ended')")
  })

  it('both strings exist in hu and en and point at the Re-verify button by its own label', async () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
    await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
    await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
    const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
    for (const lang of ['hu', 'en'] as const) {
      const rerun = i18n[lang]['approvals.verify.rerun_btn']!
      for (const key of ['approvals.verify.noresponse_worker_error', 'approvals.verify.noresponse_task_ended']) {
        expect(i18n[lang][key]).toBeTruthy()
        expect(i18n[lang][key]).toContain(`"${rerun}"`)
      }
    }
  })
})
