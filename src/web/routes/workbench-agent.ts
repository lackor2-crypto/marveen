// AI Munkapad -- agent-vegpontok (kanban #336, 740b432a, 2. fazis).
//
//   GET  /api/workbench/agent/status?project=<id>   -- van-e szolgaltato, hol all a kozos keret
//   POST /api/workbench/agent/message               -- uzenet kuldese, STREAMELT valasz (SSE)
//   GET  /api/workbench/agent/session?workItem=<id> -- a beszelgetes eddigi uzenetei + tool-hivasai + fut-e valasz
//   POST /api/workbench/agent/stop                  -- a futo valasz leallitasa (a szerveren is)
//   GET  /api/workbench/agent/config                -- modell + VAN-E kulcs (a kulcs SOSE jon vissza)
//   POST /api/workbench/agent/config                -- modell / kulcs beallitasa a feluletrol
//
// A chat FELULETE a 3. fazise. Ez a vegpont mar most meghivhato a feluletrol
// (fetch + ReadableStream) es teszthelheto.
//
// Minden hiba `{ error: <kod>, message: <emberi mondat> }` alaku, a keres
// nyelven. A streamben ugyanez `event: notice` / `event: error` sorkent jon.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { json, readBody } from '../http-helpers.js'
import { getEffectiveSettingValue, setOverride } from '../../settings-store.js'
import { APP_LANG, MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR, WEB_PORT } from '../../config.js'
import { getProject } from '../../projects.js'
import { getWorkItem } from '../../workbench.js'
import { ensureWorkbenchAgent } from '../../workbench-agent/index.js'
import { msg, type Lang } from '../../workbench-agent/messages.js'
import { settleWorkbenchApprovals } from '../../workbench-agent/approved-runner.js'
import { pickAIProvider } from '../../workbench-agent/provider.js'
import { getRemaining } from '../../workbench-agent/usage-manager.js'
import { workbenchAccountStatuses, isKnownWorkbenchAccount, workbenchAccounts, noteLimitAnswer } from '../../workbench-agent/accounts.js'
import {
  runTurn, validateTurn, MESSAGE_MAX_CHARS, turnKey, isTurnRunning, claimTurn, releaseTurn,
} from '../../workbench-agent/orchestrator.js'
import { decideWorkbenchBackend } from '../../workbench-agent/backend-router.js'
import { runCodeBridgeTurn, buildCodeBridgePrompt, codeBridgeContinuable } from '../../workbench-agent/code-bridge-turn.js'
import {
  setBridgeContinuationHandler, watchBridgeTask, unwatchBridgeTask, markBridgeTaskContinued, wasBridgeTaskContinued,
} from '../../workbench-agent/bridge-continuation.js'
import { LiveSessionPool, realLiveDeps, guardSettingsJson, type LiveStartSpec } from '../../workbench-agent/live-session.js'
import { loggedInConfigDir, STRIPPED_ENV } from '../../workbench-agent/provider-anthropic.js'
import { tryResolveFromPath } from '../../platform.js'
import { codeBridgeHealth, enqueueCodeTask, getCodeTask, cancelCodeTask, activeWorkbenchTaskForChat, effectiveRunSessionId, findCodeTabLocation, type CodeTask } from '../code-bridge-store.js'
import { projectFileTarget } from '../../project-files.js'
import {
  ensureAgentTables, getAgentSession, listAgentMessages, listToolCalls, openSessionForWorkItem, projectSessionKey, addAgentMessage,
  addAgentMessageOnce, startToolCall, finishToolCall,
} from '../../workbench-agent/sessions.js'
import { TOOLS } from '../../workbench-agent/tools.js'
import type { RouteContext } from './types.js'
import { listWorkItemAssetsSynced, withDocState } from '../../workbench-assets.js'
import { docKind } from '../../workbench-docread.js'
import { DASHBOARD_TOKEN_PATH } from '../dashboard-auth.js'
import type { WorkItemRow } from '../../workbench.js'
import { createTranscriptToolFeed, type TranscriptToolFeed } from '../../workbench-agent/code-bridge-tool-feed.js'
import { isSafeTranscriptPath, locateLocalTranscript } from '../code-conversation.js'
import { toLocalWorkspacePath } from '../code-bridge-workspace.js'

/** A helyi munkamenet eszkozfutasa, amit meg nem zartunk le (id + nev). */
type LiveOpenTool = { id: string; name: string }

/** Where a running code-bridge task's Claude Code writes its transcript, on
 *  THIS machine -- or `null` when it cannot be seen from here (then only the
 *  single bridge row shows, as before). */
function codeTaskTranscript(t: CodeTask): string | null {
  const sid = effectiveRunSessionId(t)
  if (!sid) return null
  const local = locateLocalTranscript(sid)
  if (local) return local
  const reported = findCodeTabLocation(sid)?.tab.transcriptPath
  if (!reported || !isSafeTranscriptPath(reported, sid)) return null
  const p = toLocalWorkspacePath(reported)
  return p && existsSync(p) ? p : null
}

/** A teljes erteku ugynok eszkozfutasait is elmentjuk (#434, Boss 2026-09-29:
 *  "Hol van ketteosztva? Meg mindig nem latom."). Eddig csak elo ment at a
 *  bongeszobe, igy F5 / elnavigalas utan a Parancsfutasok sav ures maradt. */
function recordLiveTool(sessionId: string, open: LiveOpenTool[], ev: { name?: string; status?: string; detail?: string }): void {
  const name = String(ev.name || '')
  if (!name) return
  try {
    if (ev.status === 'running') {
      const row = startToolCall(sessionId, name, ev.detail ? { detail: ev.detail } : undefined)
      open.push({ id: row.id, name })
      return
    }
    if (ev.status !== 'ok' && ev.status !== 'error') return
    for (let i = 0; i < open.length; i++) {
      if (open[i].name !== name) continue
      finishToolCall(open[i].id, ev.status, null)
      open.splice(i, 1)
      return
    }
  } catch { /* a naplozas hibaja nem allithatja meg a valaszt */ }
}

/** A kod-hid promptjanak munkadarab-resze: nev, fajta, sajat mappa, anyagok (#441),
 *  es ha van kozottuk irat, hogyan kerje le az oldalak szoveget (1/A). */
function codeBridgeWorkItem(item: WorkItemRow): { title: string; type: string; folder: string | null; materials: string[]; documentsHint: string | null } {
  let materials: string[] = []
  let hasDoc = false
  try {
    materials = withDocState(listWorkItemAssetsSynced(item.id)).map((a) => {
      if (docKind(a.name)) hasDoc = true
      const d = a.doc
      const docNote = !d ? ''
        : d.status === 'done' ? `, ${d.pages_total} page(s)${d.low_pages.length ? `, hard to read: p. ${d.low_pages.join(', ')}` : ''}`
        : d.status === 'failed' ? ', reading failed'
        : ', being read'
      return `${a.project_path || a.path} [${a.support}${docNote}${a.shared ? ', shared' : ''}${a.present ? '' : ', missing'}]`
    })
  } catch { materials = [] }
  const documentsHint = hasDoc
    ? `Documents among the materials (PDF, scans, office files, e-mails, photographed papers) are read page by page on this machine, text recognition included. Use THESE page texts (not your own PDF reading) when you quote: curl -s -H "Authorization: Bearer $(cat ${DASHBOARD_TOKEN_PATH})" "http://localhost:${WEB_PORT}/api/workbench/items/${item.id}/document?path=<path inside the project folder, URL-encoded>" gives the page list; add &from=N&to=M for the verbatim text of pages. Quote word for word and cite as [file:page]. Pages marked hard to read are not a source of facts until the owner checks them. Before you rely on a quote, have it machine-checked: POST the same URL base + /document/verify with JSON {"path":"...","page":N,"quote":"..."} (verified / low_page / other_page / not_found); never present a not_found quote as a fact.`
    : null
  const docTools = `Official documents (letters, court filings) are kept as a structured document with sources, not as a file: call the Workbench document tools with curl -s -X POST -H "Authorization: Bearer $(cat ${DASHBOARD_TOKEN_PATH})" -H "Content-Type: application/json" "http://localhost:${WEB_PORT}/api/workbench/items/${item.id}/doc-tool" -d '{"tool":"doc.outline","input":{}}'. Tools: doc.outline, doc.addSection {title}, doc.updateSection {section,title,status}, doc.addBlock {section,text,kind}, doc.updateBlock {block,text}, doc.proposeRewrite {block,text,style: simpler|formal|other}, doc.addAnnex {path,title,position}, doc.updateAnnex {annex,title,position}, doc.removeAnnex {annex}, doc.annexes, doc.annexSettings {scheme,prefix,mode}, doc.addClaim {block,text,sources:[{kind:"document",path,page,quote}|{kind:"owner",said}|{kind:"official",citation,url,quote}|{kind:"inference",based_on:[claim ids]}]}, doc.check. Every factual statement needs a claim with a source; write "⚠ Hiányzó adat: ..." where one is missing. Only the owner can confirm their own statements, with a click. Write in the official register of the document's language and target court. When the owner asks to make a block simpler (egyszerűbben) or more formal (hivatalosabban), do not overwrite it: use doc.proposeRewrite, keeping the facts and the verbatim text of its sourced claims; the owner accepts or dismisses it with a click. The draft PDF (watermarked) of the structure: GET http://localhost:${WEB_PORT}/api/workbench/items/${item.id}/outline/pdf with the same Authorization header (save it with curl -o to look at it). An editable Word file (DOCX, real heading styles and footnotes, for a lawyer to keep editing) of the same structure: GET http://localhost:${WEB_PORT}/api/workbench/items/${item.id}/outline/docx; when the owner asks for a Word version, point them to the "Word (DOCX)" button next to the draft PDF. The final PDF is made only by the owner, after doc.check passes and they reviewed it; you can not finalize.`
  const hints = [documentsHint, item.type === 'document' ? docTools : null].filter(Boolean).join('\n')
  return { title: item.title, type: item.type, folder: item.folder ?? null, materials, documentsHint: hints || null }
}

/** Egy agens-fordulo leghosszabb ideje (tobb tool-korrel egyutt). */
const TURN_MAX_MS = 15 * 60 * 1000
/** Az allo munkamenet egy fordulojanak KEMENY felso korlatja. 2026-09-29-ig
 *  ez 60 perc volt, falora szerint -- es a hosszu, de ELO munkat is kilotte
 *  (Boss: "timed out after 3600 s ... eleg sokszor hibara fut"). Egy beakadt
 *  folyamatot a CSEND jelez, nem a hossz: azt a `LIVE_IDLE_MAX_MS` fogja. */
const LIVE_TURN_MAX_MS = 4 * 60 * 60 * 1000
/** Ennyi ideig tartó teljes csend (semmi szoveg, semmi eszkoz-esemeny) utan
 *  all le a fordulo. Egy Claude Code eszkoz-hivas legfeljebb 10 perc. */
const LIVE_IDLE_MAX_MS = 30 * 60 * 1000

let livePool: LiveSessionPool | null = null
function getLivePool(): LiveSessionPool {
  if (!livePool) {
    const pool = new LiveSessionPool(realLiveDeps(STORE_DIR))
    // A dashboard leallasakor az allo folyamatok se maradjanak arvan (merve:
    // a szulo halala utan a CLI tovabb futott). A kovetkezo uzenet folytatja.
    process.once('exit', () => pool.stopAll())
    livePool = pool
  }
  return livePool
}

/** Hatter-kornyezet, amibol NEM orokolhet a munkamenet: a fiok-/modell-
 *  felulirasok es a csatorna-/agens-identitas (Telegram allapot, agens-id). */
const LIVE_STRIPPED_ENV = [...STRIPPED_ENV, 'TELEGRAM_STATE_DIR', 'TELEGRAM_BOT_TOKEN', 'MARVEEN_AGENT_ID', 'CLAUDE_PROJECT_DIR']

/**
 * Az allo munkamenet inditasi adatai, vagy null, ha helyben nem indithato
 * (nincs `claude` CLI, vagy nincs bejelentkezett fiok) -- olyankor a regi
 * utak (kod-hid / projekt-asszisztens) jonnek. Semmi beegetve: a fiok a
 * Munkapad fiokvalasztasa, a mappa a projekt sajat mappaja.
 */
/** Csak teszthez: sajat (hamis folyamatu) pool. null = a valodi. */
export function setWorkbenchLivePoolForTest(p: LiveSessionPool | null): void {
  livePool?.stopAll()
  livePool = p
}

/** Meddig nem a kod-hid az elso valasztas, mert a fiokja limitbe futott
 *  (#434). Utana ujra probaljuk: a limit lejarhat, vagy a VS Code-ban mas
 *  fiokkal jelentkeztek be. */
let bridgeLimitedUntil = 0
const BRIDGE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000
/** Csak teszthez: a kod-hid limit-emlekenek torlese. */
export function resetWorkbenchBridgeLimitForTest(): void { bridgeLimitedUntil = 0 }

/**
 * Interrupted full-agent turns (#434, Boss TG 1770: "frissites utan azonnal
 * folytasa a felbeszakadt munkat!"). A live turn is recorded here when it
 * starts and removed when it ends (answer, error, Stop or the cap). A restart
 * (deploy, crash) kills the process without running that cleanup, so whatever
 * is still recorded at the next start was cut off -- and is resumed.
 */
interface InflightTurn {
  projectId: string
  workItemId: string | null
  account?: string
  lang: Lang
  actor: string
  startedAt: number
  /** How many times this turn was already resumed after a restart. */
  resumes: number
}
/** A resume older than this is no longer "the work that just stopped". */
const INFLIGHT_MAX_AGE_MS = 2 * 60 * 60 * 1000
/** A turn that keeps dying with the process is not retried forever. */
const INFLIGHT_MAX_RESUMES = 2
/** Wait a little after startup so the rest of the server is up. */
const INFLIGHT_RESUME_DELAY_MS = 5_000

// Under the test runner the record stays in memory unless a test names a file.
let inflightFile: string | null = process.env.VITEST ? null : join(STORE_DIR, 'workbench-inflight.json')
let inflightMem: Record<string, InflightTurn> = {}
/** Keys whose resume is scheduled but has not claimed the turn yet. */
const pendingResume = new Set<string>()
/** Keys being resumed now: live backend, and the prompt is saved as a notice. */
const resumingTurns = new Map<string, number>()

/** Test only: persist the in-flight record to this file (null = memory). */
export function setWorkbenchInflightFileForTest(path: string | null): void {
  inflightFile = path
  inflightMem = {}
  pendingResume.clear()
  resumingTurns.clear()
}

function readInflight(): Record<string, InflightTurn> {
  if (!inflightFile) return { ...inflightMem }
  try {
    const v = JSON.parse(readFileSync(inflightFile, 'utf-8'))
    return v && typeof v === 'object' ? v as Record<string, InflightTurn> : {}
  } catch {
    return {}
  }
}

function writeInflight(all: Record<string, InflightTurn>): void {
  if (!inflightFile) { inflightMem = all; return }
  try {
    const tmp = `${inflightFile}.tmp`
    writeFileSync(tmp, JSON.stringify(all))
    renameSync(tmp, inflightFile)
  } catch { /* a missing record only costs the auto-resume, never the turn */ }
}

function markInflight(key: string, t: InflightTurn): void {
  const all = readInflight()
  all[key] = t
  writeInflight(all)
}

function clearInflight(key: string): void {
  const all = readInflight()
  if (!(key in all)) return
  delete all[key]
  writeInflight(all)
}

/**
 * Called once at server start: every live turn a restart cut off continues by
 * itself, in the same chat and (via the saved Claude session id) with the same
 * context. Returns the resumed keys. `run` is injectable for tests.
 */
export function resumeInterruptedWorkbenchTurns(opts: {
  now?: number
  delayMs?: number
  run?: (key: string, t: InflightTurn) => Promise<void>
} = {}): string[] {
  const now = opts.now ?? Date.now()
  const all = readInflight()
  writeInflight({})
  const keys: string[] = []
  for (const [key, t] of Object.entries(all)) {
    if (!t || typeof t.projectId !== 'string') continue
    if (now - Number(t.startedAt || 0) > INFLIGHT_MAX_AGE_MS) continue
    if (Number(t.resumes || 0) >= INFLIGHT_MAX_RESUMES) continue
    keys.push(key)
    pendingResume.add(key)
    const run = opts.run ?? resumeTurn
    const go = (): void => {
      run(key, t)
        .catch(() => { /* the chat shows the interrupted state as before */ })
        .finally(() => { pendingResume.delete(key) })
    }
    const delay = opts.delayMs ?? INFLIGHT_RESUME_DELAY_MS
    if (delay <= 0) go()
    else { const tm = setTimeout(go, delay); if (typeof tm.unref === 'function') tm.unref() }
  }
  return keys
}

/** Runs the resume through the normal message route, so every rule of a turn
 *  (lock, Stop, cap, saving, tool panel) applies unchanged. */
async function resumeTurn(key: string, t: InflightTurn): Promise<void> {
  const body = { project_id: t.projectId, work_item_id: t.workItemId, message: msg('live_resume_prompt', t.lang), account: t.account ?? '' }
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]) as unknown as RouteContext['req']
  const sink = new Writable({ write(_c, _e, cb) { cb() } })
  const res = Object.assign(sink, { writeHead() { return res } }) as unknown as RouteContext['res']
  const url = new URL(`http://localhost/api/workbench/agent/message?lang=${t.lang}`)
  resumingTurns.set(key, Number(t.resumes || 0) + 1)
  try {
    await tryHandleWorkbenchAgent({
      req, res, path: url.pathname, method: 'POST', url,
      auth: { kind: 'session', user: t.actor },
    } as unknown as RouteContext)
  } finally {
    resumingTurns.delete(key)
  }
}

/** The Workbench turn a code-bridge task belongs to (its chat session). */
function bridgeTaskTurn(task: CodeTask): { key: string; projectId: string; workItemId: string | null; lang: Lang } | null {
  const session = task.chatId ? getAgentSession(task.chatId) : undefined
  if (!session) return null
  const workItemId = session.work_item_id && session.work_item_id !== projectSessionKey(session.project_id)
    ? session.work_item_id
    : null
  return { key: turnKey(session.project_id, workItemId), projectId: session.project_id, workItemId, lang: session.language === 'en' ? 'en' : 'hu' }
}

/** How long a background continuation waits for the chat's turn lock (the
 *  live chat turn that watched the task may still be closing). */
const CONTINUE_LOCK_WAIT_MS = 120_000

/**
 * THE WORK GOES ON WITH ANOTHER ACCOUNT (Boss, 2026-09-29): a Workbench
 * code-bridge task that ended on a usage limit or on the worker's own time
 * limit, with nobody watching it live, continues in the local live session on
 * an account that can work. Runs through the normal message route (like the
 * restart resume), so the lock, Stop, caps, saving and the tool panel all
 * apply. false = no account can take it: the caller shows the real reason.
 */
function continueBridgeTaskInBackground(task: CodeTask): boolean {
  const turn = bridgeTaskTurn(task)
  if (!turn) return false
  if (String(getEffectiveSettingValue('WORKBENCH_FULL_AGENT')) !== '1') return false
  const project = getProject(turn.projectId)
  if (!project) return false
  const folder = projectFileTarget(project, '')
  const next = liveResolver(turn.key, folder.ok ? folder.dirAbs : null, undefined)
  if (!next) return false
  const to = next.account || '?'
  const notice = codeBridgeContinuable(task) === 'limit'
    ? msg('code_bridge_limit_fallback', turn.lang, { to })
    : msg('code_bridge_stalled_fallback', turn.lang, { to })
  const actorName = task.requestedBy || 'dashboard'
  void (async () => {
    const until = Date.now() + CONTINUE_LOCK_WAIT_MS
    while (isTurnRunning(turn.key) && Date.now() < until) await new Promise((r) => setTimeout(r, 1000))
    const body = { project_id: turn.projectId, work_item_id: turn.workItemId, message: msg('bridge_continue_prompt', turn.lang, { notice }), account: '' }
    const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]) as unknown as RouteContext['req']
    const sink = new Writable({ write(_c, _e, cb) { cb() } })
    const res = Object.assign(sink, { writeHead() { return res } }) as unknown as RouteContext['res']
    const url = new URL(`http://localhost/api/workbench/agent/message?lang=${turn.lang}`)
    // Same switch as the restart resume: the live backend, the prompt saved
    // as a notice (not as the owner's words).
    resumingTurns.set(turn.key, 0)
    try {
      await tryHandleWorkbenchAgent({
        req, res, path: url.pathname, method: 'POST', url,
        auth: { kind: 'session', user: actorName },
      } as unknown as RouteContext)
    } catch { /* the chat keeps what it had; nothing to throw out of here */ } finally {
      resumingTurns.delete(turn.key)
    }
  })()
  return true
}
setBridgeContinuationHandler((task) => continueBridgeTaskInBackground(task))

/** `skip`: a fordulo alatt mar limitbe futott fiokok config-konyvtarai (#434). */
type LiveResolver = (key: string, projectFolder: string | null, account: string | undefined, skip?: ReadonlySet<string>) => LiveStartSpec | null
let liveResolver: LiveResolver = (k, f, a, x) => liveSpecFor(k, f, a, x)
/** Csak teszthez: az allo munkamenet elerhetosegenek cserelese (null = valodi). */
export function setWorkbenchLiveResolverForTest(r: LiveResolver | null): void {
  liveResolver = r || ((k, f, a, x) => liveSpecFor(k, f, a, x))
}

/**
 * A munkamenet mappaja. SOSE a telepites mappaja es SOSE egy agens mappaja:
 * a CLI a naplot `<config>/projects/<kodolt mappa>/` ala irja, es tobb resz
 * (active-model, agent-process, a kontextus-kapu) EBBOL a konyvtarbol olvassa
 * egy agens SAJAT munkamenetet. A fo agens fiokjaval a Marvin-mappaban futo
 * munkamenet igy osszekeveredne a fo agens naplojaval.
 */
/** A munkamenet nem a telepites mappajaban fut, tehat a CLAUDE.md-t sem
 *  latja magatol: ha a Marveen sajat kodjahoz kell nyulnia, innen tudja, hol
 *  van es milyen szabalyok szerint (worktree + PR, sosem az elo fa). */
function liveInstallNote(): string {
  return `[MARVEEN INSTALL] ${PROJECT_ROOT} -- before changing ANY Marveen code, skill or rule, read ${join(PROJECT_ROOT, 'CLAUDE.md')} and follow it (own git worktree via scripts/agent-worktree.sh, land via scripts/land-pr.sh; never edit the live tree).\n`
}

function liveCwd(projectFolder: string | null): string {
  const root = resolve(PROJECT_ROOT)
  if (projectFolder && existsSync(projectFolder)) {
    const f = resolve(projectFolder)
    if (f !== root && !f.startsWith(root + '/agents') && !root.startsWith(f + '/')) return f
  }
  const own = join(STORE_DIR, 'workbench-live')
  mkdirSync(own, { recursive: true })
  return own
}

function liveSpecFor(key: string, projectFolder: string | null, account: string | undefined, skip?: ReadonlySet<string>): LiveStartSpec | null {
  // Tesztben SOSE indul valodi `claude` (merve 2026-09-28: egy regi route-teszt
  // igy 6 valodi munkamenetet inditott); a teszt a sajat resolverevel dolgozik.
  if (process.env.VITEST) return null
  const bin = tryResolveFromPath('claude')
  if (!bin) return null
  const candidates = account ? [account] : [...workbenchAccounts(), MAIN_AGENT_ID]
  let configDir: string | null = null
  let accountName = ''
  for (const a of candidates) {
    const d = loggedInConfigDir(a)
    if (d && !skip?.has(d)) { configDir = d; accountName = a; break }
  }
  if (!configDir) return null
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, MARVEEN_WORKBENCH_LIVE: '1' }
  for (const k of LIVE_STRIPPED_ENV) delete env[k]
  const guard = guardSettingsJson(join(PROJECT_ROOT, 'templates', 'settings.json.template'), PROJECT_ROOT)
  const mode = (JSON.parse(guard).permissions?.defaultMode as string) || 'bypassPermissions'
  return {
    key,
    bin,
    configDir,
    cwd: liveCwd(projectFolder),
    env,
    account: accountName,
    baseArgs: [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages',
      '--setting-sources', '', '--strict-mcp-config',
      '--settings', guard, '--permission-mode', mode,
    ],
  }
}
/** A kod-hidas (teljes erteku) fordulo ennyit var a chatben; utana a hatterben
 *  figyeli tovabb, es a kesve erkezo valasz is a beszelgetesbe kerul. */
const CODE_BRIDGE_CHAT_WAIT_MS = TURN_MAX_MS - 30_000

/**
 * Van-e meg dolgozo kod-hid feladat ezen a beszelgetesen (#434). A chat a
 * kod-hid valaszat csak egy ideig varja kozvetlenul; utana a feladat tovabb fut
 * a hatterben. Boss, 2026-09-29: "ne mutassa nekem itt hogy kesz ha meg nincs
 * keszen", es "ha dolgozik akkor is kellene vennie az uj utasitasokat, csak
 * varakozoba kellene tennie" -- ezert amig a feladat nem zarult le, a
 * beszelgetes "fut", az uj uzenet pedig sorba all (nem utasitjuk el).
 */
function bridgeStillWorking(sessionId: string): boolean {
  return !!activeWorkbenchTaskForChat(sessionId)
}
/** Ilyen suruen megy egy SSE-megjegyzes a csendes chat-kapcsolaton. */
export const SSE_PING_MS = 15_000

/**
 * A futo fordulok leallito-kapcsoloja, zar-kulcs szerint. A Leallitas gomb
 * ezen at allitja le a SZERVEREN is a valaszt -- eddig csak a bongeszo
 * olvasasa allt le, a szerveren a fordulo tovabb futott, es amig vegzett,
 * minden uj uzenet "mar fut egy valasz" hibat kapott.
 */
const turnControllers = new Map<string, AbortController>()

function uiLang(url: URL): Lang {
  const v = url.searchParams.get('lang')
  return v === 'en' || v === 'hu' ? v : (APP_LANG === 'en' ? 'en' : 'hu')
}

const LOCAL_MESSAGES: Record<string, { hu: string; en: string }> = {
  project_required: {
    hu: 'Nincs megadva, melyik projekt Munkapadját nyitod meg.',
    en: 'It is not given which project\'s Workbench you are opening.',
  },
  project_not_found: {
    hu: 'Ez a projekt nem található (lehet, hogy közben törölték).',
    en: 'This project was not found (it may have been deleted).',
  },
  work_item_required: {
    hu: 'Nincs megadva, melyik munkadarabról van szó.',
    en: 'It is not given which work item this is about.',
  },
  no_known_settings: {
    hu: 'A kérés egyetlen ismert Munkapad-beállítást sem tartalmazott.',
    en: 'The request contained no known Workbench setting.',
  },
}

function fail(res: RouteContext['res'], status: number, code: string, lang: Lang, message?: string): true {
  const local = LOCAL_MESSAGES[code]
  json(res, { error: code, message: message ?? (local ? local[lang] : code) }, status)
  return true
}

async function readJson(req: RouteContext['req']): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(req)).toString('utf-8').trim()
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Ki kuldi. A bejelentkezett munkamenet neve; semmi beegetve. */
function actor(ctx: RouteContext): string {
  const a = ctx.auth
  if (!a) return 'dashboard'
  if (a.kind === 'session' && a.user) return a.user
  if (a.kind === 'federation' && a.peer) return a.peer
  if (a.kind === 'device' && a.device) return a.device
  return a.kind
}

export async function tryHandleWorkbenchAgent(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (!path.startsWith('/api/workbench/agent')) return false
  const lang = uiLang(url)
  ensureWorkbenchAgent()
  ensureAgentTables()

  // --- allapot: van-e szolgaltato, hol all a kozos keret --------------------
  if (path === '/api/workbench/agent/status' && method === 'GET') {
    const provider = pickAIProvider()
    // A keret annak a fioknak a kerete, amelyikkel a kovetkezo valasz
    // MENNE (#402) -- nem mindig a fo agense.
    let account: string | null = null
    try { account = provider?.accounts?.()[0] || null } catch { account = null }
    const remaining = getRemaining(account || undefined)
    const u = remaining.usage
    json(res, {
      provider: provider
        ? { id: provider.id, model: provider.model(), account, available: true }
        // A ket eset KULONBOZIK: nincs beallitva vs nem latunk oda.
        : { id: null, model: null, available: false, message: msg('no_provider', lang) },
      usage: {
        // usedPct === null = NINCS meres. Nem 0%.
        usedPct: u.usedPct,
        measured: u.usedPct !== null,
        measuredAt: u.measuredAt,
        stale: u.stale,
        resetsAt: u.resetsAt,
        tier: u.tier,
        inFlight: u.inFlight,
        message: u.usedPct === null ? msg('usage_unknown', lang) : null,
      },
      allowed: remaining.allowed,
      blockedReason: remaining.reason,
      // #426: MINDEN bejelentkezett fiok, elo zold/piros allapottal -- a
      // feluleti fiokvalasztohoz. Az elso a jelenlegi 'auto' valasztasa.
      accounts: workbenchAccountStatuses(),
      tools: TOOLS.map((t) => ({
        name: t.name, destructive: t.destructive, reversible: t.reversible,
        external_effect: t.external_effect, autonomyCategory: t.autonomyCategory,
      })),
      maxMessageChars: MESSAGE_MAX_CHARS,
    })
    return true
  }

  // --- modell a feluletrol ----------------------------------------------------
  //
  // Csak a modell allithato. A sajat Anthropic API-kulcs utja a tulajdonos
  // dontesere (#404) kikerult: a Munkapad kizarolag a bejelentkezett
  // Claude-elofizetest hasznalja. Egy POST-ban kuldott regi
  // `WORKBENCH_ANTHROPIC_API_KEY` mezot nem mentunk el (nem ismert beallitas).
  if (path === '/api/workbench/agent/config' && method === 'GET') {
    json(res, { WORKBENCH_MODEL: String(getEffectiveSettingValue('WORKBENCH_MODEL') ?? '') })
    return true
  }

  if (path === '/api/workbench/agent/config' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang, msg('bad_json', lang))
    const saved: string[] = []
    if ('WORKBENCH_MODEL' in body) {
      const raw = body['WORKBENCH_MODEL']
      const out = setOverride('WORKBENCH_MODEL', raw === null ? '' : raw)
      if (!out.ok) return fail(res, 400, 'config_invalid', lang, out.error)
      saved.push('WORKBENCH_MODEL')
    }
    if (saved.length === 0) return fail(res, 400, 'no_known_settings', lang)
    json(res, { saved })
    return true
  }

  // --- egy beszelgetes eddigi tartalma --------------------------------------
  //
  // KET beszelgetes-fajta van, es mindkettot vissza kell tudni olvasni:
  //   ?workItem=<id>  -- egy munkadarabhoz tartozo beszelgetes
  //   ?project=<id>   -- a munkadarab NELKULI, projekt-szintu beszelgetes
  // A masodik nelkul az oldal ujratoltese utan a mar lefolytatott beszelgetes
  // URESNEK latszana, holott ott all az adatbazisban -- vagyis a felulet a
  // "meg nincs semmi"-t es a "nem latok oda"-t osszemosna.
  if (path === '/api/workbench/agent/session' && method === 'GET') {
    const workItemId = (url.searchParams.get('workItem') || '').trim()
    const projectId = (url.searchParams.get('project') || '').trim()
    if (!workItemId && projectId) {
      const project = getProject(projectId)
      if (!project) return fail(res, 404, 'project_not_found', lang)
      const session = openSessionForWorkItem(project.id, projectSessionKey(project.id), lang)
      await settleWorkbenchApprovals(session.id).catch(() => 0)
      json(res, {
        session,
        messages: listAgentMessages(session.id),
        toolCalls: listToolCalls(session.id),
        // Elnavigalas utan visszaterve a felulet ebbol tudja, hogy a valasz
        // meg KESZUL a szerveren (es megvarja), nem pedig elveszett.
        running: isTurnRunning(turnKey(project.id, null)) || pendingResume.has(turnKey(project.id, null)) || bridgeStillWorking(session.id),
      })
      return true
    }
    if (!workItemId) return fail(res, 400, 'work_item_required', lang)
    const item = getWorkItem(workItemId)
    if (!item) return fail(res, 404, 'work_item_not_found', lang, msg('work_item_not_found', lang))
    const session = openSessionForWorkItem(item.project_id, item.id, lang)
    await settleWorkbenchApprovals(session.id).catch(() => 0)
    json(res, {
      session,
      messages: listAgentMessages(session.id),
      toolCalls: listToolCalls(session.id),
      running: isTurnRunning(turnKey(item.project_id, item.id)) || pendingResume.has(turnKey(item.project_id, item.id)) || bridgeStillWorking(session.id),
    })
    return true
  }

  // --- a futo valasz leallitasa ----------------------------------------------
  if (path === '/api/workbench/agent/stop' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang, msg('bad_json', lang))
    const projectId = String(body.project_id ?? '').trim()
    if (!projectId) return fail(res, 400, 'project_required', lang)
    const project = getProject(projectId)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const workItemId = body.work_item_id === undefined || body.work_item_id === null
      ? null
      : String(body.work_item_id).trim() || null
    const key = turnKey(project.id, workItemId)
    const ac = turnControllers.get(key)
    if (ac) ac.abort()
    const liveStopped = livePool ? livePool.stop(key) : false
    // A mar csak a hatterben dolgozo kod-hid feladatot is lezarjuk: a
    // Leallitas azt allitja meg, amit a chat "fut"-nak mutat.
    const stopSession = openSessionForWorkItem(project.id, workItemId ?? projectSessionKey(project.id), lang)
    const bgTask = activeWorkbenchTaskForChat(stopSession.id)
    if (bgTask) { try { cancelCodeTask(bgTask.id) } catch { /* a lezaras hibaja nem uj hiba */ } }
    json(res, {
      stopped: !!ac || liveStopped || !!bgTask,
      running: isTurnRunning(key) || bridgeStillWorking(stopSession.id),
    })
    return true
  }

  // --- uzenet + streamelt valasz -------------------------------------------
  if (path === '/api/workbench/agent/message' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang, msg('bad_json', lang))
    const projectId = String(body.project_id ?? '').trim()
    if (!projectId) return fail(res, 400, 'project_required', lang)
    const project = getProject(projectId)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const workItemId = body.work_item_id === undefined || body.work_item_id === null
      ? null
      : String(body.work_item_id).trim() || null

    // #426: a felhasznalo valaszthat KONKRET fiokot; egy ismeretlen nevet nem
    // engedunk a hivasba (ures / 'auto' / ismeretlen -> a rendes auto-valasztas
    // fut a fallbackkal). Igy egy elgepelt vagy elavult nev nem nemitja el a
    // Munkapadot.
    const wantAccount = String(body.account ?? '').trim()
    const account = wantAccount && wantAccount !== 'auto' && isKnownWorkbenchAccount(wantAccount)
      ? wantAccount
      : undefined

    const input = {
      projectId: project.id,
      workItemId,
      message: String(body.message ?? ''),
      lang,
      actor: actor(ctx),
      account,
    }
    // A streamelés MEGKEZDESE ELOTT rendes HTTP-hiba, hogy a felulet a
    // megszokott modon tudja kiirni.
    const v = validateTurn(input)
    if (!v.ok) return fail(res, v.code === 'work_item_not_found' || v.code === 'project_not_found' ? 404 : 400, v.code, lang, v.message)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const ac = new AbortController()
    // A bongeszo elmenese (elnavigalas, ujratoltes) NEM allitja le a valaszt:
    // a fordulo a szerveren vegigfut es a beszelgetesbe mentodik, visszaterve a
    // felulet betolti (a session-lekeres `running` mezoje mondja meg, hogy meg
    // keszul). Leallitani a Leallitas gomb (/stop) vagy a felso idokorlat tud.
    // Merve (Node 22): a `req` 'close' a body beolvasasa utan mar NEM sul el;
    // a kapcsolat bontasat a `res` 'close' jelzi -- azt csak arra hasznaljuk,
    // hogy ne irjunk egy lezart kapcsolatba.
    let clientGone = false
    res.on('close', () => { clientGone = true })
    // Felso korlat egy fordulora: ha a szolgaltato kapcsolata megakad, a
    // "fut mar" zar ne foghassa orokre a munkadarabot.
    let turnCap = setTimeout(() => ac.abort(), TURN_MAX_MS)
    const key = turnKey(project.id, workItemId)
    // Csak a SAJAT fordulonk kapcsoloja kerul a nyilvantartasba: egy "mar fut"
    // miatt elutasitott keres nem irhatja felul a futoet.
    const ownsController = !turnControllers.has(key)
    if (ownsController) turnControllers.set(key, ac)

    const send = (event: string, data: unknown): void => {
      if (clientGone) return
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { clientGone = true }
    }

    // #433 (B opcio): a teljes erteku mod eldontese. A kapcsolo ALAPBOL ki:
    // ilyenkor a megszokott projekt-asszisztens fut, semmi nem valtozik. Ha be
    // van kapcsolva ES van online kod-hid worker -> a valodi Claude Code
    // sessionhoz iranyitunk; ha be van kapcsolva, de nincs worker, a chat NEM
    // hal meg: setup-jelzest kuldunk, es tovabb fut a megszokott asszisztens.
    const fullAgentEnabled = String(getEffectiveSettingValue('WORKBENCH_FULL_AGENT')) === '1'
    // #434 (C opcio): az allo, helyi munkamenet -- elso ut, ha nincs online
    // kod-hid, ha a kod-hid fiokja kimerult, vagy ha fiokot valasztottak.
    const liveFolder = fullAgentEnabled ? projectFileTarget(project, '') : null
    const liveSpec = fullAgentEnabled
      ? liveResolver(key, liveFolder && liveFolder.ok ? liveFolder.dirAbs : null, account)
      : null
    const workerOnline = fullAgentEnabled ? codeBridgeHealth().workerOnline : false
    // Boss (2026-09-28): ha van online kod-hid, az valaszoljon (a VS Code
    // rendszere); kifejezetten valasztott fioknal a helyi munkamenet fut.
    // An interrupted live turn continues in the live session that has its context.
    const resumeCount = resumingTurns.get(key)
    const bridgeFirst = !account && resumeCount === undefined && Date.now() >= bridgeLimitedUntil
    const decision = decideWorkbenchBackend({ fullAgentEnabled, workerOnline, liveAvailable: !!liveSpec, bridgeFirst })

    // A csendes kapcsolat eletben tartasa (#433): a kod-hidas fordulo percekig
    // nem kuld semmit (csak az elejen es a vegen), es egy kozbeeso proxy vagy
    // a bongeszo a tetlen kapcsolatot lezarhatja -- a valasz akkor mar nem er
    // oda. A `:` kezdetu sor SSE-megjegyzes: a felulet nem esemenykent kezeli.
    const ping = setInterval(() => {
      if (clientGone) return
      try { res.write(': ping\n\n') } catch { clientGone = true }
    }, SSE_PING_MS)

    // Az allo, helyi munkamenet egy fordulója (#434). `prior`: a kod-hid
    // fordulo elotti elozmeny -- a kerdest (es a limit-sort) a kod-hid mar
    // beirta, igy az nem kerul be masodszor sem a naploba, sem a promptba.
    const runLive = async (first: LiveStartSpec, prior?: ReturnType<typeof listAgentMessages>, note?: string): Promise<void> => {
      const item = workItemId ? getWorkItem(workItemId) : null
      const session = item
        ? openSessionForWorkItem(project.id, item.id, lang)
        : openSessionForWorkItem(project.id, projectSessionKey(project.id), lang)
      send('session', { type: 'session', sessionId: session.id })
      // Az elozmeny a mentes ELOTT keszul, kulonben az uj uzenet ketszer
      // allna a promptban.
      const history = prior ?? listAgentMessages(session.id)
      const text = input.message.trim()
      if (!prior) addAgentMessage(session.id, resumeCount !== undefined ? 'system' : 'user', text)
      // What the session is asked: the message, plus -- when the work moves to
      // another account mid-way -- where it stopped (Boss, 2026-09-29).
      let turnText = note ? `${text}\n\n${note}` : text
      // Silence stops a turn, length does not (see LIVE_IDLE_MAX_MS).
      clearTimeout(turnCap)
      const hardCap = setTimeout(() => ac.abort(), LIVE_TURN_MAX_MS)
      const stillAlive = (): void => {
        clearTimeout(turnCap)
        turnCap = setTimeout(() => ac.abort(), LIVE_IDLE_MAX_MS)
      }
      stillAlive()
      markInflight(key, {
        projectId: project.id, workItemId, account, lang, actor: input.actor,
        startedAt: Date.now(), resumes: resumeCount ?? 0,
      })
      try {
        let answer = ''
        let failed = ''
        const openTools: LiveOpenTool[] = []
        // #434: automatikus fiokvalasztasnal a limitbe futott fiok helyett a
        // kovetkezo jon (a tulajdonos: "Mindig azt hasznalja, ahol van").
        // Munka KOZBEN is (Boss, 2026-09-29: "ha van, akkor folytassa azzal a
        // munkat"): a kovetkezo fiok azt is megkapja, meddig jutott az elozo.
        // Kivalasztott fioknal nincs csere. A limit sora csak akkor latszik,
        // ha mar nincs kire valtani.
        const limited = new Set<string>()
        let spec: LiveStartSpec | null = first
        while (spec) {
          const cur: LiveStartSpec = spec
          spec = null
          for await (const ev of getLivePool().turn(
            cur,
            (fresh) => fresh
              ? liveInstallNote() + buildCodeBridgePrompt({
                projectName: project.name || project.id,
                projectFolder: liveFolder && liveFolder.ok ? liveFolder.dirAbs : null,
                workItem: item ? codeBridgeWorkItem(item) : null,
                history,
                message: turnText,
                lang,
              })
              : turnText,
            lang,
            ac.signal,
          )) {
            stillAlive()
            // The CLI's own limit sentence: the account picker shows it red (#434).
            if (ev.type === 'error' && ev.code === 'live_limit') noteLimitAnswer(ev.message, { configDir: cur.configDir })
            if (ev.type === 'error' && ev.code === 'live_limit' && !account) {
              limited.add(cur.configDir)
              const next = liveResolver(key, liveFolder && liveFolder.ok ? liveFolder.dirAbs : null, account, limited)
              if (next && !limited.has(next.configDir)) {
                if (answer.trim()) {
                  turnText = `${text}\n\n${msg('live_switch_continue', lang, { partial: answer.trim().slice(-3000) })}`
                  addAgentMessage(session.id, 'assistant', answer.trim())
                  answer = ''
                }
                // Boss, 2026-09-29: the chat says which account ran out and
                // which one carries on -- not the limit error itself.
                const switched = msg('live_account_switched', lang, { from: cur.account || '?', to: next.account || '?' })
                addAgentMessage(session.id, 'system', switched)
                send('notice', { type: 'notice', code: 'live_account_switched', message: switched })
                spec = next
                break
              }
            }
            if (ev.type === 'text') answer += ev.text
            if (ev.type === 'error') failed = ev.message
            if (ev.type === 'tool') recordLiveTool(session.id, openTools, ev)
            // A kliens elmenetele utan is vegigolvassuk: a valasz igy a
            // beszelgetesbe kerul, nem szakad felbe.
            send(ev.type, ev)
          }
        }
        if (answer.trim()) addAgentMessage(session.id, 'assistant', answer.trim())
        if (failed) addAgentMessage(session.id, 'system', failed)
      } finally {
        clearTimeout(hardCap)
        clearInflight(key)
      }
    }

    try {
      const chatSession = openSessionForWorkItem(project.id, workItemId ?? projectSessionKey(project.id), lang)
      if (bridgeStillWorking(chatSession.id)) {
        // Az elozo uzenet kod-hid feladata meg dolgozik: az uj uzenet nem
        // indit masodik vegrehajtot (es nem is utasitjuk el) -- a felulet a
        // `busy`-bol sorba allitja, es a feladat vegen magatol elkuldi.
        send('error', { type: 'error', code: 'busy', message: msg('busy', lang) })
      } else if (decision.backend === 'live-session' && liveSpec) {
        if (!claimTurn(key)) {
          send('error', { type: 'error', code: 'busy', message: msg('busy', lang) })
        } else {
          try {
            await runLive(liveSpec)
          } finally {
            releaseTurn(key)
          }
        }
      } else if (decision.backend === 'code-bridge') {
        // Ugyanaz a "fut mar" zar, mint a projekt-asszisztensnel: igy a
        // felulet visszaterve latja, hogy keszul a valasz, es a Leallitas is mukodik.
        if (!claimTurn(key)) {
          send('error', { type: 'error', code: 'busy', message: msg('busy', lang) })
        } else {
          try {
            const item = workItemId ? getWorkItem(workItemId) : null
            const session = item
              ? openSessionForWorkItem(project.id, item.id, lang)
              : openSessionForWorkItem(project.id, projectSessionKey(project.id), lang)
            send('session', { type: 'session', sessionId: session.id })
            let liveFallback: LiveStartSpec | null = null
            let bridgeTaskId: string | null = null
            let bridgeStalled = false
            const liveDir = liveFolder && liveFolder.ok ? liveFolder.dirAbs : null
            let bridgeFeed: TranscriptToolFeed | null = null
            const bridgeOpenTools: LiveOpenTool[] = []
            const turnStartSec = Math.floor(Date.now() / 1000)
            const folder = projectFileTarget(project, '')
            const history = listAgentMessages(session.id)
            const prompt = buildCodeBridgePrompt({
              projectName: project.name || project.id,
              projectFolder: folder.ok ? folder.dirAbs : null,
              workItem: item ? codeBridgeWorkItem(item) : null,
              history,
              message: input.message.trim(),
              lang,
            })
            for await (const ev of runCodeBridgeTurn(
              {
                projectRef: project.name || project.id,
                message: input.message,
                prompt,
                lang,
                requestedBy: input.actor ?? null,
                // A valasz ide megy vissza -- ujrainditas utan is (code-bridge-delivery.ts).
                chatId: session.id,
                signal: ac.signal,
              },
              {
                enqueue: (i) => {
                  const r = enqueueCodeTask({ project: i.project, prompt: i.prompt, origin: 'workbench', requestedBy: i.requestedBy, chatId: i.chatId })
                  if ('error' in r) return { ok: false, message: r.error }
                  // While this turn watches the task, IT continues the work on
                  // another account if needed (bridge-continuation.ts).
                  bridgeTaskId = r.task.id
                  watchBridgeTask(r.task.id)
                  return { ok: true, id: r.task.id }
                },
                canContinueElsewhere: () => !account && !ac.signal.aborted && !!liveResolver(key, liveDir, account),
                wasContinued: (id) => wasBridgeTaskContinued(id),
                getTask: (id) => {
                  const t = getCodeTask(id)
                  return t ? { status: t.status, result: t.result, summary: t.summary, error: t.error } : null
                },
                now: () => Date.now(),
                sleep: (ms, signal) => new Promise<void>((resolve) => {
                  const to = setTimeout(resolve, ms)
                  signal?.addEventListener('abort', () => { clearTimeout(to); resolve() }, { once: true })
                }),
                timeoutMs: CODE_BRIDGE_CHAT_WAIT_MS,
                // A valaszt a feladat lezarasakor a szerver is beirja (ujrainditas
                // ellen): ami mar bent van, az nem kerul be masodszor.
                record: (role, content) => {
                  if (!content.trim()) return
                  if (role === 'user') addAgentMessage(session.id, role, content)
                  else addAgentMessageOnce(session.id, role, content, turnStartSec)
                },
                cancel: (id) => { cancelCodeTask(id) },
                toolRuns: (id, finish) => {
                  const t = getCodeTask(id)
                  if (!t) return []
                  if (!bridgeFeed) {
                    if (!t.startedAt) return []
                    bridgeFeed = createTranscriptToolFeed(t.startedAt)
                  }
                  return bridgeFeed.read(codeTaskTranscript(t), finish)
                },
              },
            )) {
              // The bridge's tool runs are saved too, so the panel comes back after F5.
              if (ev.type === 'tool') recordLiveTool(session.id, bridgeOpenTools, ev)
              // A kod-hid fiokja kimerult (#434), vagy a worker leallitotta a
              // futast (idokorlat): automatikus fioknal a helyi munkamenet
              // folytatja egy masik fiokkal, ugyanebben a fordulóban; limitnel
              // egy ideig a kovetkezo uzenetek is egyenesen oda mennek.
              if (ev.type === 'error' && (ev.code === 'code_bridge_limit' || ev.code === 'code_bridge_stalled')) {
                if (ev.code === 'code_bridge_limit') bridgeLimitedUntil = Date.now() + BRIDGE_LIMIT_COOLDOWN_MS
                const fallback = !account && !ac.signal.aborted ? liveResolver(key, liveDir, account) : null
                if (fallback) {
                  liveFallback = fallback
                  bridgeStalled = ev.code === 'code_bridge_stalled'
                  if (bridgeTaskId) markBridgeTaskContinued(bridgeTaskId)
                  break
                }
              }
              // A kliens elmenetele utan is vegigolvassuk: a valasz igy a
              // beszelgetesbe kerul, nem szakad felbe.
              send(ev.type, ev)
            }
            if (bridgeTaskId) unwatchBridgeTask(bridgeTaskId)
            if (liveFallback) {
              const to = liveFallback.account || '?'
              const switched = bridgeStalled
                ? msg('code_bridge_stalled_fallback', lang, { to })
                : msg('code_bridge_limit_fallback', lang, { to })
              addAgentMessage(session.id, 'system', switched)
              send('notice', { type: 'notice', code: 'code_bridge_limit_fallback', message: switched })
              await runLive(liveFallback, history, msg('bridge_continue_note', lang))
            }
          } finally {
            releaseTurn(key)
          }
        }
      } else {
        // Bekapcsolt teljes mod worker nelkul: eloszor a setup-jelzes, aztan a
        // megszokott asszisztens valaszol (sose halott chat).
        if (decision.needsWorkerSetup) {
          send('notice', { type: 'notice', code: 'code_bridge_no_worker', message: msg('code_bridge_no_worker', lang) })
        }
        for await (const ev of runTurn({ ...input, signal: ac.signal })) {
          // A kliens elmenetele utan is vegigolvassuk (lasd fent).
          send(ev.type, ev)
        }
      }
    } catch (e) {
      // SOSE talalgatjuk az okot: a tenyleges hiba megy ki.
      send('error', { type: 'error', code: 'internal', message: msg('provider_failed', lang, { detail: e instanceof Error ? e.message : String(e) }) })
    } finally {
      clearTimeout(turnCap)
      clearInterval(ping)
      if (ownsController && turnControllers.get(key) === ac) turnControllers.delete(key)
    }
    if (!clientGone) { try { res.end() } catch { /* mar lezarult */ } }
    return true
  }

  return false
}
