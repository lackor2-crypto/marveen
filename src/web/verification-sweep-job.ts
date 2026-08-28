// Wiring for the stale-verification sweep: real database, real agent
// directories, real inter-agent messages. The decision logic itself lives in
// ../approval-verification-sweep.ts so it can be unit-tested without any of
// this. Called once at dashboard startup (clears whatever a restart left in
// flight) and then on a timer.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, WEB_PORT } from '../config.js'
import {
  createAgentMessage,
  getPendingMessages,
  listPendingVerificationsOlderThan,
  markVerificationReminded,
  markVerificationNoResponse,
  type ApprovalVerification,
} from '../db.js'
import { logger } from '../logger.js'
import { agentDir, readAgentRemoteHost } from './agent-config.js'
import {
  runVerificationSweep,
  type AgentActivity,
  type VerificationSweepResult,
} from '../approval-verification-sweep.js'
import { verificationSender } from './routes/approvals.js'
import { isMainChannelsAgent, MAIN_CHANNELS_SESSION } from './main-agent.js'
import { agentSessionName, capturePane, isSessionReadyForPrompt, sessionExistsOnHost } from './agent-process.js'
import { codeBridgeProjectOf } from '../approval-verification-dispatch.js'
import { getCodeSession } from './code-bridge-store.js'

/**
 * How often the timer fires. Boss, 2026-08-28: "figyelni kellene hogy milyen
 * statuszban van, es ha varakozoban, akkor mehet neki a kovetkezo!" -- so the
 * tick has to be short enough that "went idle" turns into "got the reminder"
 * inside about a minute. It used to be two minutes, which on its own added up
 * to twelve minutes of waiting for an agent that finished in one.
 *
 * A short tick is cheap here BECAUSE the expensive part is gated: the pane is
 * only read when the query actually returned a pending row past the grace
 * window. On an empty board (a fresh install, or simply nothing dispatched)
 * this is one indexed SELECT that returns nothing, and no tmux call at all.
 */
export const VERIFICATION_SWEEP_INTERVAL_MS = 30 * 1000

function reminderPrompt(row: ApprovalVerification): string {
  const tokenPath = join(PROJECT_ROOT, 'store', '.dashboard-token')
  return [
    `Emlekezteto: kaptal egy ellenorzesi feladatot (jovahagyas ${row.approval_id}), es meg nem jelentetted vissza az eredmenyt.`,
    ``,
    `Egy panelben leirt valasz NEM szamit jelentesnek -- a rendszer csak ezt a hivast latja:`,
    `curl -s -X POST http://localhost:${WEB_PORT}/api/approvals/${row.approval_id}/verify-result \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer $(cat ${tokenPath})" \\`,
    `  -d '{"agent":"${row.agent}","status":"pass","report":"rovid osszefoglalo"}'`,
    ``,
    `Emlekezteto a hatarra is: az ellenorzes CSAK-OLVASO -- ezen az egy verify-result hivason kivul semmilyen iro (POST/PUT/PATCH/DELETE) hivast ne inditsd az elo rendszeren.`,
    `Ha nem tudod elvegezni (modell-hiba, nincs hozzaferes, barmi), akkor is jelentsd: status "fail", a report mezoben egy mondatban miert.`,
    `Ha hamarosan nem erkezik jelentes, a rendszer "nem valaszolt"-kent zarja le ezt a sort.`,
  ].join('\n')
}

/**
 * Az agens PILLANATNYI allapota, harom ertekkel. A harmadik nem luxus: az
 * `isSessionReadyForPrompt` magaban `false`-t ad a "dolgozik" es a "nem tudtam
 * elolvasni a panelt" esetre EGYARANT, es a kettot osszemosni pontosan az a
 * hiba, amit ez a kartya tilt -- a nulla (vagy itt: a false) ket dolgot
 * jelenthet, es a forrast kell megkerdezni, nem a talalatbol kovetkeztetni.
 *
 * Ezert kulon lepesekben:
 *   nincs munkamenet / nem olvashato a pane  -> 'unknown' (naplozzuk)
 *   olvashato es tetlen                       -> 'idle'
 *   olvashato es nem tetlen                   -> 'busy'
 */
async function probeAgentActivity(agent: string): Promise<AgentActivity> {
  // A kod-hid executornak nincs panelje, amit el lehetne olvasni -- rola
  // sosem allitjuk, hogy tetlen. (Nudge-ot amugy sem kap, lasd sendReminder.)
  if (codeBridgeProjectOf(agent) !== null) return 'unknown'

  const isMain = isMainChannelsAgent(agent)
  const session = isMain ? MAIN_CHANNELS_SESSION : agentSessionName(agent)
  const host = isMain ? null : readAgentRemoteHost(agent)

  // Nem fut a munkamenete: az agens LETEZIK (azt az agentExists dontötte el),
  // csak epp nincs elinditva. Ez nem tetlenseg es nem is munka -- nem latunk
  // oda. Az emlekezteto ilyenkor is bekerulhet a postaladajaba a lassu utem
  // szerint, es a router kikezbesiti, amikor elindul.
  if (!sessionExistsOnHost(host, session)) return 'unknown'
  if (capturePane(session, host) == null) return 'unknown'

  return (await isSessionReadyForPrompt(session, host)) ? 'idle' : 'busy'
}

/** Egy forduló ne induljon el, amig az elozo fut. A pane-olvasas
 *  masodpercekbe kerul agensenkent, a timer viszont 30 masodpercenkent uti --
 *  atfedo fordulok eseten ket sopres egyszerre olvasna ugyanazt a panelt, es
 *  egymas melle sorolna ket emlekeztetot. (A tarolo ezt amugy is elutasitana,
 *  de a felesleges tmux-hivasokat mar itt megsporoljuk.) */
let sweepInFlight = false

const EMPTY_RESULT: VerificationSweepResult = { reminded: [], expired: [], unreadable: [] }

export async function sweepApprovalVerifications(now = Date.now()): Promise<VerificationSweepResult> {
  if (sweepInFlight) return EMPTY_RESULT
  sweepInFlight = true
  try {
    return await sweepOnce(now)
  } finally {
    sweepInFlight = false
  }
}

async function sweepOnce(now: number): Promise<VerificationSweepResult> {
  const result = await runVerificationSweep({
    now,
    listPendingOlderThan: listPendingVerificationsOlderThan,
    // A foagensnek NINCS agents/<nev>/ mappaja (merve: agents/lackor2-bot nem
    // letezik), ezert a mappa-teszt rola azt allitotta volna, hogy "az ugynok
    // mar nem letezik", es 10 perc utan minden ellenorzeset lezarta volna --
    // mikozben Marvin el es epp dolgozik. Rola a sajat forrasat kerdezzuk: fut-e
    // a channels munkamenete.
    agentExists: (agent) => {
      // A VS Code executor (`code:<alias>`) has no agents/<name> directory, so
      // the folder test would have called EVERY code-bridge row "the agent no
      // longer exists" ten minutes after dispatch -- the exact class of lie
      // this sweep was written to stop telling about the main agent. Ask the
      // bridge instead: a project that is still registered can still answer.
      const codeProject = codeBridgeProjectOf(agent)
      if (codeProject !== null) return getCodeSession(codeProject) !== null
      return isMainChannelsAgent(agent)
        ? sessionExistsOnHost(null, MAIN_CHANNELS_SESSION)
        : existsSync(agentDir(agent))
    },
    sendReminder: (row) => {
      // A code-bridge row cannot be nudged: there is no inbox to put a message
      // in, and re-queueing the task would make the executor do the work a
      // second time -- for a 'fix' that means applying the same change twice.
      // So it is left to time out normally ('noresponse:timeout'), which is the
      // honest outcome: the task was handed over and no report came back.
      if (codeBridgeProjectOf(row.agent) !== null) {
        logger.info({ agent: row.agent, approvalId: row.approval_id }, 'Code-bridge verification not nudged (no inbox); left to time out')
        return false
      }
      try {
        // Same sender rule as the dispatch path: the main agent must not be
        // nudged by a message that appears to come from itself.
        createAgentMessage(verificationSender(row.agent), row.agent, reminderPrompt(row))
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
    probeActivity: probeAgentActivity,
    // A router magatol kivarja a tetlenseget bekuldes elott, tehat egy mar
    // sorban allo emlekezteto ugyis kikezbesitodik -- masodikat betenni
    // melle csak zaj lenne.
    hasUndeliveredMessage: (agent) => {
      try {
        return getPendingMessages(agent).length > 0
      } catch (err) {
        // Nem tudtuk megnezni. Ilyenkor NE kuldjunk: a felesleges csend
        // olcsobb, mint a duplan bekuldott feladat.
        logger.warn({ err, agent }, 'Could not read pending inbox before nudging; skipping this pass')
        return true
      }
    },
  })
  if (result.reminded.length || result.expired.length) {
    logger.info({ reminded: result.reminded.length, expired: result.expired.length }, 'Stale approval verifications swept')
  }
  // Kulon sor, es akkor is, ha semmi mas nem tortent: "nem lattam oda" nem
  // ugyanaz, mint "nincs teendo". Enelkul egy elerhetetlen gep miatt allo
  // ellenorzes csendben varna ki a negy orat.
  if (result.unreadable.length) {
    logger.warn({ rows: result.unreadable.length }, 'Verification sweep could not read some agents\' state (not idle, not busy -- unreadable)')
  }
  return result
}
