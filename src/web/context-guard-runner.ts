import { statSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { hardRestartMarveenChannels, lastMainRespawnAt, MARVEEN_POST_RESPAWN_GRACE_MS, markAgentRestartPending } from './channel-monitor.js'
import { shouldDeferForRecentRespawn } from './stuck-tool-call-watcher.js'
import { listAgentNames, agentDir, readAgentModel, readAgentRemoteHost } from './agent-config.js'
import { resolveAgentConfigDirForRead } from './claude-plans.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
  sendPromptToSession,
  isSessionReadyForPrompt,
  noteSaturationBannerUntrusted,
  clearSaturationBannerOverride,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { detectPaneState, paneShowsContextSaturation, paneShowsContextSaturationHardError } from '../pane-state.js'
import { readContextTokensFromProjectDir, readActiveModelFromProjectDir } from './active-model.js'
import { readContextGuardConfig } from './context-guard-store.js'
import { createAgentMessage } from '../db.js'
import { localMidnightMs } from '../auto-restart.js'
import {
  decideGuard,
  contextLimitForModel,
  calibrateLimit,
  INITIAL_GUARD_STATE,
  type GuardState,
  type GuardInputs,
  saturationBannerCredible,
  dailyHandoffDue,
  DAILY_HANDOFF_REASON_PREFIX,
} from '../context-guard.js'

// Fleet context guard (kanban #81): acts BEFORE a session drowns in its own
// context. Sweep every agent (main included) every five minutes; at actPct ask the
// agent to write HANDOFF.md, then fresh-restart it and inject a resume prompt
// pointing at the handoff. The always-on saturation net additionally rescues a
// pane already showing "100% context used" -- unreachable by prompt dispatch,
// so nothing else can recover it (samu stall, 2026-07-18). See
// src/context-guard.ts for the why and the pure state machine; this module is
// only the I/O, mirroring auto-restart-runner.
//
// Remote-host agents are skipped: their transcripts live on the remote machine,
// so the context size cannot be measured here (v1 limitation, logged once).

const INITIAL_DELAY_MS = 270_000
const INTERVAL_MS = 300_000
// How long a stand-down of a contradicted saturation banner also silences the
// dispatch refusal (agent-process.saturationRefusesDispatch). Three sweeps, so
// one skipped or slow sweep never flips the refusal back on while the banner is
// still demonstrably wrong; a guard that stopped sweeping lets it lapse.
const SATURATION_OVERRIDE_TTL_MS = 3 * INTERVAL_MS
// Agents whose banner/measurement mismatch was already logged, so a
// mis-scaled status line WARNs once instead of every five minutes.
const bannerMismatchLogged = new Set<string>()

// agent name -> guard state. In-memory: a dashboard restart re-arms every
// agent at 'idle', which is safe -- the worst case is a repeated handoff
// request, and cooldown prevents restart loops within a run.
const guardStates = new Map<string, GuardState>()
const remoteSkipLogged = new Set<string>()

// agent name -> when the daily-handoff tier last fired (ms), #417. Seeded on
// first sight WITHOUT firing, so a slot that already passed before the
// dashboard started does not start a handoff cycle at boot -- the same seed
// rule as the nightly auto-restart. In-memory: a dashboard restart re-seeds
// and at worst skips one slot (the safe direction: a missed daily handoff
// costs a day of context, a spurious one ends a live conversation).
const lastDailyHandoff = new Map<string, number>()
// Agents whose CURRENT handoff cycle was started by the daily tier, so the
// resume prompt says "scheduled restart", not "your context filled up".
const dailyCycle = new Set<string>()

// Per-agent observed-context high-water mark, persisted across dashboard
// restarts. calibrateLimit alone is memoryless: the moment the guard
// restarts an agent, the fresh session's observation shrinks back below the
// tier step-up point, the denominator falls back to the base guess, and a
// miscalibrated agent gets restarted at the same false "over-full" reading
// every cycle -- the evidence that would have corrected the limit is
// destroyed by the very restart it triggered. Persisting the per-(agent,
// model) maximum breaks that loop: once a session has proven the window is
// bigger, the proof survives restarts. Keyed by model so a real model
// downgrade (e.g. fable-5 -> haiku) does not inherit a 1M denominator.
const HIGHWATER_PATH = join(PROJECT_ROOT, 'store', 'context-guard-highwater.json')
type HighwaterMap = Record<string, { model: string; tokens: number }>

function readHighwater(): HighwaterMap {
  try {
    const parsed = JSON.parse(readFileSync(HIGHWATER_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as HighwaterMap : {}
  } catch { return {} }
}

let highwater: HighwaterMap | null = null

function observedHighwater(name: string, model: string, observedNow: number): number {
  if (highwater === null) highwater = readHighwater()
  const entry = highwater[name]
  const prior = entry && entry.model === model ? entry.tokens : 0
  if (observedNow > prior) {
    highwater[name] = { model, tokens: observedNow }
    try { writeFileSync(HIGHWATER_PATH, JSON.stringify(highwater, null, 2)) }
    catch (err) { logger.warn({ err }, 'context-guard: highwater persist failed') }
  }
  return Math.max(observedNow, prior)
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function workingDirFor(name: string): string {
  return name === MAIN_AGENT_ID ? PROJECT_ROOT : agentDir(name)
}

function handoffPathFor(name: string): string {
  return join(workingDirFor(name), 'HANDOFF.md')
}

function handoffMtime(name: string): number | null {
  try { return statSync(handoffPathFor(name)).mtimeMs } catch { return null }
}

export function handoffPrompt(pctRound: number, handoffPath: string): string {
  return (
    `[CONTEXT-GUARD] A munkakontextusod ~${pctRound}%-on van -- kritikus. ` +
    `NE folytasd a feladatot. EGYETLEN dolgod ebben a körben: írj HANDOFF.md-t a /handoff skill struktúrája szerint ide: ${handoffPath} ` +
    `(purpose: a folyamatban lévő feladat folytatása friss kontextusban; Goal / Current Progress / What Worked / What Didn't Work / Next Steps szekciók, ` +
    `konkrét fájl-útvonalakkal és kanban kártya-azonosítókkal). Ha nincs aktív feladatod, írd bele hogy nincs. ` +
    `Utána ÁLLJ MEG -- a rendszer friss kontextussal újraindít és a HANDOFF.md-ből folytatod.`
  )
}

/**
 * Handoff request of the daily tier (#417). Its own wording: the session is
 * not critical (the act tier would have fired), it is simply a day old, and
 * the only true claim is that what is not written down will not survive the
 * scheduled restart.
 */
export function dailyHandoffPrompt(atTime: string, handoffPath: string): string {
  return (
    `[CONTEXT-GUARD] Ütemezett napi újraindítás (${atTime}) -- nem vészhelyzet és nem hiba. ` +
    `A sessionöd hamarosan friss kontextussal indul újra, és ami nincs leírva, az nem éli túl. ` +
    `EGYETLEN dolgod ebben a körben: írj HANDOFF.md-t a /handoff skill struktúrája szerint ide: ${handoffPath} ` +
    `(Goal / Current Progress / What Worked / What Didn't Work / Next Steps, konkrét fájl-útvonalakkal és kanban kártya-azonosítókkal). ` +
    `Ha nincs félbehagyott feladatod, írd bele hogy nincs -- az is teljes értékű válasz. ` +
    `Utána ÁLLJ MEG; a rendszer újraindít és a HANDOFF.md-ből folytatod.`
  )
}

export function resumePrompt(name: string, handoffPath: string, hadHandoff: boolean, scheduled = false): string {
  const base = scheduled
    ? `[CONTEXT-GUARD] Friss kontextussal indultál az ütemezett napi újraindítás miatt (napi átadás). `
    : `[CONTEXT-GUARD] Friss kontextussal indultál, mert az előző session kontextusa megtelt (auto-handoff). `
  const source = hadHandoff
    ? `Első lépés: olvasd be ${handoffPath} -- ez az előző session átadója. `
    : `HANDOFF.md nem készült el időben, ezért az élő forrásokból dolgozz. `
  return (
    base + source +
    `Utána ellenőrizd a kanban tábládat (in_progress kártyák, assignee=${name}) és a hot memóriáidat, ` +
    `és FOLYTASD a megkezdett munkát magadtól. Ne kezdd elölről ami a handoff szerint már kész. ` +
    `Röviden jelezz a csatornádon, hogy friss kontextussal folytatod.`
  )
}

function measurePct(name: string, cfgLimit: number | null): number | null {
  const workingDir = workingDirFor(name)
  // One transcript root for every reader, main agent included (see
  // resolveAgentConfigDirForRead): the tokens AND the model come from it.
  const configDir = resolveAgentConfigDirForRead(name) ?? undefined
  const tokens = readContextTokensFromProjectDir(workingDir, configDir)
  if (tokens === null || tokens <= 0) return null
  let limit: number
  if (cfgLimit) {
    limit = cfgLimit
  } else {
    const model = (name === MAIN_AGENT_ID
      ? readActiveModelFromProjectDir(PROJECT_ROOT, undefined, configDir)
      : readAgentModel(name)) ?? ''
    // Calibrate against the persisted per-(agent, model) maximum, not just
    // the live reading: a fresh post-restart session must not un-learn a
    // window the previous session already proved (see HighwaterMap above).
    limit = calibrateLimit(observedHighwater(name, model, tokens), contextLimitForModel(model))
  }
  return tokens / limit
}

function performRestart(name: string): void {
  if (name === MAIN_AGENT_ID) {
    // Platform-correct main-session restart. This was a hardcoded
    // `/bin/launchctl kickstart`, which exists only on macOS: on Linux every
    // rescue died instantly with `spawnSync /bin/launchctl ENOENT`, caught by
    // checkAgent's catch and buried in a single WARN. Measured on 2026-07-26:
    // the main agent sat at 100% context from 09:47, the saturation net -- the
    // only mechanism that can rescue a pane prompt dispatch refuses -- fired
    // four times and failed every time, and main was unreachable for ~2h until
    // a hand restart.
    //
    // hardRestartMarveenChannels() is the existing helper the channel-monitor
    // down-cascade already uses: it keeps the launchd path for macOS installs
    // (and warns + falls back to a pane respawn if the plist is absent), uses
    // respawn-pane-FRESH on Linux -- fresh is exactly what the guard wants --
    // and writes the shared respawn stamp so the other respawners defer to us.
    const res = hardRestartMarveenChannels()
    if (!res.ok) throw new Error(res.error ?? 'main channels hard restart failed')
  } else {
    // Claim the reconcile grace BEFORE the stop (see markAgentRestartPending).
    markAgentRestartPending(name)
    // #413, rebuilt from upstream f78bfe63: the result was discarded, so a
    // failed stop or start (e.g. the stop could not tear the session down) was
    // filed as a completed rescue while the pane still held the saturated
    // session. Throw like the main branch does; the caller rolls back.
    const res = restartAgentProcess(name, { fresh: true })
    if (!res.ok) throw new Error(res.error ?? 'agent restart failed')
  }
}

async function checkAgent(name: string, nowMs: number): Promise<void> {
  const cfg = readContextGuardConfig(name)
  const state = guardStates.get(name) ?? INITIAL_GUARD_STATE

  // Fully disarmed only when EVERY tier and the always-on saturation net are
  // off; the net alone keeps the sweep alive so a 100%-context pane (which
  // dispatch refuses to prompt) still gets rescued. The daily tier must be in
  // this list too, or a daily-only agent would be skipped before decideGuard
  // ever saw it.
  if (!cfg.enabled && !cfg.saturationRestart && !cfg.dailyHandoffEnabled) {
    guardStates.delete(name)
    lastDailyHandoff.delete(name)
    return
  }

  // v1: local agents only -- a remote host's transcripts are unreadable here.
  if (name !== MAIN_AGENT_ID && readAgentRemoteHost(name)) {
    if (!remoteSkipLogged.has(name)) {
      remoteSkipLogged.add(name)
      logger.info({ name }, 'context-guard: remote-host agent, skipping (transcripts not local)')
    }
    return
  }

  const session = sessionFor(name)
  const running = name === MAIN_AGENT_ID
    ? capturePane(session) !== null
    : agentRunState(name) === 'running'

  // Only pay for the tmux/transcript probes a decision can actually use.
  const needPct = state.phase === 'idle' || state.phase === 'await-handoff'
  const pane = running && needPct ? capturePane(session) : null
  const sessionReady = running && state.phase === 'await-ready'
    ? await isSessionReadyForPrompt(session)
    : false
  // One classification, two distinct signals: 'idle' (safe to restart) and
  // 'busy' (positively mid-turn -- restarts defer). A pane that is neither
  // (error banner, modal, unknown surface) is treated as NOT busy, so a
  // wedged pane still gets the restart that is its only way out.
  const paneState = pane !== null ? detectPaneState(pane) : 'unknown'
  // Rebuilt from upstream d964aab4: a PERCENTAGE-shaped saturation banner
  // ("100% context used") is checked against the transcript before the net
  // believes it -- a status line sized for the wrong window claims 100% while
  // the session is at a fraction of it, and the net would restart a working
  // agent mid-turn. The hard-error class is painted only after a turn failed
  // at the real limit, so it needs no probe and none is paid for.
  const paneSaturatedRaw = pane !== null ? paneShowsContextSaturation(pane) : false
  const bannerIsHardError = pane !== null && paneSaturatedRaw
    ? paneShowsContextSaturationHardError(pane)
    : false
  const needCredibilityProbe = paneSaturatedRaw && !bannerIsHardError
  const measuredPct = running && needPct && (cfg.enabled || needCredibilityProbe)
    ? measurePct(name, cfg.limitTokens)
    : null
  const paneSaturatedTrusted = saturationBannerCredible(paneSaturatedRaw, bannerIsHardError, measuredPct)
  if (paneSaturatedRaw && !paneSaturatedTrusted) {
    // Tell the dispatch gate too: it refuses on the same banner, and refusing
    // for an agent this net will not restart would silence it for good.
    noteSaturationBannerUntrusted(session, nowMs + SATURATION_OVERRIDE_TTL_MS)
    if (!bannerMismatchLogged.has(name)) {
      bannerMismatchLogged.add(name)
      logger.warn(
        { name, measuredPct },
        'context-guard: pane claims context saturation but the transcript measures far below it -- standing the saturation net down (status line sized for the wrong window?)',
      )
    }
  } else if (pane !== null) {
    clearSaturationBannerOverride(session)
    bannerMismatchLogged.delete(name)
  }
  const inputs: GuardInputs = {
    nowMs,
    running,
    // The proactive tiers act on pct only when enabled; the credibility probe
    // above may have measured it for the saturation net alone.
    pct: cfg.enabled ? measuredPct : null,
    paneIdle: paneState === 'idle',
    paneBusy: paneState === 'busy',
    sessionReady,
    handoffMtime: needPct ? handoffMtime(name) : null,
    paneSaturated: paneSaturatedTrusted,
    // Seed-on-first-sight: an agent not yet seen by this process is recorded
    // as served NOW, so the tier is never due on the first sweep.
    dailyHandoffDue: (() => {
      if (!running || state.phase !== 'idle') return false
      const last = lastDailyHandoff.get(name)
      if (last === undefined) { lastDailyHandoff.set(name, nowMs); return false }
      return dailyHandoffDue(cfg, localMidnightMs(nowMs), last, nowMs)
    })(),
  }

  const decision = decideGuard(state, inputs, cfg)

  // Mark the slot served at DECISION time: if the prompt fails to send, the
  // machine is already in await-handoff and its timeout restarts anyway -- the
  // slot really was consumed. Marking later would re-fire every sweep.
  if (decision.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)) {
    lastDailyHandoff.set(name, nowMs)
    dailyCycle.add(name)
  } else if (decision.action === 'request-handoff') {
    dailyCycle.delete(name)
  }

  // Post-respawn grace for the main session. Making the Linux restart path work
  // (above) also makes it repeatable: measured on 2026-07-26, the saturation net
  // fresh-restarted main five times in one morning, so the agent lost its
  // conversation roughly every half hour. Two causes of a redundant restart,
  // both covered by the same stamp: a session that is still BOOTING can read as
  // saturated/idle again on the next sweep, and ANOTHER respawner (the
  // channel-monitor down-cascade, the auto-restart runner, channel-watchdog.sh)
  // may have just restarted main for its own reasons.
  //
  // Same mechanism every other respawner already shares -- lastMainRespawnAt()
  // plus MARVEEN_POST_RESPAWN_GRACE_MS -- so there is no new tunable and no new
  // number; see the identical gate in stuck-tool-call-watcher.ts. Main only: the
  // stamp describes the main channels session, and a sub-agent restart is
  // cheap and independently coordinated.
  //
  // The state must NOT advance here. decideGuard() has already produced
  // nextState = await-ready; committing that while skipping the restart would
  // leave the machine believing main was restarted, and the next sweep would
  // inject a "continue from your handoff" resume prompt into the SAME saturated
  // pane -- the guard would consume its own recovery and never retry. Keeping
  // the previous state means the next sweep re-decides, and the restart happens
  // once the grace has elapsed.
  if (decision.action === 'restart' && name === MAIN_AGENT_ID) {
    const lastRespawn = lastMainRespawnAt()
    if (shouldDeferForRecentRespawn(lastRespawn, nowMs)) {
      logger.info(
        { name, sinceRespawnMs: lastRespawn ? nowMs - lastRespawn : null, graceMs: MARVEEN_POST_RESPAWN_GRACE_MS },
        'context-guard: recent main respawn within grace, deferring restart (avoid restart loop / boot churn)',
      )
      guardStates.set(name, state)
      return
    }
  }

  guardStates.set(name, decision.nextState)
  if (decision.action === 'none') return

  const pctRound = inputs.pct !== null ? Math.round(inputs.pct * 100) : null
  logger.info(
    { name, action: decision.action, reason: decision.reason, pct: pctRound, bannerRaw: paneSaturatedRaw, bannerTrusted: paneSaturatedTrusted, measuredPct },
    'context-guard: acting',
  )

  try {
    switch (decision.action) {
      case 'request-handoff':
        await sendPromptToSession(
          session,
          decision.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)
            // pct is null for a daily-only agent: the percentage prompt would
            // announce "~0% -- critical" to a perfectly healthy session.
            ? dailyHandoffPrompt(cfg.dailyHandoffTime ?? '', handoffPathFor(name))
            : handoffPrompt(pctRound ?? 0, handoffPathFor(name)),
        )
        break
      case 'restart': {
        // A forced restart must never be silent: the supervisor has to know
        // that prompts delivered to the OLD session (queued steering input,
        // parked text, the handoff request itself) may have died with it
        // (2026-07-27: two dispatched instructions lost this way). Snapshot
        // the pane first for post-mortem, then restart, then report on the
        // inter-agent queue -- the channel supervisors actually read.
        let snapshotPath: string | null = null
        try {
          const finalPane = pane ?? capturePane(session)
          if (finalPane) {
            snapshotPath = join(PROJECT_ROOT, 'store', `context-guard-last-pane-${name}.txt`)
            writeFileSync(snapshotPath, finalPane)
          }
        } catch (err) {
          logger.warn({ err, name }, 'context-guard: pre-restart pane snapshot failed')
        }
        try {
          performRestart(name)
        } catch (err) {
          // #413, rebuilt from upstream f78bfe63: guardStates was advanced to
          // the post-restart phase BEFORE this switch, so a failed rescue would
          // otherwise be filed as a completed one -- the guard would wait for a
          // session it never started, inject a resume prompt into the old
          // saturated pane, then sit out its cooldown. Roll back so the next
          // sweep re-measures and retries, and never claim the restart on the
          // message queue. (Before, the main-agent failure surfaced only as a
          // debug line from the sweep's catch.)
          guardStates.set(name, INITIAL_GUARD_STATE)
          logger.error({ err, name, reason: decision.reason }, 'context-guard: rescue restart FAILED -- state rolled back for retry')
          break
        }
        try {
          createAgentMessage(
            name,
            MAIN_AGENT_ID,
            `[CONTEXT-GUARD] Ujrainditottam a(z) "${name}" agentet -- ok: ${decision.reason}` +
            (pctRound !== null ? ` (kontextus ~${pctRound}%)` : '') +
            `. A regi sessionbe az utolso percekben kuldott uzenetek/utasitasok ELVESZHETTEK -- ellenorizd es kuldd ujra oket.` +
            (snapshotPath ? ` Pane-snapshot a restart elotti allapotrol: ${snapshotPath}` : ''),
            'context-guard restart notice',
          )
        } catch (err) {
          logger.warn({ err, name }, 'context-guard: restart notice message failed')
        }
        break
      }
      case 'inject-resume': {
        const hadHandoff = inputs.handoffMtime !== null || handoffMtime(name) !== null
        const scheduled = dailyCycle.delete(name)
        await sendPromptToSession(session, resumePrompt(name, handoffPathFor(name), hadHandoff, scheduled))
        break
      }
    }
  } catch (err) {
    logger.warn({ err, name, action: decision.action }, 'context-guard: action failed')
  }
}

/** Live status for the dashboard/API. */
export function getContextGuardStatus(): Array<{
  agent: string
  phase: string
  pct: number | null
  enabled: boolean
  saturationRestart: boolean
}> {
  const names = [MAIN_AGENT_ID, ...listAgentNames()]
  return names.map((name) => {
    const cfg = readContextGuardConfig(name)
    const remote = name !== MAIN_AGENT_ID && !!readAgentRemoteHost(name)
    return {
      agent: name,
      phase: guardStates.get(name)?.phase ?? 'idle',
      pct: cfg.enabled && !remote ? measurePct(name, cfg.limitTokens) : null,
      enabled: cfg.enabled,
      saturationRestart: cfg.saturationRestart,
    }
  })
}

/**
 * Current phase of the hard context-guard for this agent. Returns 'idle' when
 * no state has been recorded. The gate runner uses this for its interlock: when
 * the hard guard is in 'await-handoff' or 'await-ready', the soft gate steps
 * aside so both mechanisms never simultaneously touch the pane.
 *
 * Fork note (usalackor, 2026-08-11): the upstream #938 hunk also added
 * guardSweepAgentNames() here, built on listAllAgentNames() which does not
 * exist in this fork and which nothing in the pulled feature calls. Taking it
 * verbatim would fail the build, so only getHardGuardPhase -- the function the
 * gate runner actually imports -- is carried over.
 */
export function getHardGuardPhase(name: string): string {
  return guardStates.get(name)?.phase ?? 'idle'
}
export function startContextGuardRunner(): NodeJS.Timeout {
  async function sweep() {
    const now = Date.now()
    try { await checkAgent(MAIN_AGENT_ID, now) } catch (err) { logger.debug({ err }, 'context-guard: main check error') }
    for (const name of listAgentNames()) {
      try { await checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'context-guard: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
