// Wiring for the stale-verification sweep: real database, real agent
// directories, real inter-agent messages. The decision logic itself lives in
// ../approval-verification-sweep.ts so it can be unit-tested without any of
// this. Called once at dashboard startup (clears whatever a restart left in
// flight) and then on a timer.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import {
  createAgentMessage,
  listPendingVerificationsOlderThan,
  markVerificationReminded,
  markVerificationNoResponse,
  type ApprovalVerification,
} from '../db.js'
import { logger } from '../logger.js'
import { agentDir } from './agent-config.js'
import { runVerificationSweep, type VerificationSweepResult } from '../approval-verification-sweep.js'

/** How often the timer fires. Well under the 10 minute reminder threshold so
 *  a nudge is never delayed by a full sweep interval. */
export const VERIFICATION_SWEEP_INTERVAL_MS = 2 * 60 * 1000

function reminderPrompt(row: ApprovalVerification): string {
  const tokenPath = join(PROJECT_ROOT, 'store', '.dashboard-token')
  return [
    `Emlekezteto: kaptal egy ellenorzesi feladatot (jovahagyas ${row.approval_id}), es meg nem jelentetted vissza az eredmenyt.`,
    ``,
    `Egy panelben leirt valasz NEM szamit jelentesnek -- a rendszer csak ezt a hivast latja:`,
    `curl -s -X POST http://localhost:3420/api/approvals/${row.approval_id}/verify-result \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer $(cat ${tokenPath})" \\`,
    `  -d '{"agent":"${row.agent}","status":"pass","report":"rovid osszefoglalo"}'`,
    ``,
    `Ha nem tudod elvegezni (modell-hiba, nincs hozzaferes, barmi), akkor is jelentsd: status "fail", a report mezoben egy mondatban miert.`,
    `Ha hamarosan nem erkezik jelentes, a rendszer "nem valaszolt"-kent zarja le ezt a sort.`,
  ].join('\n')
}

export function sweepApprovalVerifications(now = Date.now()): VerificationSweepResult {
  const result = runVerificationSweep({
    now,
    listPendingOlderThan: listPendingVerificationsOlderThan,
    agentExists: (agent) => existsSync(agentDir(agent)),
    sendReminder: (row) => {
      try {
        createAgentMessage(MAIN_AGENT_ID, row.agent, reminderPrompt(row))
        return true
      } catch (err) {
        // A dead agent is exactly what this sweep is for -- log it and let the
        // row time out normally rather than failing the whole pass.
        logger.warn({ err, agent: row.agent, approvalId: row.approval_id }, 'Verification reminder could not be queued')
        return false
      }
    },
    markReminded: markVerificationReminded,
    markNoResponse: markVerificationNoResponse,
  })
  if (result.reminded.length || result.expired.length) {
    logger.info({ reminded: result.reminded.length, expired: result.expired.length }, 'Stale approval verifications swept')
  }
  return result
}
