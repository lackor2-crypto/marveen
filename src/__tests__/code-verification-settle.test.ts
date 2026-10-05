// Boss (TG 2425): the Approvals page kept an hourglass for a VS Code verification whose bridge task had
// already ended in "worker stopped responding". A task that ended in error must close the row.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createApproval, createOrResetApprovalVerification, listApprovalVerifications } from '../db.js'
import { resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask, completeCodeTask } from '../web/code-bridge-store.js'
import { settleFailedCodeVerifications } from '../web/verification-sweep-job.js'

const APPROVAL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

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
    expect(settleFailedCodeVerifications(Date.now() + 1000)).toBe(0)
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
})
