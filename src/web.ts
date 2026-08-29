import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import { PROJECT_ROOT, WEB_HOST, DASHBOARD_PUBLIC_URL, DASHBOARD_ALLOWED_ORIGINS, MAIN_AGENT_ID } from './config.js'
import { loadOrCreateDashboardToken } from './web/dashboard-auth.js'
import { resolveAuth, requiresAuth, isFederationWireEndpoint, type AuthResult } from './web/auth-gate.js'
import { sweepExpiredSessions } from './web/auth-sessions.js'
import { autoPurgeTrash } from './life-explorer.js'
import { getEffectiveSettingValue } from './settings-store.js'
import { sweepExpiredDeviceKeys } from './web/auth-device-keys.js'
import { isBlockedCrossOriginWrite, originMatchesServedHost } from './web/csrf-origin.js'
import { json } from './web/http-helpers.js'
import { detectLanIp, detectTailscaleServeUrl } from './web/network-info.js'
import { AGENTS_BASE_DIR, listAgentNames } from './web/agent-config.js'
import { ensureAgentHooks, ensureAgentStalenessHook, ensureEgressGate, ensureGovernanceGatesRemoved, ensureQuarantineReader, ensureDefaultScheduledTasks, agentSettingsPath, ensureAutonomySection, ensureAgentSkills, ensureAskBackSection, ensureGlobalAskBackRule, ensureRecheckSection, ensureGlobalRecheckRule, ensureWakeGreetingSection, ensureGlobalWakeGreetingRule, ensureDelegateCheckSection, ensureGlobalDelegateCheckRule } from './web/agent-scaffold.js'
import { shouldRegisterHooks, pruneStaleHooksFromSettingsFile } from './web/hook-registration-guard.js'
import { refreshMarveenBotUsername } from './web/telegram.js'
import { startMessageRouter } from './web/message-router.js'
import { startTelegramInboxWakeWatcher } from './web/telegram-inbox-wake.js'
import { startUpdateChecker } from './web/update-checker.js'
import { startScheduleRunner } from './web/schedule-runner.js'
import { startChannelPluginMonitor } from './web/channel-monitor.js'
import { startInboundProber } from './web/inbound-probe.js'
import { startChannelHealthMonitor } from './web/channel-health-monitor.js'
import { startStuckInputWatcher } from './web/stuck-input-watcher.js'
import { startInboxNudgeWatcher } from './web/inbox-nudge-watcher.js'
import { startLimitWakeRunner, LIMIT_WAKE_INTERVAL_MS, LIMIT_WAKE_INITIAL_DELAY_MS } from './web/limit-wake-runner.js'
import { checkAgentParity } from './web/agent-parity-check.js'
import { startStuckToolCallWatcher } from './web/stuck-tool-call-watcher.js'
import { startReauthHealer } from './web/reauth-healer.js'
import { startAutoRestartRunner } from './web/auto-restart-runner.js'
import { startModelFallbackRunner } from './web/model-fallback-runner.js'
import { startContextGuardRunner } from './web/context-guard-runner.js'
import { startContextRestartGateRunner } from './web/context-restart-gate-runner.js'
import { collectTokenUsage } from './web/token-usage.js'
import { logger } from './logger.js'
import { tryHandleAuth } from './web/routes/auth.js'
import { tryHandleSecurity } from './web/routes/security.js'
import { tryHandleProfiles } from './web/routes/profiles.js'
import { tryHandleMessages } from './web/routes/messages.js'
import { tryHandleFederation } from './web/routes/federation.js'
import { startFederationPoller } from './web/federation/poller.js'
import { startCapabilitySummaryRunner } from './web/federation/capability-runner.js'
import { tryHandleCode } from './web/routes/code.js'
import { startCodeBridgeRunner } from './web/code-bridge-runner.js'
import { startCodeBotPoller } from './web/code-bridge-telegram.js'
import { ensureFederationClaudeMdSection } from './web/federation/onboarding.js'
import { tryHandleAgentTerminal } from './web/routes/agent-terminal.js'
import { tryHandleAgentConversation } from './web/routes/agent-conversation.js'
import { tryHandleAgentTaskState } from './web/routes/agent-taskstate.js'
import { sweepOrphanTaskStates } from './web/agent-taskstate.js'
import { tryHandleDailyLog } from './web/routes/daily-log.js'
import { tryHandleMemories } from './web/routes/memories.js'
import { tryHandleReflect } from './web/routes/reflect.js'
import { tryHandleMigrate } from './web/routes/migrate.js'
import { tryHandleKanban } from './web/routes/kanban.js'
import { tryHandleSchedules } from './web/routes/schedules.js'
import { tryHandleConnectors } from './web/routes/connectors.js'
import { tryHandleDocs } from './web/routes/docs.js'
import { tryHandleResearch } from './web/routes/research.js'
import { tryHandleConnectorsHu } from './web/routes/connectors-hu.js'
import { tryHandleAgentsSkills } from './web/routes/agents-skills.js'
import { tryHandleSkills } from './web/routes/skills.js'
import { tryHandleAgents } from './web/routes/agents.js'
import { tryHandleMarveen } from './web/routes/marveen.js'
import { tryHandleRecall } from './web/routes/recall.js'
import { tryHandleBackgroundTasks, sweepOrphanedBackgroundTasks } from './web/routes/background-tasks.js'
import { tryHandleOverview } from './web/routes/overview.js'
import { tryHandleAccounts } from './web/routes/accounts.js'
import { tryHandleConnections } from './web/routes/connections.js'
import { tryHandleDriveBrowser } from './web/routes/drive-browser.js'
// Ez a negy modul 2026-08-16-an KIESETT a bekotesbol (a munkafa egy regebbi
// allapotra ugrott vissza, es a web.ts-t senki nem allitotta helyre). A
// route-fajlok vegig megvoltak es le is fordultak a dist-be -- csak SOHA nem
// futottak le, mert semmi nem hivta oket. Ettol lett nema halott a Fotok, a
// Depo, a Drive-szinkron es az Ujrainditas: a lap betoltodott, a keresek pedig
// 404-re futottak. Egy le nem forditott fajl kiabal; egy be nem kotott fajl
// csendben nem letezik -- ezert all ra kulon teszt (web-boot-order).
import { tryHandleDepot } from './web/routes/depot.js'
import { tryHandleLife } from './web/routes/life.js'
import { tryHandleStorages } from './web/routes/storages.js'
import { tryHandleDriveSync } from './web/routes/drive-sync.js'
import { tryHandlePhotosPicker } from './web/routes/photos-picker.js'
import { tryHandleSystemRestart } from './web/routes/system-restart.js'
import { tryHandleUpdates } from './web/routes/updates.js'
import { tryHandleOnboarding } from './web/routes/onboarding.js'
import { tryHandleSetupWizard } from './web/routes/setup-wizard.js'
import { tryHandleStatus } from './web/routes/status.js'
import { tryHandleAutonomy } from './web/routes/autonomy.js'
import { tryHandleFileClaims } from './web/routes/file-claims.js'
import { sweepExpiredClaims } from './web/file-claims-store.js'
import { startUncommittedWorkWatcher } from './web/uncommitted-work-runner.js'
import { tryHandleApprovals, startApprovalTimeoutSweeper } from './web/routes/approvals.js'
import { sweepApprovalVerifications, VERIFICATION_SWEEP_INTERVAL_MS } from './web/verification-sweep-job.js'
import { tryHandleTokenUsage } from './web/routes/token-usage.js'
import { tryHandleCosts, startCostsSyncTask } from './web/routes/costs.js'
import { tryHandlePersistentWindows } from './web/routes/persistent-windows.js'
import { tryHandleWindowsSettings } from './web/routes/windows-settings.js'
import { startWindowLayoutSyncTask } from './persistent-windows-sync.js'
import { tryHandleDebate } from './web/routes/debate.js'
import { tryHandleOpenRouterOverview } from './web/routes/openrouter-overview.js'
import { tryHandleIdeas } from './web/routes/ideas.js'
import { tryHandleEmail, warmEmailCaches } from './web/routes/email.js'
import { tryHandleToolLog } from './web/routes/tool-log.js'
import { tryHandleSpans } from './web/routes/spans.js'
import { tryHandleSkillUsage } from './web/routes/skill-usage.js'
import { tryHandleSettings } from './web/routes/settings.js'
import { tryHandleAuditLog } from './web/routes/audit-log.js'
import { tryHandleFleetQ } from './web/routes/fleet-q.js'
import { tryHandleStatic } from './web/routes/static.js'
import { tryHandleVoice } from './web/routes/voice.js'
import { tryHandleVaultSsh } from './web/routes/vault-ssh.js'
import { tryHandleFleet } from './web/routes/fleet.js'
import { tryHandleVaultSshKeys } from './web/routes/vault-ssh-keys.js'
import type { RouteContext } from './web/routes/types.js'

const WEB_DIR = join(PROJECT_ROOT, 'web')

function ensureDirs() {
  mkdirSync(AGENTS_BASE_DIR, { recursive: true })
}

export function startWebServer(port = 3420): http.Server {
  // SECURITY: Server binds to 127.0.0.1 (see server.listen below). The allowed
  // browser origins mirror that -- anything else is rejected to prevent CSRF
  // from malicious websites the user may visit while the dashboard is running.
  ensureDirs()

  const DASHBOARD_TOKEN = loadOrCreateDashboardToken()
  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    ...( WEB_HOST !== 'localhost' && WEB_HOST !== '127.0.0.1' ? [`http://${WEB_HOST}:${port}`] : []),
    ...(DASHBOARD_PUBLIC_URL ? [DASHBOARD_PUBLIC_URL.replace(/\/$/, '')] : []),
    ...DASHBOARD_ALLOWED_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean),
  ])

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const path = url.pathname
    const method = req.method || 'GET'

    const origin = req.headers.origin
    // Emit CORS headers for allowlisted origins AND for genuinely same-origin
    // requests reached via a reverse proxy (e.g. Tailscale Serve's ts.net host,
    // where the Origin host matches Host / X-Forwarded-Host). Without this, an
    // iOS Safari preflight for an Authorization-bearing /api/ fetch over the
    // proxy gets a 204 with no Access-Control-* headers and the browser blocks
    // the request -- the page shell loads but no data does. Authorization must be
    // in Allow-Headers or the preflight rejects the Bearer header.
    if (origin && (allowedOrigins.has(origin) ||
        originMatchesServedHost(origin, req.headers.host, req.headers['x-forwarded-host'] as string | undefined))) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    }
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Block state-changing requests from browsers running on foreign origins.
    // Same-origin fetches (Origin absent, allowlisted, or matching the host the
    // server was actually reached on -- e.g. a Tailscale Serve / reverse-proxy
    // hostname) are accepted; a foreign Origin is rejected (the CSRF defence).
    if (isBlockedCrossOriginWrite(method, origin, req.headers.host, req.headers['x-forwarded-host'] as string | undefined, allowedOrigins)) {
      logger.warn({ method, path, origin, host: req.headers.host, xForwardedHost: req.headers['x-forwarded-host'] }, 'CSRF: blocked write from foreign origin')
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Origin not allowed' }))
      return
    }

    // Auth gate: resolve the request's principal once via the extracted gate
    // (bearer -> SSE ?token= -> endpoint-scoped federation token -> mv_session
    // cookie). Bearer stays highest precedence and byte-identical, so every
    // fleet curl call keeps working with users present or absent. requiresAuth()
    // decides whether a missing principal is a 401 (gated /api/* + fleet
    // manifest) or a public probe (auth status/login, avatars).
    const auth: AuthResult = resolveAuth(req, url, path, method, DASHBOARD_TOKEN)
    if (requiresAuth(path, method) && auth.kind === 'none') {
      if (isFederationWireEndpoint(path, method)) {
        // 401s are otherwise silent; federation-endpoint auth failures are the
        // brute-force surface -- make them visible (round-2 scoped-token gate).
        logger.warn({ path, method }, 'federation: rejected wire-endpoint auth')
      }
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const fedPeerForCtx: string | null = auth.kind === 'federation' ? auth.peer : null
    const ctxAuth =
      auth.kind === 'token' ? { kind: 'token' as const }
      : auth.kind === 'device' ? { kind: 'device' as const, device: auth.device }
      : auth.kind === 'session' ? { kind: 'session' as const, user: auth.user }
      : auth.kind === 'federation' ? { kind: 'federation' as const, peer: auth.peer }
      : undefined

    // The mobile-login QR needs a URL the phone can actually reach. When the
    // desktop opens the dashboard on localhost, window.location.origin is
    // useless (the phone would hit its OWN localhost), so the client asks the
    // server for its LAN IP and builds the QR from that. Auth is already
    // enforced by the /api/* gate above.
    if (path === '/api/network-info' && method === 'GET') {
      const tailscaleUrl = await detectTailscaleServeUrl(port)
      return json(res, { lan_ip: detectLanIp(), port, tailscale_url: tailscaleUrl })
    }

    try {
      const routeCtx: RouteContext = { req, res, path, method, url, fedPeer: fedPeerForCtx, auth: ctxAuth }

      if (await tryHandleAuth(routeCtx)) return
      if (await tryHandleSecurity(routeCtx)) return
      if (await tryHandleProfiles(routeCtx)) return
      if (await tryHandleMessages(routeCtx)) return
      if (await tryHandleFederation(routeCtx)) return
      if (await tryHandleDailyLog(routeCtx)) return
      if (await tryHandleMemories(routeCtx)) return
      if (await tryHandleReflect(routeCtx)) return
      if (await tryHandleMigrate(routeCtx)) return
      if (await tryHandleKanban(routeCtx)) return
      if (await tryHandleSchedules(routeCtx)) return
      if (await tryHandleConnectorsHu(routeCtx)) return
      if (await tryHandleConnectors(routeCtx)) return
      if (await tryHandleDocs(routeCtx)) return
      if (await tryHandleResearch(routeCtx)) return
      if (await tryHandleAgentsSkills(routeCtx)) return
      if (await tryHandleSkills(routeCtx)) return
      if (await tryHandleAgentTerminal(routeCtx)) return
      if (await tryHandleAgentConversation(routeCtx)) return
      if (await tryHandleAgentTaskState(routeCtx)) return
      if (await tryHandleAgents(routeCtx, WEB_DIR)) return
      if (await tryHandleMarveen(routeCtx, WEB_DIR)) return
      if (await tryHandleBackgroundTasks(routeCtx)) return
      if (await tryHandleRecall(routeCtx)) return
      if (await tryHandleOverview(routeCtx)) return
      if (await tryHandleAccounts(routeCtx)) return
      if (await tryHandleConnections(routeCtx)) return
      if (await tryHandleDriveBrowser(routeCtx)) return
      if (await tryHandleDriveSync(routeCtx)) return
      if (await tryHandlePhotosPicker(routeCtx)) return
      if (await tryHandleDepot(routeCtx)) return
      if (await tryHandleLife(routeCtx)) return
      if (await tryHandleStorages(routeCtx)) return
      if (await tryHandleSystemRestart(routeCtx)) return
      if (await tryHandleUpdates(routeCtx)) return
      if (await tryHandleOnboarding(routeCtx)) return
      if (await tryHandleSetupWizard(routeCtx)) return
      if (await tryHandleStatus(routeCtx)) return
      if (await tryHandleAutonomy(routeCtx)) return
      if (await tryHandleFileClaims(routeCtx)) return
      if (await tryHandleApprovals(routeCtx)) return
      if (await tryHandleTokenUsage(routeCtx)) return
      if (await tryHandleCosts(routeCtx)) return
      if (await tryHandlePersistentWindows(routeCtx)) return
      if (await tryHandleWindowsSettings(routeCtx)) return
      if (await tryHandleDebate(routeCtx)) return
      if (await tryHandleOpenRouterOverview(routeCtx)) return
      if (await tryHandleIdeas(routeCtx)) return
      if (await tryHandleEmail(routeCtx)) return
      if (await tryHandleSpans(routeCtx)) return
      if (await tryHandleToolLog(routeCtx)) return
      if (await tryHandleSkillUsage(routeCtx)) return
      if (await tryHandleSettings(routeCtx)) return
      if (await tryHandleVoice(routeCtx)) return
      if (await tryHandleVaultSshKeys(routeCtx)) return
      if (await tryHandleVaultSsh(routeCtx)) return
      if (await tryHandleAuditLog(routeCtx)) return
      if (await tryHandleFleetQ(routeCtx)) return
      if (await tryHandleCode(routeCtx)) return
      if (await tryHandleFleet(routeCtx)) return
      if (await tryHandleStatic(routeCtx, WEB_DIR)) return

      res.writeHead(404)
      res.end('Not found')
    } catch (err) {
      logger.error({ err }, 'Web szerver hiba')
      json(res, { error: 'Szerver hiba' }, 500)
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Try to reclaim the port only if the listener is another node/dashboard
      // process owned by us. Blind `lsof -ti | xargs kill -9` would take down
      // whatever happens to be on the port (e.g. an unrelated dev server),
      // and under launchd it also race-kills the not-yet-dead predecessor.
      logger.warn({ port }, 'Web port foglalt, probalok felszabaditani...')
      try {
        const pidsRaw = execSync(`lsof -ti :${port} 2>/dev/null || true`, { timeout: 3000, encoding: 'utf-8' }).trim()
        const pids = pidsRaw.split('\n').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0)
        const uid = typeof process.getuid === 'function' ? process.getuid() : null
        const victims: number[] = []
        for (const pid of pids) {
          if (pid === process.pid) continue
          let cmd = ''
          try {
            cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 2000, encoding: 'utf-8' }).trim()
          } catch { continue }
          if (uid !== null) {
            try {
              const ownerUid = parseInt(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid='], { timeout: 2000, encoding: 'utf-8' }).trim(), 10)
              if (Number.isFinite(ownerUid) && ownerUid !== uid) continue
            } catch { continue }
          }
          if (!/node|tsx/i.test(cmd)) {
            logger.warn({ port, pid, cmd }, 'Port held by non-node process -- refusing to kill')
            continue
          }
          victims.push(pid)
        }
        for (const pid of victims) {
          try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
        }
        if (victims.length) {
          setTimeout(() => {
            for (const pid of victims) {
              try {
                process.kill(pid, 0)
                try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
              } catch { /* gone */ }
            }
            server.listen(port, WEB_HOST, () => {
              logger.info({ port }, `Web dashboard: re-listen bound after port reclaim`)
            })
          }, 1500)
        } else {
          logger.error({ port }, 'Port foglalt de nem talaltunk felszabadithato node processt -- kilepes')
          process.exit(1)
        }
      } catch (e) {
        logger.error({ err: e }, 'Port-reclaim failed')
      }
    } else {
      logger.error({ err }, 'Web szerver hiba')
    }
  })

  server.listen(port, WEB_HOST, () => {
    logger.info({ port }, `Web dashboard: http://localhost:${port}`)
    // Az email-oldal listai hideg indulasnal masodpercekig tartanak (ures
    // cache + hideg IMAP: merve 12,3 illetve 19,3 mp, melegen 0,85 mp). Ezt
    // ne az elso latogato fizesse ki: par masodperccel a bootolas utan, amikor
    // a tobbi indulo munka mar lefutott, csendben elomelegitjuk. unref(): egy
    // fuggo elomelegites sose tartsa eletben a folyamatot.
    //
    // A kesleltetes SZANDEKOSAN rovid: a hideg IMAP-lekeres maga ~3 mp, tehat
    // csak akkor spuroljuk meg a felhasznalonak, ha addigra vegez. 5 mp-rol
    // 1,5-re hozva a 6. masodpercben erkezo betoltes mar keszet talal. Az
    // elomelegites halozatra var, nem CPU-t esz -- nem lassitja a bootot.
    setTimeout(() => { void warmEmailCaches() }, 1500).unref()
    // Do NOT log the bearer token: launchd/journal/pipe captures of the
    // structured log would otherwise carry a root-equivalent credential.
    // Printing to stderr keeps it out of the pino stream -- but stderr is only
    // private when a HUMAN is on the other end of it. Measured 2026-08-19 on
    // the running system: systemd redirects this service's stderr into
    // store/dashboard.error.log, so the token sat in 365 log lines at mode
    // 0664, while .dashboard-token itself is correctly 0600. A secret printed
    // "to the terminal" is a secret written to a file whenever nothing is
    // attached to the terminal, so the TTY has to be checked, not assumed.
    if (process.stderr.isTTY) {
      const bootstrapUrl = `http://127.0.0.1:${port}/?token=${DASHBOARD_TOKEN}`
      process.stderr.write(
        `\nDashboard access URL (paste into browser, token is stored afterward):\n  ${bootstrapUrl}\n\n`
      )
    } else {
      // Same instruction, no credential: whoever needs the URL can read the
      // token from the 0600 file, which is exactly the permission boundary the
      // token is supposed to have.
      process.stderr.write(
        `\nDashboard: http://127.0.0.1:${port}/  ` +
        `(access token in store/.dashboard-token -- not printed to a log)\n\n`
      )
    }
  })

  // Self-heal a SILENT listener failure. Under launchd, a `kickstart -k` can
  // race the dying predecessor's lingering socket: the EADDRINUSE reclaim +
  // re-listen path can leave this process ALIVE but not actually listening, with
  // no error (observed 2026-06-27 -- the success log above fired yet nothing was
  // bound, and the background loops started below kept running, so the dashboard
  // was deaf until a manual restart, which bound cleanly). A clean restart binds
  // reliably, so if the listener is not up we exit(1) and let launchd restart us
  // fresh rather than linger un-servable. Runs regardless of WEB_ONLY -- it is
  // about the HTTP listener, not the background services.
  //
  // The grace must comfortably exceed a SLOW-but-valid bind: restarting OVER a
  // wedged predecessor, the EADDRINUSE reclaim retries every ~1500ms until the
  // old socket finally releases -- observed up to ~5 MINUTES (2026-06-27). An
  // 8s grace would exit MID-bind and loop, so wait STARTUP_GRACE first. After
  // that, poll periodically so a mid-life listener drop is caught too, not just
  // a startup failure.
  const STARTUP_GRACE_MS = 7 * 60 * 1000
  const RELISTEN_POLL_MS = 60 * 1000
  setTimeout(() => {
    setInterval(() => {
      if (!server.listening) {
        logger.error({ port }, 'Web server not listening -- exiting(1) for a clean launchd restart')
        process.exit(1)
      }
    }, RELISTEN_POLL_MS).unref()
  }, STARTUP_GRACE_MS).unref()

  // WEB_ONLY=true disables all background services (scheduler, pollers, monitors).
  // Used for staging preview instances that must not conflict with the live fleet
  // (duplicate schedule execution, Telegram 409, tmux manipulation, etc.).
  const webOnly = process.env['WEB_ONLY'] === 'true'
  if (webOnly) {
    logger.info('[staging] WEB_ONLY mode: background services disabled')
  }

  const routerInterval = webOnly ? undefined : startMessageRouter()
  if (!webOnly) logger.info('Agent message router started (5s poll)')

  // Telegram inbox wake-nudge for sub-agents, on its own sub-second cadence so an
  // inbound message never waits on the router tick. No-op unless
  // SUBAGENT_TELEGRAM_WAKE_ENABLED (the watcher early-outs on a boolean).
  const telegramWakeInterval = webOnly ? undefined : startTelegramInboxWakeWatcher()
  if (!webOnly) logger.info('Telegram inbox wake watcher started (500ms poll)')

  const scheduleInterval = webOnly ? undefined : startScheduleRunner()
  if (!webOnly) logger.info('Schedule runner started (60s poll)')

  // Pre-start the interactive agent worker (subscription backend) so the first
  // heartbeat / scheduled generation after boot does not pay the cold-boot
  // latency. runViaWorker still lazy-starts + restarts it on demand, so this is
  // a warm-up, not a hard dependency. Skipped on the SDK rollback backend.
  if (!webOnly && (process.env.MARVEEN_AGENT_BACKEND || 'worker').toLowerCase() !== 'sdk') {
    import('./web/agent-worker.js')
      .then(m => { m.startWorkerSession(); logger.info('Interactive agent worker pre-started') })
      .catch(err => logger.warn({ err }, 'Failed to pre-start agent worker (will lazy-start on first use)'))
  }

  // WORKERBOOT1: nothing watched the worker sessions, so a death left no trace
  // and the cause stayed unknowable. This only notices and logs -- it does not
  // restart (the next request already re-creates the session) and does not try
  // to explain the death; that is what the log is for.
  let workerLivenessInterval: NodeJS.Timeout | undefined
  // The handle is assigned inside an async .then(), so a shutdown that runs
  // BEFORE the dynamic import resolves would clear an undefined and then the
  // import would start an interval nobody owns. A live setInterval keeps the
  // event loop alive, so that is not just a leak: the process would never exit.
  // The other monitors are synchronous calls and cannot hit this.
  let workerLivenessCancelled = false
  if (!webOnly && (process.env.MARVEEN_AGENT_BACKEND || 'worker').toLowerCase() !== 'sdk') {
    import('./web/worker-liveness.js')
      .then(m => {
        if (workerLivenessCancelled) return
        workerLivenessInterval = m.startWorkerLivenessMonitor()
        logger.info('Worker liveness monitor started (60s poll)')
      })
      .catch(err => logger.warn({ err }, 'Failed to start the worker liveness monitor'))
  }

  const pluginMonitorInterval = webOnly ? undefined : startChannelPluginMonitor()
  if (!webOnly) logger.info('Channel plugin health monitor started (60s poll)')

  // Userbot inbound-probe (gold-standard deafness detector). Safe no-op until
  // the prober session file + allowlist are configured. Wrapped so a failure
  // never crashes server startup.
  if (!webOnly) {
    try {
      startInboundProber()
    } catch (err) {
      logger.warn({ err }, 'Inbound prober failed to start')
    }
  }

  const channelHealthInterval = webOnly ? undefined : startChannelHealthMonitor()
  if (!webOnly) logger.info('Channel MCP health monitor started (60s poll, 45s offset)')

  // CostOps: reflect the local config's fixed costs into the ledger once at boot + every
  // 10 minutes. Deliberately NOT done inside the GET /api/costs/summary handler -- a read
  // endpoint must not write (was flagged in review); this is the one place that does.
  const costsSyncInterval = webOnly ? undefined : startCostsSyncTask()
  if (!webOnly) logger.info('CostOps fixed-cost sync started (10min poll + startup)')

  // Window layout: keep the off-machine GitHub copy fresh twice a day. Pushes
  // only -- it never captures, so a timer can never overwrite Boss's deliberate
  // arrangement with whatever is on screen when it fires (kanban 79).
  const windowLayoutSyncInterval = webOnly ? undefined : startWindowLayoutSyncTask()
  if (!webOnly) logger.info('Window-layout GitHub backup started (12h poll, 5min startup delay)')

  const stuckInputInterval = webOnly ? undefined : startStuckInputWatcher()
  if (!webOnly) logger.info('Stuck-input watcher started (15s poll, 20s offset)')

  const stuckToolCallInterval = webOnly ? undefined : startStuckToolCallWatcher()
  if (!webOnly) logger.info('Stuck-tool-call watcher started (30s poll, 35s offset)')

  const inboxNudgeInterval = webOnly ? undefined : startInboxNudgeWatcher()
  if (!webOnly) logger.info('Inbox nudge watcher started (20s poll, 55s offset)')

  const reauthHealerInterval = webOnly ? undefined : startReauthHealer()
  if (!webOnly && reauthHealerInterval) logger.info('Reauth healer started (3min poll, 90s offset)')

  const uncommittedInterval = webOnly ? undefined : startUncommittedWorkWatcher()
  if (!webOnly) logger.info('Uncommitted-work watcher started (1h poll, 6min offset)')

  const limitWakeInterval = webOnly ? undefined : startLimitWakeRunner()
  if (!webOnly && limitWakeInterval) {
    logger.info(`Limit-reset wake runner started (${LIMIT_WAKE_INTERVAL_MS / 1000}s poll, ${LIMIT_WAKE_INITIAL_DELAY_MS / 1000}s offset)`)
  }

  const autoRestartInterval = webOnly ? undefined : startAutoRestartRunner()
  if (!webOnly) logger.info('Auto-restart runner started (60s poll, 40s offset)')

  const modelFallbackInterval = webOnly ? undefined : startModelFallbackRunner()
  if (!webOnly) logger.info('Model-fallback runner started (60s poll, 50s offset)')

  const contextGuardInterval = webOnly ? undefined : startContextGuardRunner()
  if (!webOnly) logger.info('Context-guard runner started (5min poll, 4.5min initial delay)')

  if (!webOnly) {
    startContextRestartGateRunner()
    logger.info('Context-restart gate runner started (per-agent poll, 3min initial delay)')
  }

  const updateCheckerInterval = webOnly ? undefined : startUpdateChecker()
  if (!webOnly) logger.info('Update checker started (15min poll)')

  const federationPollerInterval = webOnly ? undefined : startFederationPoller()
  if (!webOnly) logger.info('Federation manifest poller started (10min poll, 25s offset)')

  const capabilityRunnerInterval = webOnly ? undefined : startCapabilitySummaryRunner()

  // Code bridge: lease reaper + the optional dedicated /code Telegram bot.
  // Both are no-ops when the bridge is off or no CODE_BOT_TOKEN is set.
  if (!webOnly) { startCodeBridgeRunner(); startCodeBotPoller() }
  if (!webOnly) logger.info('Capability summary runner started (5min poll, 65s offset; idle while federation is off)')

  // Collect token usage from JSONL transcripts every hour so the run-history
  // token estimates stay fresh without requiring a manual dashboard visit.
  // Sweep timed-out pending approvals every minute
  const approvalTimeoutInterval = startApprovalTimeoutSweeper()

  // Dispatched reviews that never came back (Boss 2026-08-23: "Folyamatban
  // (0/4)" counters on approvals from two weeks earlier). Nudges on a schedule
  // that follows the agent's STATE, then a terminal 'noresponse' -- see
  // approval-verification-sweep.ts. The startup call is the half that matters
  // after a restart: whatever was in flight when the machine went down has
  // nobody left to answer it.
  //
  // The sweep is async now (deciding "is this agent idle?" reads its pane), so
  // the catch has to be on the promise -- a plain try/catch around the call
  // would let a rejection escape as an unhandled one and take the process down.
  const runVerificationSweep = () => {
    void sweepApprovalVerifications().catch((err: unknown) => {
      logger.warn({ err }, 'Stale approval-verification sweep failed')
    })
  }
  runVerificationSweep()
  const verificationSweepInterval = setInterval(runVerificationSweep, VERIFICATION_SWEEP_INTERVAL_MS)

  // Hourly sweep of expired browser-login sessions (7d idle / 30d absolute).
  // Runs regardless of WEB_ONLY -- it is a cheap indexed delete on the shared DB
  // and keeps auth_sessions from growing unboundedly on any instance.
  const authSessionSweepInterval = setInterval(() => {
    try {
      // File claims decay by timestamp, so a stale row never affects a decision
      // -- but nothing deleted them unless someone opened the dashboard page.
      const sweptClaims = sweepExpiredClaims()
      if (sweptClaims > 0) logger.info({ swept: sweptClaims }, 'Expired file claims swept')
      const swept = sweepExpiredSessions()
      if (swept > 0) logger.info({ swept }, 'Expired auth sessions swept')
      const sweptKeys = sweepExpiredDeviceKeys()
      if (sweptKeys > 0) logger.info({ swept: sweptKeys }, 'Expired device keys swept')
    } catch (err) {
      logger.warn({ err }, 'Auth session sweep failed')
    }
  }, 60 * 60 * 1000)

  // A Kuka nem raktar: ami LIFE_TRASH_DAYS napnal regebben kerult bele, magatol
  // elmegy. (Boss keresere, 2026-08-22.) A hatarideig barmikor visszahozhato.
  const kukaSepres = () => {
    try {
      const napok = Number(getEffectiveSettingValue('LIFE_TRASH_DAYS'))
      const r = autoPurgeTrash(napok)
      if (r.torolt > 0) logger.info({ torolt: r.torolt, napok }, 'Az Intezo Kukaja automatikusan urult')
    } catch (err) {
      logger.warn({ err }, 'A Kuka automatikus uritese nem futott le')
    }
  }
  kukaSepres()
  const kukaSepresInterval = setInterval(kukaSepres, 24 * 60 * 60 * 1000)

  const tokenCollectInterval = webOnly ? undefined : setInterval(() => {
    collectTokenUsage().catch(err => logger.warn({ err }, 'Periodic token usage collection failed'))
  }, 60 * 60 * 1000)
  if (!webOnly) {
    collectTokenUsage().catch(err => logger.warn({ err }, 'Startup token usage collection failed'))
    logger.info('Token usage auto-collect started (1h poll + startup)')
  }

  // NOTE: startMcpListChecker() is intentionally NOT called here.
  //
  // Root cause: calling `claude mcp list` at boot time (30s delay) spawns the
  // Telegram plugin for a health check. The plugin claims the bot-token poller
  // slot, which 409-kills the live session-bridge process that already holds
  // the same token. On every deploy this caused the Telegram channel to go
  // offline within 33s of startup (3/3 observed deploys, 2026-06-04).
  //
  // The Connectors page already has a manual "Refresh" button that calls
  // refreshMcpListCache() on demand. The cache starts empty; users see their
  // connectors after the first manual refresh.
  //
  // Related: PR #269 fixed a DIFFERENT 409 source (runtime poller-flapping /
  // channel-coordinator 409 cooldown hysteresis). That fix and this one are
  // complementary -- both 409 vectors must be addressed.

  // Warm the Marveen bot username cache so /api/marveen returns @username on
  // the first dashboard load. Re-fetched lazily otherwise.
  refreshMarveenBotUsername().catch(() => {})

  // Reconcile the federation onboarding block in the main agent's CLAUDE.md
  // EARLY (before the channels session may read the file) and only on live
  // instances: a WEB_ONLY staging copy must never rewrite the persona file
  // (do NOT copy the hook backfill's ungated placement). The ensure heals
  // the two known loss vectors: update.sh --regen-claudemd and a stale
  // dashboard-editor buffer PUT.
  if (!webOnly) {
    ensureFederationClaudeMdSection()
    ensureAutonomySection(MAIN_AGENT_ID)
  }

  // Backfill the PreCompact hook into existing agents' settings.json so the
  // auto-skill / auto-memory flow runs on context compaction. No-op if the
  // agent already has its own hooks block.
  //
  // Guarded: a worktree checkout or a WEB_ONLY staging instance must NEVER
  // register hooks -- its PROJECT_ROOT is temporary, and baking it into the
  // user-global ~/.claude/settings.json leaves stale absolute paths behind
  // once the worktree is deleted. A failing (exit 2) UserPromptSubmit hook
  // then BLOCKS every prompt and deafens the main agent (2026-07-11 incident).
  const hookDecision = shouldRegisterHooks({ projectRoot: PROJECT_ROOT, webOnly, tmpDir: tmpdir() })
  if (!hookDecision.register) {
    logger.info({ reason: hookDecision.reason, projectRoot: PROJECT_ROOT }, 'Hook registration skipped')
  } else {
    try {
      const patched: string[] = []
      const stalePatched: string[] = []
      const egressPatched: string[] = []
      const govPatched: string[] = []
      const skillsLinked: string[] = []
      const pruned: string[] = []
      const askBackWritten: string[] = []
      const askBackNoFile: string[] = []
      const askBackUnreadable: string[] = []
      // Include the main agent (MAIN_AGENT_ID) so the voice hook is also seeded
      // into ~/.claude/settings.json alongside existing hooks (e.g. telegram_progress.py).
      for (const agentName of [MAIN_AGENT_ID, ...listAgentNames()]) {
        // Self-heal FIRST: drop entries this app previously wrote whose script
        // file no longer exists (e.g. a deleted worktree instance's paths), so
        // the re-registration below lands on a clean, unblocked settings file.
        pruned.push(...pruneStaleHooksFromSettingsFile(agentSettingsPath(agentName)))
        if (ensureAgentHooks(agentName)) patched.push(agentName)
        if (ensureAgentStalenessHook(agentName)) stalePatched.push(agentName)
        if (ensureEgressGate(agentName)) egressPatched.push(agentName)
        if (ensureGovernanceGatesRemoved(agentName)) govPatched.push(agentName)
        // Same knowledge for everyone, not just the supervisor (CLAUDE.md,
        // agens-paritas): link the agent at the shared skill library.
        if (ensureAgentSkills(agentName)) skillsLinked.push(agentName)
        ensureQuarantineReader(agentName)
        // The mandatory ask-back rule reaches EXISTING agents here, on boot --
        // not only on the next respawn. A rule that only new agents get is not
        // a fleet rule (Boss, 2026-08-24: "mindenhova tedd be").
        const askBack = ensureAskBackSection(agentName)
        if (askBack === 'written') askBackWritten.push(agentName)
        if (askBack === 'no-file') askBackNoFile.push(agentName)
        if (askBack === 'unreadable') askBackUnreadable.push(agentName)
        // Same treatment for the recheck rule (never restate a fact without
        // measuring it again). Its outcome is folded into the same three lists:
        // what matters per agent is "did every mandatory rule reach it".
        const recheck = ensureRecheckSection(agentName)
        if (recheck === 'written' && !askBackWritten.includes(agentName)) askBackWritten.push(agentName)
        if (recheck === 'unreadable' && !askBackUnreadable.includes(agentName)) askBackUnreadable.push(agentName)
        // ...and the wake greeting (first sentence after waking is a hello on
        // the owner's channel). Same folding: per agent what matters is
        // "did every mandatory rule reach it", not which one was missing.
        const greeting = ensureWakeGreetingSection(agentName)
        if (greeting === 'written' && !askBackWritten.includes(agentName)) askBackWritten.push(agentName)
        if (greeting === 'unreadable' && !askBackUnreadable.includes(agentName)) askBackUnreadable.push(agentName)
        // ...and the delegate-availability rule (check the recipient is online
        // BEFORE handing off work, 2026-08-29). Same folding as the others.
        const delegateCheck = ensureDelegateCheckSection(agentName)
        if (delegateCheck === 'written' && !askBackWritten.includes(agentName)) askBackWritten.push(agentName)
        if (delegateCheck === 'unreadable' && !askBackUnreadable.includes(agentName)) askBackUnreadable.push(agentName)
      }
      // ...and once machine-wide. An agent whose working directory is a git
      // worktree never loads agents/<name>/CLAUDE.md; ~/.claude/CLAUDE.md is
      // the only file every Claude Code session reads no matter where it runs.
      ensureGlobalAskBackRule()
      ensureGlobalRecheckRule()
      ensureGlobalWakeGreetingRule()
      ensureGlobalDelegateCheckRule()
      // Zero writes means two different things, so both are said out loud
      // rather than inferred from a count: 'no-file' agents are covered by the
      // machine-wide ~/.claude/CLAUDE.md (a worktree-based agent never loads
      // its own), while an unreadable file means the rule did NOT reach that
      // agent and needs a human.
      if (askBackWritten.length) logger.info({ agents: askBackWritten }, 'ask-back rule written into agent CLAUDE.md')
      if (askBackNoFile.length) logger.info({ agents: askBackNoFile }, 'ask-back rule: agent has no own CLAUDE.md, covered by ~/.claude/CLAUDE.md instead')
      if (askBackUnreadable.length) logger.warn({ agents: askBackUnreadable }, 'ask-back rule could NOT be written: agent CLAUDE.md unreadable')
      if (pruned.length) logger.info({ pruned }, 'Stale hook entries pruned from agent settings.json')
      if (patched.length) logger.info({ patched }, 'PreCompact hook backfilled into agent settings.json')
      if (stalePatched.length) logger.info({ patched: stalePatched }, 'staleness-guard UserPromptSubmit hook backfilled into agent settings.json')
      if (egressPatched.length) logger.info({ patched: egressPatched }, 'egress-gate WebFetch hook backfilled into agent settings.json')
      if (govPatched.length) logger.info({ patched: govPatched }, 'legacy governance hard-gates (email-send + self-pace) stripped from agent settings.json')
      if (skillsLinked.length) logger.info({ linked: skillsLinked }, 'shared skill library linked into agent .claude/skills')
      // Every agent has just been brought up to the template; anything the main
      // agent has BEYOND it means the fleet is drifting apart again (Boss,
      // 2026-08-11: "nincs ilyen hogy az egyik igy fog viselkedni a masik meg
      // ugy"). Reported, never silently patched -- the fix belongs in the repo.
      // Both halves must be clean before claiming parity: the log used to say
      // "verified" while agents were running without the shared skill library,
      // because only the hook drift was consulted (lackor3's review).
      const parity = checkAgentParity()
      if (parity.drift.length === 0 && parity.skillGaps.length === 0) {
        logger.info('Agent parity verified: every agent shares the same hooks and skill library')
      }
    } catch (err) {
      logger.warn({ err }, 'Agent hook backfill skipped')
    }
  }

  try {
    ensureDefaultScheduledTasks()
    logger.info('Default scheduled tasks seeded')
  } catch (err) {
    logger.warn({ err }, 'Scheduled tasks seed skipped')
  }

  try {
    sweepOrphanedBackgroundTasks()
  } catch (err) {
    logger.warn({ err }, 'Background task sweep skipped')
  }

  try {
    const swept = sweepOrphanTaskStates(Date.now())
    if (swept > 0) logger.info({ swept }, 'Orphan agent task-state records swept')
  } catch (err) {
    logger.warn({ err }, 'Task-state orphan sweep skipped')
  }

  const origClose = server.close.bind(server)
  server.close = (cb?: (err?: Error) => void) => {
    clearInterval(routerInterval)
    clearInterval(telegramWakeInterval)
    clearInterval(scheduleInterval)
    if (pluginMonitorInterval) clearInterval(pluginMonitorInterval)
    workerLivenessCancelled = true
    if (workerLivenessInterval) clearInterval(workerLivenessInterval)
    clearInterval(channelHealthInterval)
    if (costsSyncInterval) clearInterval(costsSyncInterval)
    if (windowLayoutSyncInterval) clearInterval(windowLayoutSyncInterval)
    clearInterval(stuckInputInterval)
    clearInterval(stuckToolCallInterval)
    if (inboxNudgeInterval) clearInterval(inboxNudgeInterval)
    if (reauthHealerInterval) clearInterval(reauthHealerInterval)
    if (limitWakeInterval) clearInterval(limitWakeInterval)
    if (uncommittedInterval) clearInterval(uncommittedInterval)
    clearInterval(autoRestartInterval)
    clearInterval(modelFallbackInterval)
    clearInterval(contextGuardInterval)
    clearInterval(approvalTimeoutInterval)
    clearInterval(verificationSweepInterval)
    clearInterval(authSessionSweepInterval)
    clearInterval(kukaSepresInterval)
    clearInterval(updateCheckerInterval)
    if (federationPollerInterval) clearInterval(federationPollerInterval)
    if (capabilityRunnerInterval) clearInterval(capabilityRunnerInterval)
    clearInterval(tokenCollectInterval)
    return origClose(cb)
  }

  return server
}
