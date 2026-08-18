// Az "Újraindítás" gombok vegpontjai.
//
//   - GET  /api/system/restart      -- meg lehet-e nyomni, es mi indulna ujra
//   - POST /api/system/restart      -- indul (CSAK a vezerlopult)
//   - GET  /api/system/restart-all  -- a "mindent ujraindit" TERVE (mi indulna
//                                      ujra, es ki dolgozik eppen)
//   - POST /api/system/restart-all  -- a terv vegrehajtasa
//
// A GET egyben a "mar visszajott?" kopogtato is: a felulet az ujrainditas utan
// ezt hivogatja, es amint valaszol, tudja, hogy a vezerlopult ismet el. Ezert
// szandekosan olcso es halozatmentes.
//
// A tenyleges vedelem (mit szabad ujrainditani) nem itt van, hanem a
// src/self-restart.ts-ben es a src/restart-all.ts-ben -- ott is olvashato,
// miert nem nyul soha egyik ut sem a csatorna-szolgaltatashoz (a kozos tmux
// szerver miatt).
import { json } from '../http-helpers.js'
import { restartAvailability, performSelfRestart } from '../../self-restart.js'
import {
  buildRestartAllPlan,
  executeRestartAllPlan,
  type AgentSnapshot,
} from '../../restart-all.js'
import { listAgentNames, readAgentDisplayName, readAgentRemoteHost } from '../agent-config.js'
import { restartAgentProcess, isAgentRunning, agentSessionName, capturePane } from '../agent-process.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { detectPaneState } from '../../pane-state.js'
import { MAIN_AGENT_ID, currentBotName } from '../../config.js'
import type { RouteContext } from './types.js'

// Mikor indult EZ a folyamat? Ebbol tudja a felulet, hogy tenyleg ujraindult-e
// a vezerlopult -- kulonben a gomb megnyomasa utan a MEG FUTO regi folyamat
// valaszolna, es a felulet "kesz"-t mondana, mielott barmi tortent volna.
const PROCESS_STARTED_AT = Date.now()

/**
 * "Eppen dolgozik?" -- a megerosito kerdeshez.
 *
 * SZANDEKOSAN a szigoru `detectPaneState` jelet hasznaljuk, es NEM a
 * `computeAgentActivityLabel`-t, amit az Ugynokok oldal 3 masodperces
 * lekerdezese hasznal. Ket okbol:
 *
 *   1. a `computeAgentActivityLabel` MELLEKHATASOS: eltarolja a pane szoveget
 *      egy kozos gyorsitotarban (paneRecentlyChanged), es egy masik utvonalrol
 *      hivva elrontana a 3 masodperces meres "valtozott-e" osszehasonlitasat;
 *   2. itt egy kerdes szovegehez kell a valasz ("megszakitok-e valodi
 *      munkat?"), es ehhez a biztosan futo munka a helyes jel.
 *
 * A felulet ezt MEG megtoldja azzal, amit a sajat 3 masodperces merese lat --
 * ott a tagabb ertelmezes a jo (Boss: "ha barmit is csinal... akor is dolgozik").
 */
function paneLooksBusy(session: string, host: string | null): boolean {
  // Tavoli agensnel a pane-olvasas ssh-n menne. Egy megerosito ablak nem erhet
  // annyit, hogy egy nem valaszolo geptol masodpercekre megalljon a keres --
  // ilyenkor inkabb nem allitunk semmit.
  if (host) return false
  const pane = capturePane(session)
  if (pane === null) return false
  return detectPaneState(pane) === 'busy'
}

/** A jelenlegi allapot osszeszedese a tervhez. */
function snapshot(): { agents: AgentSnapshot[]; main: AgentSnapshot } {
  const agents: AgentSnapshot[] = listAgentNames().map(name => {
    const host = readAgentRemoteHost(name)
    const running = isAgentRunning(name)
    return {
      name,
      displayName: readAgentDisplayName(name) || name,
      running,
      busy: running ? paneLooksBusy(agentSessionName(name), host) : false,
    }
  })
  const mainPane = capturePane(MAIN_CHANNELS_SESSION)
  const main: AgentSnapshot = {
    name: MAIN_AGENT_ID,
    displayName: currentBotName(),
    running: mainPane !== null,
    busy: mainPane !== null && detectPaneState(mainPane) === 'busy',
  }
  return { agents, main }
}

export async function tryHandleSystemRestart(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/system/restart' && method === 'GET') {
    const a = restartAvailability()
    json(res, { possible: a.possible, unit: a.unit, reason: a.reason, alive: true, startedAt: PROCESS_STARTED_AT })
    return true
  }

  if (path === '/api/system/restart' && method === 'POST') {
    const a = restartAvailability()
    if (!a.possible) {
      json(res, { error: a.reason, code: 'restart_unavailable', unit: a.unit }, 409)
      return true
    }
    // ELOSZOR a valasz, csak AZUTAN az ujrainditas: kulonben a bongeszo egy
    // megszakadt kapcsolatot latna, es a felhasznalo azt hinne, elromlott
    // valami -- pedig eppen az tortenik, amit kert.
    json(res, { ok: true, unit: a.unit, startedAt: PROCESS_STARTED_AT })
    res.once('finish', () => { performSelfRestart() })
    return true
  }

  // --- "Mindent ujraindit" ---------------------------------------------
  //
  // Boss, 2026-08-16: "nem lenne sokal egyszerubb ha mindent ujrainditana ami
  // letezik a marveen ban?" -- de. A GET a TERV: a felulet ebbol tudja
  // megmondani a megerosito kerdesben, hogy KI dolgozik eppen, es mi az, ami
  // szandekosan kimarad. Lasd a hosszu indoklast: src/restart-all.ts.
  if (path === '/api/system/restart-all' && method === 'GET') {
    const { agents, main } = snapshot()
    const plan = buildRestartAllPlan({ agents, main, dashboard: restartAvailability() })
    json(res, { ...plan, startedAt: PROCESS_STARTED_AT })
    return true
  }

  if (path === '/api/system/restart-all' && method === 'POST') {
    const { agents, main } = snapshot()
    const plan = buildRestartAllPlan({ agents, main, dashboard: restartAvailability() })
    // A sub-agensek es a foagens MOST indulnak ujra -- ez masodpercek alatt
    // lefut, es a valaszban minden lepes sajat sort kap, a hibasak is.
    const results = executeRestartAllPlan(plan, {
      restartAgent: (name) => restartAgentProcess(name),
      restartMainAgent: () => hardRestartMarveenChannels(),
    })
    const dashboardStep = plan.steps.find(s => s.kind === 'dashboard')
    const restartDashboard = dashboardStep?.included === true
    json(res, {
      ok: true,
      results,
      dashboardRestarting: restartDashboard,
      dashboardReason: restartDashboard ? '' : plan.dashboardReason,
      startedAt: PROCESS_STARTED_AT,
    })
    // A vezerlopult UTOLSONAK, es csak azutan, hogy a valasz kiment: ez a lepes
    // oli meg azt a folyamatot, amelyik ezt a kerest kiszolgalja.
    if (restartDashboard) res.once('finish', () => { performSelfRestart() })
    return true
  }

  return false
}
