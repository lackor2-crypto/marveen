// code-bridge-store: the session map + task queue behind the VS Code Claude Code
// bridge.
//
// WHY A BRIDGE AT ALL
// The Claude Code VS Code extension exposes exactly one external control surface:
// the URI handler `vscode://anthropic.claude-code/open?session=<id>&prompt=<text>`
// (-> command `claude-vscode.primaryEditor.open`). Measured on 2.1.237: that path
// only PREFILLS the composer (`setInputText`) and never submits, and when the
// target session's panel is already open it drops the prompt entirely and shows
// "enter it manually". So it cannot execute a task. GUI automation (AutoHotKey,
// synthetic clicks/keys, clipboard, window focus) is ruled out by design.
//
// The executor is therefore the Windows `claude.exe` CLI in headless mode:
//   claude -p "<prompt>" --resume <sessionId> --output-format json
// Measured on 2.1.226: it returns the SAME session_id, remembers the previous
// turns and APPENDS to the SAME transcript (~/.claude/projects/<enc-cwd>/<id>.jsonl)
// -- i.e. the existing session with its full history is reused, no fork, no new
// session per task. The VS Code panel stays the human-facing viewer of that very
// conversation.
//
// WHY THE WINDOWS SIDE POLLS US
// Marveen runs in WSL, Claude Code runs on Windows. On this machine /mnt/c and
// /mnt/d are mounted but every access returns EIO, and there is no passwordless
// sudo to remount -- so WSL can neither exec the Windows binary nor read the
// Windows session store. The reverse direction works: Windows reaches
// 127.0.0.1:<WEB_PORT> (verified HTTP 200) and sees WSL files over
// \\wsl.localhost. So the Windows worker makes OUTBOUND calls to this API and
// nothing listens on Windows -- zero new ports, nothing public.
//
// NO GLOBAL "CURRENT SESSION"
// Every task carries its own project alias; the alias resolves to (sessionId,
// workspacePath) through code_sessions. Several sessions are addressable at the
// same time and a task claimed for `tradingbot` can never land in `marvin`.

import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { CODE_BRIDGE_EXCLUDE } from '../config.js'

export type CodeTaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'
export type CodeTaskOrigin = 'telegram' | 'agent' | 'dashboard' | 'api'

export interface CodeSession {
  project: string
  workspacePath: string
  sessionId: string
  title: string | null
  host: string | null
  transcriptMtime: number | null
  pinned: boolean
  updatedAt: number
}

export interface CodeTask {
  id: string
  project: string
  prompt: string
  status: CodeTaskStatus
  origin: CodeTaskOrigin
  requestedBy: string | null
  chatId: string | null
  /** Ebben a beszelgetesben FUTOTT (a claim tolti ki). */
  sessionId: string | null
  /** IDE kertek: egy konkret chat ful azonositoja, ha a bekuldo valasztott.
   *  Ures = a projekt aktualis (legfrissebb) beszelgetese, mint eddig. */
  targetSessionId: string | null
  workspacePath: string | null
  host: string | null
  result: string | null
  summary: string | null
  error: string | null
  costUsd: number | null
  durationMs: number | null
  numTurns: number | null
  attempts: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  leaseExpiresAt: number | null
}

// A claimed task whose worker went silent (crash, reboot, network drop) must not
// stay 'running' forever. The worker heartbeats every 60s; three misses and the
// task is re-queued.
export const LEASE_MS = 5 * 60 * 1000
// Give up after this many claims so a task that kills its worker every time
// (OOM, a prompt that crashes the CLI) surfaces as an error instead of looping.
export const MAX_ATTEMPTS = 3

let ensured = false

/** Created lazily, like file-claims-store: only installs that actually use the
 *  bridge get the tables, and the main schema stays untouched. */
function ensureTables(): void {
  if (ensured) return
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_sessions (
      project TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT,
      host TEXT,
      transcript_mtime INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `)
  // A tulaj ALTAL LEVETT mappak. Enelkul a "Torles" gomb hazug lenne: a
  // felderites a kovetkezo korben (~1 perc) ujra bejelentene ugyanazt a
  // mappat, es a kartya visszajonne -- a gomb ugy nezne ki, mintha nem
  // csinalt volna semmit (Boss, 2026-08-23: "es a torles gombot is tedd fel").
  // Visszavonhato: ha a tulaj ujra bekoti a mappat a feluletrol, a sor torlodik.
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_dismissed (
      workspace_key TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      project TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_tasks (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','running','done','error','cancelled')),
      origin TEXT NOT NULL DEFAULT 'api',
      requested_by TEXT,
      chat_id TEXT,
      session_id TEXT,
      workspace_path TEXT,
      host TEXT,
      result TEXT,
      summary TEXT,
      error TEXT,
      cost_usd REAL,
      duration_ms INTEGER,
      num_turns INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      lease_expires_at INTEGER
    )
  `)
  // KET KULON session-mezo, szandekosan:
  //   target_session_id = ide KERTEK (egy konkret chat ful), lehet ures
  //   session_id        = ebben FUTOTT (a claim tolti ki)
  // Osszevonva elveszne, hogy a cimzes explicit volt-e, es a claim felulirna a
  // kerest -- a feladat nemaan masik fulbe menne, mint amit a tulaj valasztott.
  try { db.exec('ALTER TABLE code_tasks ADD COLUMN target_session_id TEXT') } catch { /* mar letezik */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_tasks_status ON code_tasks(status, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_tasks_project ON code_tasks(project, created_at)`)
  // Worker presence. The bridge has exactly ONE silent failure mode: the
  // Windows worker stops and nothing says so -- tasks queue up forever, the
  // session map goes stale, and every page still looks healthy. (Measured
  // 2026-08-22: the worker had been dead since 08-20 19:47 and the only trace
  // was an empty project list.) One row per host, stamped on every worker call,
  // is what lets the UI and the self-check say "the executor has been gone for
  // two days" instead of silently showing nothing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_workers (
      host TEXT PRIMARY KEY,
      last_seen_at INTEGER NOT NULL,
      last_action TEXT,
      sessions_reported INTEGER,
      worker_version TEXT
    )
  `)
  // Meglevo telepites: az oszlop utolag kerul be. A `duplicate column` az
  // EGYETLEN hiba, amit itt le szabad nyelni -- barmi mas szoljon.
  try {
    db.exec(`ALTER TABLE code_workers ADD COLUMN worker_version TEXT`)
  } catch (err) {
    if (!/duplicate column/i.test(String((err as Error)?.message ?? ''))) throw err
  }
  ensured = true
}

/** Test seam: a fresh in-memory DB per test needs the tables re-created. */
export function resetCodeBridgeTablesForTests(): void {
  ensured = false
  ensureTables()
}

// ---- project aliases ----------------------------------------------------

const ALIAS_MAX = 40

/** Aliases are what the owner types on a phone keyboard: lowercase, ASCII-ish,
 *  no spaces. Everything else is folded away so `/code TradingBot ...` and
 *  `/code tradingbot ...` are the same project.
 *
 *  Az ekezetet LE KELL BONTANI, nem eldobni. 2026-08-23-ig a `Fejlesztés`
 *  mappabol `fejleszts` lett -- Boss: "miert van hibasan a fejleszts.. ts?
 *  honnan van ez a szo? hibas lenne egy mapanev?" A mappanev hibatlan volt, a
 *  normalizalas ette meg az `e`-t az `é` helyen. Az NFD-bontas utan az ekezet
 *  kulon jel, amit a szures elvisz, a betu pedig megmarad: `fejlesztes`. */
export function normalizeAlias(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Amit az NFD nem bont (o-kalapos/u-kalapos mar bomlik, de a német ß es a
    // lengyel ł nem), azt kezzel kotjuk le -- kulonben megint nemaan eltunne.
    .replace(/ß/g, 'ss')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9_-]+/g, '')
    .slice(0, ALIAS_MAX)
}

/** Egyszeri atnevezes a REGI (ekezetet eldobo) aliasokrol az ujakra.
 *
 *  Enelkul a `fejleszts` sor bent maradna, a felderites melle regisztralna a
 *  `fejlesztes`-t, es a tulaj ket kartyat latna ugyanarra a mappara -- plusz a
 *  kiosztott szerep (`vscode:fejleszts`) egy nem letezo gazdara mutatna.
 *  A hivo adja at a szerep-atiratast, hogy ez a modul ne fuggjon a brokertol. */
export function migrateLegacyAliases(renameRole?: (from: string, to: string) => void): string[] {
  ensureTables()
  const db = getDb()
  const rows = db.prepare(`SELECT project FROM code_sessions`).all() as { project: string }[]
  const renamed: string[] = []
  for (const r of rows) {
    // A regi alias mar atesett a regi normalizaláson, ezert az uj szabalyt a
    // MAPPA nevere kell futtatni; ha nincs sor hozza, marad minden.
    const row = getCodeSession(r.project)
    if (!row) continue
    const want = aliasFromWorkspacePath(row.workspacePath)
    if (!want || want === row.project) continue
    if (getCodeSession(want)) continue // a helyes nev mar letezik: nem irunk felul semmit
    db.prepare(`UPDATE code_sessions SET project = ? WHERE project = ?`).run(want, row.project)
    db.prepare(`UPDATE code_tasks SET project = ? WHERE project = ?`).run(want, row.project)
    if (renameRole) renameRole(`vscode:${row.project}`, `vscode:${want}`)
    renamed.push(`${row.project} -> ${want}`)
  }
  return renamed
}

/** Default alias derived from a workspace path's last segment:
 *  `d:\Tozsde_telepitesi_mappa` -> `tozsdetelepitesimappa`. Only used when the
 *  owner has not mapped an explicit alias -- the explicit map always wins. */
export function aliasFromWorkspacePath(workspacePath: string): string {
  const parts = workspacePath.replace(/[/\\]+$/, '').split(/[/\\]/)
  const last = parts[parts.length - 1] ?? ''
  return normalizeAlias(last)
}

/** Pure form of the exclusion check, so the matching itself is testable without
 *  touching process config. Both sides are normalized: the owner types the alias
 *  in .env the same way they type it on the phone. */
export function matchesExcluded(project: string, excluded: string[]): boolean {
  const alias = normalizeAlias(project)
  if (!alias) return false
  return excluded.some((e) => normalizeAlias(e) === alias)
}

/** Projects fenced off with CODE_BRIDGE_EXCLUDE are never registered by
 *  discovery and never accept a task -- see the config comment for the case that
 *  motivates it (the workspace the owner is chatting in right now). */
export function isExcludedProject(project: string): boolean {
  return matchesExcluded(project, CODE_BRIDGE_EXCLUDE)
}

function rowToSession(row: Record<string, unknown>): CodeSession {
  return {
    project: row['project'] as string,
    workspacePath: row['workspace_path'] as string,
    sessionId: row['session_id'] as string,
    title: (row['title'] as string | null) ?? null,
    host: (row['host'] as string | null) ?? null,
    transcriptMtime: (row['transcript_mtime'] as number | null) ?? null,
    pinned: Boolean(row['pinned']),
    updatedAt: row['updated_at'] as number,
  }
}

export function listCodeSessions(): CodeSession[] {
  ensureTables()
  const rows = getDb().prepare(`SELECT * FROM code_sessions ORDER BY project`).all() as Record<string, unknown>[]
  return rows.map(rowToSession)
}

export function getCodeSession(project: string): CodeSession | null {
  ensureTables()
  const row = getDb()
    .prepare(`SELECT * FROM code_sessions WHERE project = ?`)
    .get(normalizeAlias(project)) as Record<string, unknown> | undefined
  return row ? rowToSession(row) : null
}

/**
 * Resolve what the owner typed to exactly one project. Exact alias first, then a
 * unique prefix (`/code trading ...`), then a unique substring. AMBIGUOUS INPUT
 * IS AN ERROR, never a guess: silently picking one of two projects would run a
 * refactor in the wrong repository.
 */
export function resolveProject(raw: string): { session: CodeSession } | { error: string; candidates?: string[] } {
  const alias = normalizeAlias(raw)
  if (!alias) return { error: 'empty project name' }
  const exact = getCodeSession(alias)
  if (exact) return { session: exact }

  const all = listCodeSessions()
  if (all.length === 0) return { error: 'no sessions registered yet -- start the Windows worker first' }

  const byPrefix = all.filter((s) => s.project.startsWith(alias))
  if (byPrefix.length === 1) return { session: byPrefix[0]! }
  if (byPrefix.length > 1) return { error: `ambiguous project "${alias}"`, candidates: byPrefix.map((s) => s.project) }

  const bySub = all.filter((s) => s.project.includes(alias))
  if (bySub.length === 1) return { session: bySub[0]! }
  if (bySub.length > 1) return { error: `ambiguous project "${alias}"`, candidates: bySub.map((s) => s.project) }

  return { error: `unknown project "${alias}"`, candidates: all.map((s) => s.project) }
}

export interface UpsertSessionInput {
  project: string
  workspacePath: string
  sessionId: string
  title?: string | null
  host?: string | null
  transcriptMtime?: number | null
  pinned?: boolean
}

/**
 * Register (or refresh) a project's session.
 *
 * PINNING is the whole point of the `pinned` flag: discovery reports the most
 * recently used transcript for a workspace, which would otherwise silently move
 * a project onto whatever session the owner last happened to open. A pinned row
 * keeps its session_id until the owner explicitly repins, so a long-running
 * conversation cannot be swapped out from under a queued task.
 */
export function upsertCodeSession(
  input: UpsertSessionInput,
  opts: {
    fromDiscovery?: boolean
    /**
     * A hivo MEGMERTE, hogy a jelenleg bekotott beszelgetes mar nincs nyitva a
     * VS Code-ban, ES hogy a most erkezo helyette nyitva VAN. Csak ilyenkor
     * szabad egy kituzott sort masik beszelgetesre allitani.
     *
     * Szandekosan nem alapertelmezett: ha a hivo nem latott oda (nincs
     * `~/.claude/sessions` mappa, regi worker), a tu marad. A "nem tudom"
     * soha nem lehet ok az atallitasra.
     */
    repointStale?: boolean
  } = {},
): CodeSession {
  ensureTables()
  const project = normalizeAlias(input.project)
  if (!project) throw new Error('project alias is empty after normalization')
  if (!input.sessionId) throw new Error('sessionId is required')
  if (!input.workspacePath) throw new Error('workspacePath is required')

  const existing = getCodeSession(project)
  const now = Date.now()

  if (existing && opts.fromDiscovery) {
    // A TU A MAPPARA VONATKOZIK, A BESZELGETESRE CSAK AMIG AZ ELETBEN VAN.
    //
    // A MERT ESET (2026-08-26). A `fejlesztes` projekt a
    // `d34fac5b-523b-4d3e-8c8d-0e4df9ab0ea1` beszelgeteshez volt szogezve, es a sora
    // 31 oraja nem frissult -- kozben a VS Code-ban ket EGESZEN MAS ful volt
    // nyitva. Minden odakuldott feladat egy bezart beszelgetesbe ment. Boss:
    // "a marveen ba beallitott chat fulek nem azonosak a vscode ban levo chat
    // fulekkel. az gaz."
    //
    // Az ok nem a tu letezese, hanem hogy KET dolgot jelentett egyszerre. A
    // `POST /api/code/projects` alapbol kituz (`pinned: body.pinned ?? true`),
    // vagyis MINDENKI ezt kapja, amint a feluletrol bekot egy mappat -- friss
    // telepitesen az elso napon. A tu SZANDEKA az volt, hogy a felderites ne
    // vigye at az aliast egy masik MAPPARA. A beszelgetes-azonosito viszont
    // termeszetenel fogva mulando: minden `/clear`, minden uj ful es minden
    // VS Code-ujrainditas ujat csinal.
    //
    // A TULAJ DONTESE (2026-08-26): amig a bekotott ful NYITVA van, senki nem
    // nyul hozza -- a kezi bekotes akkor is ur, ha regebbi fulre mutat. Amint
    // a VS Code-ban bezarul ES van helyette nyitott ful ugyanabban a mappaban,
    // a felderites atall ra. Ha egyik ful sem nyitott, MARAD a regi: olyankor
    // nem tudjuk, hova kellene atallni, es a talalgatas rosszabb a semminel.
    //
    // Azt, hogy a bekotott ful el-e, EZ A FUGGVENY NEM TUDJA -- a nyitott
    // fulek listaja a jelentesben erkezik. Ezert dontesi jog helyett egy
    // KIMONDOTT engedelyt kap a hivotol (`repointStale`), es a route szamolja
    // ki. Igy a szabaly egy helyen van, es tesztelheto.
    if (existing.pinned && !opts.repointStale) return existing
    if (existing.workspacePath.toLowerCase() !== input.workspacePath.toLowerCase()) return existing
    // Older transcript than the one we already have: ignore (out-of-order report).
    if (
      existing.transcriptMtime !== null &&
      input.transcriptMtime !== undefined &&
      input.transcriptMtime !== null &&
      input.transcriptMtime < existing.transcriptMtime
    ) {
      return existing
    }
  }

  getDb()
    .prepare(
      `INSERT INTO code_sessions (project, workspace_path, session_id, title, host, transcript_mtime, pinned, updated_at)
       VALUES (@project, @workspace_path, @session_id, @title, @host, @transcript_mtime, @pinned, @updated_at)
       ON CONFLICT(project) DO UPDATE SET
         workspace_path = excluded.workspace_path,
         session_id = excluded.session_id,
         title = COALESCE(excluded.title, code_sessions.title),
         host = COALESCE(excluded.host, code_sessions.host),
         transcript_mtime = COALESCE(excluded.transcript_mtime, code_sessions.transcript_mtime),
         pinned = excluded.pinned,
         updated_at = excluded.updated_at`,
    )
    .run({
      project,
      workspace_path: input.workspacePath,
      session_id: input.sessionId,
      title: input.title ?? null,
      host: input.host ?? null,
      transcript_mtime: input.transcriptMtime ?? null,
      pinned: input.pinned === undefined ? (existing?.pinned ?? false) ? 1 : 0 : input.pinned ? 1 : 0,
      updated_at: now,
    })
  return getCodeSession(project)!
}

export function deleteCodeSession(project: string): boolean {
  ensureTables()
  const info = getDb().prepare(`DELETE FROM code_sessions WHERE project = ?`).run(normalizeAlias(project))
  return info.changes > 0
}

/** A mappa ossze-vissza irt utja (kis/nagybetu, zaro perjel) ugyanazt a helyet
 *  jelenti; a kulcs ezt normalizalja. */
function workspaceKey(workspacePath: string): string {
  return workspacePath.trim().replace(/[\\/]+$/, '').toLowerCase()
}

/** A tulaj levette a kartyat: a felderites tobbe ne kosse be ujra ezt a mappat.
 *  A beszelgeteshez, a mappahoz es a fajlokhoz EZ NEM NYUL. */
export function dismissCodeWorkspace(workspacePath: string, project: string | null, now = Date.now()): void {
  ensureTables()
  if (!workspacePath.trim()) return
  getDb()
    .prepare(
      `INSERT INTO code_dismissed (workspace_key, workspace_path, project, created_at)
       VALUES (@key, @path, @project, @created_at)
       ON CONFLICT(workspace_key) DO UPDATE SET
         workspace_path = excluded.workspace_path,
         project = excluded.project,
         created_at = excluded.created_at`,
    )
    .run({ key: workspaceKey(workspacePath), path: workspacePath, project, created_at: now })
}

/** Visszavonas: a mappa ujra bekothetó. Ezt a kezi bekotes hivja, kulonben a
 *  tulaj a sajat feluleterol nem tudna visszahozni, amit egyszer levett. */
export function undismissCodeWorkspace(workspacePath: string): boolean {
  ensureTables()
  const info = getDb().prepare(`DELETE FROM code_dismissed WHERE workspace_key = ?`).run(workspaceKey(workspacePath))
  return info.changes > 0
}

export function isDismissedWorkspace(workspacePath: string): boolean {
  ensureTables()
  const row = getDb()
    .prepare(`SELECT 1 AS n FROM code_dismissed WHERE workspace_key = ?`)
    .get(workspaceKey(workspacePath)) as { n: number } | undefined
  return row !== undefined
}

export function listDismissedWorkspaces(): { workspacePath: string; project: string | null; createdAt: number }[] {
  ensureTables()
  const rows = getDb()
    .prepare(`SELECT workspace_path, project, created_at FROM code_dismissed ORDER BY created_at DESC`)
    .all() as Record<string, unknown>[]
  return rows.map((r) => ({
    workspacePath: r['workspace_path'] as string,
    project: (r['project'] as string | null) ?? null,
    createdAt: r['created_at'] as number,
  }))
}

/**
 * Discovery is the authority on what a given host currently has open, so a row
 * it stops reporting has to go.
 *
 * Without this a mapping outlives its workspace: delete or rename the folder
 * and the alias stays in the dropdown forever, selectable and dispatchable,
 * while every task addressed to it burns all 3 attempts before failing. The
 * worker already refuses to report a workspace that no longer exists (see
 * Test-DispatchableWorkspace in marvin-code-worker.ps1) -- until now the DB
 * simply never acted on that silence. Measured 2026-08-22: three deleted test
 * workspaces stayed in the project list after their folders were gone.
 *
 * Three things are deliberately NOT pruned:
 *   * a PINNED row -- that is the owner's own map, not a discovery guess;
 *   * a row belonging to a DIFFERENT host -- one worker knows nothing about
 *     another machine's folders, and pruning on its behalf would empty the map
 *     of every machine that is merely offline right now;
 *   * a project with a QUEUED or RUNNING task -- one dropped report (a locked
 *     transcript, a half-written file) would otherwise orphan live work.
 */
export function pruneUnreportedCodeSessions(host: string, reportedProjects: string[]): string[] {
  ensureTables()
  const keep = new Set(reportedProjects.map((p) => normalizeAlias(p)))
  const busy = getDb().prepare(
    `SELECT 1 FROM code_tasks WHERE project = ? AND status IN ('queued', 'running') LIMIT 1`,
  )
  const removed: string[] = []
  for (const session of listCodeSessions()) {
    if (session.pinned) continue
    if (!session.host || session.host !== host) continue
    if (keep.has(session.project)) continue
    if (busy.get(session.project)) continue
    if (deleteCodeSession(session.project)) removed.push(session.project)
  }
  return removed
}

// ---- tasks --------------------------------------------------------------

function rowToTask(row: Record<string, unknown>): CodeTask {
  return {
    id: row['id'] as string,
    project: row['project'] as string,
    prompt: row['prompt'] as string,
    status: row['status'] as CodeTaskStatus,
    origin: row['origin'] as CodeTaskOrigin,
    requestedBy: (row['requested_by'] as string | null) ?? null,
    chatId: (row['chat_id'] as string | null) ?? null,
    sessionId: (row['session_id'] as string | null) ?? null,
    targetSessionId: (row['target_session_id'] as string | null) ?? null,
    workspacePath: (row['workspace_path'] as string | null) ?? null,
    host: (row['host'] as string | null) ?? null,
    result: (row['result'] as string | null) ?? null,
    summary: (row['summary'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    costUsd: (row['cost_usd'] as number | null) ?? null,
    durationMs: (row['duration_ms'] as number | null) ?? null,
    numTurns: (row['num_turns'] as number | null) ?? null,
    attempts: (row['attempts'] as number | null) ?? 0,
    createdAt: row['created_at'] as number,
    startedAt: (row['started_at'] as number | null) ?? null,
    finishedAt: (row['finished_at'] as number | null) ?? null,
    leaseExpiresAt: (row['lease_expires_at'] as number | null) ?? null,
  }
}

export const PROMPT_MAX_CHARS = 12_000

export interface EnqueueInput {
  project: string
  prompt: string
  origin?: CodeTaskOrigin
  requestedBy?: string | null
  chatId?: string | null
  /** Egy konkret chat ful azonositoja a projekt mappajabol. Ures = a projekt
   *  aktualis beszelgetese (a korabbi, valtozatlan viselkedes). */
  sessionId?: string | null
}

export function enqueueCodeTask(input: EnqueueInput): { task: CodeTask } | { error: string; candidates?: string[] } {
  ensureTables()
  const prompt = input.prompt.trim()
  if (!prompt) return { error: 'empty prompt' }
  if (prompt.length > PROMPT_MAX_CHARS) return { error: `prompt too long (${prompt.length} > ${PROMPT_MAX_CHARS})` }

  const resolved = resolveProject(input.project)
  if ('error' in resolved) return resolved
  if (isExcludedProject(resolved.session.project)) {
    return { error: `project "${resolved.session.project}" is excluded from the code bridge (CODE_BRIDGE_EXCLUDE)` }
  }

  // Fulre cimzes. A `claude.exe --resume` egy nem letezo azonositora is elindul
  // es csak a CLI hibajaval bukik el -- HAROMSZOR, mert a runner ujraprobal.
  // Ezert a ROSSZ azonositot itt fogjuk meg, ahol meg tudunk beszedes valaszt
  // adni; a "nem talalom" es a "nem latok oda" viszont KET KULON valasz, mert
  // egy epp indulo (vagy allo) workernel a jeloltlista meg ures, es olyankor a
  // hallgatas rosszabb lenne, mint atengedni a kerest a CLI-hez.
  const wantedTab = (input.sessionId ?? '').trim()
  let targetSessionId: string | null = null
  if (wantedTab) {
    const w = wantedTab.toLowerCase()
    const tabsHere = listCodeCandidates().filter(
      (c) => c.workspacePath.toLowerCase() === resolved.session.workspacePath.toLowerCase(),
    )
    const exact = tabsHere.find((c) => c.sessionId.toLowerCase() === w)
    // A listak ROVID azonositot mutatnak (`3cfe9212`), mert egy teljes UUID-t
    // senki nem gepel at. Ezert a prefix is ervenyes cimzes -- de csak akkor,
    // ha EGYETLEN fulre illik: ket talalatnal a talalgatas rossz fulbe irna.
    const prefix = exact ? [] : tabsHere.filter((c) => c.sessionId.toLowerCase().startsWith(w))
    if (exact) {
      targetSessionId = exact.sessionId
    } else if (prefix.length === 1) {
      targetSessionId = prefix[0]!.sessionId
    } else if (prefix.length > 1) {
      const amb = prefix.map((c) => `${c.sessionId.slice(0, 8)}${c.title ? ` (${c.title})` : ''}`).join(', ')
      return { error: `"${wantedTab}" tobb fulre is illik: ${amb} -- adj meg tobb karaktert` }
    } else if (tabsHere.length === 0) {
      // A worker meg nem jelentett errol a mappa rol semmit: nem tudjuk, hogy a
      // ful nincs meg, vagy csak nem latunk oda. Ezt a KETTOT nem szabad
      // osszemosni -- de vakon elkuldeni sem, mert a `--resume` egy toredek
      // azonositoval biztosan elbukik, es a hiba a runner harom probaja utan
      // jonne vissza. Teljes UUID-t atengedunk (a CLI sajat hibaja beszedes),
      // toredeket nem.
      if (/^[0-9a-f-]{36}$/i.test(wantedTab)) {
        targetSessionId = wantedTab
      } else {
        return {
          error:
            `nem latok ra a(z) "${resolved.session.project}" projekt beszelgeteseire, ezert a "${wantedTab}" ` +
            `fulet nem tudom feloldani -- fut a Windows worker? (teljes session-UUID-t cimzes nelkul is atengedek)`,
        }
      }
    } else {
      const known = tabsHere
        .map((c) => `${c.sessionId.slice(0, 8)}${c.title ? ` (${c.title})` : ''}`)
        .join(', ')
      return {
        error:
          `nincs "${wantedTab.slice(0, 12)}" azonositoju chat ful a(z) "${resolved.session.project}" projektben -- ` +
          `a worker ezeket a beszelgeteseket latja: ${known}`,
      }
    }
  }

  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO code_tasks (id, project, prompt, status, origin, requested_by, chat_id, target_session_id, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      resolved.session.project,
      prompt,
      input.origin ?? 'api',
      input.requestedBy ?? null,
      input.chatId ?? null,
      targetSessionId,
      now,
    )
  return { task: getCodeTask(id)! }
}

export function getCodeTask(id: string): CodeTask | null {
  ensureTables()
  const row = getDb().prepare(`SELECT * FROM code_tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToTask(row) : null
}

/** Accepts the short id prefix the notification shows (first 8 chars). */
export function getCodeTaskByPrefix(prefix: string): CodeTask | null {
  ensureTables()
  const clean = prefix.trim().toLowerCase()
  if (!/^[0-9a-f-]{4,36}$/.test(clean)) return null
  const row = getDb()
    .prepare(`SELECT * FROM code_tasks WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1`)
    .get(`${clean}%`) as Record<string, unknown> | undefined
  return row ? rowToTask(row) : null
}

export function listCodeTasks(opts: { project?: string; status?: CodeTaskStatus; limit?: number } = {}): CodeTask[] {
  ensureTables()
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200)
  const where: string[] = []
  const params: unknown[] = []
  if (opts.project) {
    where.push('project = ?')
    params.push(normalizeAlias(opts.project))
  }
  if (opts.status) {
    where.push('status = ?')
    params.push(opts.status)
  }
  const sql = `SELECT * FROM code_tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
  const rows = getDb().prepare(sql).all(...params, limit) as Record<string, unknown>[]
  return rows.map(rowToTask)
}

export function latestCodeTaskForProject(project: string): CodeTask | null {
  const list = listCodeTasks({ project, limit: 1 })
  return list[0] ?? null
}

/**
 * Hand the oldest RUNNABLE queued task to a worker.
 *
 * The session id is stamped HERE, not at enqueue time: the mapping may have been
 * repinned while the task waited, and the truth that matters is "which session
 * was current when the work actually started".
 *
 * A task whose project currently has no mapping is SKIPPED, not failed: the
 * worker re-publishes discovery every 60s, so right after a dashboard restart
 * (or before the worker's first report) the map is legitimately empty for a
 * moment, and failing a task there would punish the queue for a startup race.
 * Skipping also keeps a single orphan off the head of the queue -- otherwise one
 * unmappable task would stall every runnable one behind it. Orphans that stay
 * orphans are failed (and announced) by failOrphanedCodeTasks() below.
 */
export function claimNextCodeTask(host: string, now = Date.now()): CodeTask | null {
  ensureTables()
  const db = getDb()
  const claim = db.transaction((): CodeTask | null => {
    const rows = db
      .prepare(`SELECT * FROM code_tasks WHERE status = 'queued' ORDER BY created_at LIMIT 50`)
      .all() as Record<string, unknown>[]

    // One running task per project, enforced here rather than by trusting the
    // worker to be a singleton: two `claude --resume` processes on the SAME
    // session id interleave their turns in one transcript, which is exactly the
    // corruption this bridge must not cause. A second worker (or a restarted
    // one racing the old process) therefore gets the next project's task, not a
    // second task for a busy session.
    const isBusy = db.prepare(`SELECT 1 FROM code_tasks WHERE project = ? AND status = 'running' LIMIT 1`)

    for (const row of rows) {
      const task = rowToTask(row)
      if (isBusy.get(task.project)) continue
      const session = getCodeSession(task.project)
      if (!session) continue

      // A megcimzett ful ERŐSEBB, mint a projekt aktualis beszelgetese: aki egy
      // konkret fulet valasztott, annak a feladata nem csuszhat at abba, ami
      // kozben a legfrissebb lett. Cimzes nelkul minden marad a regiben.
      const runIn = task.targetSessionId ?? session.sessionId
      db.prepare(
        `UPDATE code_tasks
           SET status = 'running', host = ?, session_id = ?, workspace_path = ?,
               started_at = COALESCE(started_at, ?), attempts = attempts + 1, lease_expires_at = ?
         WHERE id = ?`,
      ).run(host, runIn, session.workspacePath, now, now + LEASE_MS, task.id)
      return getCodeTask(task.id)
    }
    return null
  })
  return claim()
}

/** How long a queued task may wait for its project's session to (re)appear
 *  before it is failed. Longer than the worker's 60s discovery interval, so a
 *  restart on either side is not mistaken for a lost mapping. */
export const ORPHAN_GRACE_MS = 3 * 60 * 1000

/**
 * Fail queued tasks whose project has had no registered session for longer than
 * the grace period, and return them so the caller can notify. Without this a
 * task addressed to a session that never comes back would sit in the queue
 * forever and the owner would simply never hear about it.
 */
export function failOrphanedCodeTasks(now = Date.now(), graceMs = ORPHAN_GRACE_MS): CodeTask[] {
  ensureTables()
  const db = getDb()
  const rows = db
    .prepare(`SELECT * FROM code_tasks WHERE status = 'queued' AND created_at < ?`)
    .all(now - graceMs) as Record<string, unknown>[]
  const failed: CodeTask[] = []
  for (const row of rows) {
    const task = rowToTask(row)
    if (getCodeSession(task.project)) continue
    db.prepare(
      `UPDATE code_tasks SET status = 'error', error = ?, finished_at = ? WHERE id = ?`,
    ).run(`project "${task.project}" has no registered session any more`, now, task.id)
    const updated = getCodeTask(task.id)
    if (updated) failed.push(updated)
  }
  return failed
}

export function heartbeatCodeTask(id: string, host: string, now = Date.now()): boolean {
  ensureTables()
  const info = getDb()
    .prepare(`UPDATE code_tasks SET lease_expires_at = ? WHERE id = ? AND status = 'running' AND host = ?`)
    .run(now + LEASE_MS, id, host)
  return info.changes > 0
}

export interface CompleteInput {
  ok: boolean
  result?: string | null
  error?: string | null
  costUsd?: number | null
  durationMs?: number | null
  numTurns?: number | null
}

/**
 * What happened to a result that arrived for a task nobody is waiting for any
 * more. The worker cannot be interrupted mid-run (the CLI has no remote stop),
 * so a result for a CANCELLED or already-finished task is normal traffic, not a
 * fault -- but it must not overwrite the outcome the owner already saw.
 */
export type LateResultOutcome = 'accepted' | 'cancelled' | 'already-final' | 'foreign-host'

export interface CompleteOutcome {
  task: CodeTask | null
  outcome: LateResultOutcome
}

/**
 * Record the worker's result.
 *
 * The status guard is the point. Without it a result posted after the owner
 * cancelled flipped the task back to 'done' and fired a "finished" ping for
 * work that was called off -- and a result from a worker whose lease had
 * already been reaped could overwrite the answer of the worker that took over.
 * A late result is still KEPT (it is real work, and /result should show it),
 * but it never rewrites a decided status.
 */
export function completeCodeTaskDetailed(
  id: string,
  input: CompleteInput,
  now = Date.now(),
  reportingHost?: string | null,
): CompleteOutcome {
  ensureTables()
  const existing = getCodeTask(id)
  if (!existing) return { task: null, outcome: 'accepted' }
  const result = input.result ?? null

  // Cancelled by the owner while the CLI was still running: keep the result for
  // /result, keep the status the owner was told.
  if (existing.status === 'cancelled') {
    getDb()
      .prepare(`UPDATE code_tasks SET result = COALESCE(result, ?), summary = COALESCE(summary, ?) WHERE id = ?`)
      .run(result, result ? summarizeResult(result) : null, id)
    return { task: getCodeTask(id), outcome: 'cancelled' }
  }

  // Already decided (a duplicate POST, or a retry after a lost response):
  // idempotent, and above all no second notification.
  if (existing.status === 'done' || existing.status === 'error') {
    return { task: existing, outcome: 'already-final' }
  }

  // The lease was reaped and another host took the task over. The old worker's
  // answer belongs to a run nobody is waiting for; taking it would report the
  // WRONG run's output as this task's result.
  if (
    reportingHost &&
    existing.status === 'running' &&
    existing.host &&
    existing.host !== reportingHost
  ) {
    return { task: existing, outcome: 'foreign-host' }
  }

  getDb()
    .prepare(
      `UPDATE code_tasks
         SET status = ?, result = ?, summary = ?, error = ?, cost_usd = ?, duration_ms = ?, num_turns = ?,
             finished_at = ?, lease_expires_at = NULL
       WHERE id = ?`,
    )
    .run(
      input.ok ? 'done' : 'error',
      result,
      result ? summarizeResult(result) : null,
      input.error ?? null,
      input.costUsd ?? null,
      input.durationMs ?? null,
      input.numTurns ?? null,
      now,
      id,
    )
  return { task: getCodeTask(id), outcome: 'accepted' }
}

/** Back-compat wrapper: the tests and older callers want just the task. */
export function completeCodeTask(id: string, input: CompleteInput, now = Date.now()): CodeTask | null {
  return completeCodeTaskDetailed(id, input, now).task
}

export function cancelCodeTask(id: string, now = Date.now()): CodeTask | null {
  ensureTables()
  const t = getCodeTask(id)
  if (!t) return null
  if (t.status === 'done' || t.status === 'error') return t
  getDb()
    .prepare(`UPDATE code_tasks SET status = 'cancelled', finished_at = ?, lease_expires_at = NULL WHERE id = ?`)
    .run(now, id)
  return getCodeTask(id)
}

/**
 * Re-queue tasks whose worker stopped heartbeating; error out the ones that have
 * burned their attempts. Returns the tasks that were pushed to 'error' so the
 * caller can notify -- a silently dropped task is exactly the failure this whole
 * queue exists to avoid.
 */
/**
 * Clears finished history from the Tasks list.
 *
 * Queued and running rows are deliberately kept. A running task still has a
 * `claude.exe` behind it that will POST a result minutes later, and a queued
 * one is still owed to whoever asked for it -- dropping either would make the
 * page lie about work that is still happening. Only rows nothing is waiting on
 * are removed.
 */
export function clearFinishedCodeTasks(): number {
  ensureTables()
  const info = getDb()
    .prepare(`DELETE FROM code_tasks WHERE status IN ('done', 'error', 'cancelled')`)
    .run()
  return info.changes ?? 0
}

export function reapExpiredCodeLeases(now = Date.now()): { requeued: string[]; failed: CodeTask[] } {
  ensureTables()
  const db = getDb()
  const rows = db
    .prepare(`SELECT * FROM code_tasks WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`)
    .all(now) as Record<string, unknown>[]
  const requeued: string[] = []
  const failed: CodeTask[] = []
  for (const row of rows) {
    const task = rowToTask(row)
    if (task.attempts >= MAX_ATTEMPTS) {
      db.prepare(
        `UPDATE code_tasks SET status = 'error', error = ?, finished_at = ?, lease_expires_at = NULL WHERE id = ?`,
      ).run(`worker stopped responding after ${task.attempts} attempt(s)`, now, task.id)
      const updated = getCodeTask(task.id)
      if (updated) failed.push(updated)
    } else {
      db.prepare(`UPDATE code_tasks SET status = 'queued', lease_expires_at = NULL, host = NULL WHERE id = ?`).run(task.id)
      requeued.push(task.id)
    }
  }
  return { requeued, failed }
}

// ---- programmatic summary (NO LLM) --------------------------------------

const SUMMARY_MAX = 280

/**
 * Squeeze a CLI result into one notification line WITHOUT calling a model: the
 * completion ping must cost zero tokens. Markdown scaffolding (headings, bullet
 * dashes, code fences) is stripped so the first line reads as a sentence, and
 * the LAST paragraph is preferred over the first -- a Claude Code run typically
 * ends with its conclusion, while it opens with restating the task.
 */
export function summarizeResult(result: string): string {
  const lines = result
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^```/.test(l))
    .map((l) => l.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, ''))
    .filter((l) => l.length > 0)
  if (lines.length === 0) return '(empty result)'
  const tail = lines.slice(-3).join(' ')
  const text = tail.length >= 40 ? tail : lines.join(' ')
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}\u2026` : text
}

/** Human-readable ms -> "1m 12s" / "8s". Used in notifications. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '?'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

// ---- worker presence -----------------------------------------------------
//
// The executor lives on the other side of the WSL boundary and can only be
// observed by the calls it makes. Everything below turns "when did a worker
// last talk to us" into an answer the dashboard and the self-check can show,
// because a dead worker is otherwise indistinguishable from an idle one.

export interface CodeWorker {
  host: string
  lastSeenAt: number
  lastAction: string | null
  sessionsReported: number | null
  /** A Windows-oldali szkript verzioja, ahogy MAGA jelenti.
   *  `null` = nem kuldott verziot -> a telepitett peldany REGEBBI annal, mint
   *  amikor a verziojeloles bekerult. Ez NEM ugyanaz, mint a "nem latok oda":
   *  a jelentes megerkezett, csak verzio nelkul. */
  version: string | null
}

/** A worker that has not called in for this long is treated as DOWN. It polls
 *  for tasks every 3s and re-publishes discovery every 60s, so five minutes of
 *  silence is far outside normal jitter -- a restart or a slow network round
 *  cannot reach it, only an actually stopped worker can. */
export const WORKER_STALE_MS = 5 * 60 * 1000

/** Stamped by every worker-authenticated call (discovery, claim, heartbeat,
 *  result). Presence is a side effect of doing the job, never a separate
 *  "I am alive" call the worker could forget to make while failing at
 *  everything else. */
export function recordCodeWorkerSeen(
  host: string,
  action: string,
  sessionsReported?: number,
  now = Date.now(),
  version?: string | null,
): void {
  ensureTables()
  const id = (host || 'windows').trim().slice(0, 120) || 'windows'
  const ver = typeof version === 'string' && version.trim() ? version.trim().slice(0, 40) : null
  getDb().prepare(
    `INSERT INTO code_workers (host, last_seen_at, last_action, sessions_reported, worker_version)
     VALUES (@host, @now, @action, @reported, @version)
     ON CONFLICT(host) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       last_action = excluded.last_action,
       -- Only a discovery round knows the session count; a claim/heartbeat must
       -- not blank out what the last discovery reported.
       sessions_reported = COALESCE(excluded.sessions_reported, code_workers.sessions_reported),
       -- A verziot CSAK a felderitesi kor irja: az visz verziot. A claim
       -- 3 masodpercenkent fut, es ha az is irna, NULL-t tenne a helyere --
       -- merve 2026-08-23: a mezo ezert maradt ures a friss workernel is.
       -- A felderites viszont FELULIR (a COALESCE elrejtene, ha valaki egy
       -- regi peldanyt allit vissza), es a verziotlan regi peldany ott is
       -- NULL-t ir, tehat az elavultsag latszik.
       worker_version = CASE WHEN @isDiscovery = 1 THEN excluded.worker_version ELSE code_workers.worker_version END`,
  ).run({
    host: id,
    now,
    action: action.slice(0, 40),
    reported: sessionsReported ?? null,
    version: ver,
    isDiscovery: action === 'discovery' ? 1 : 0,
  })
}

/** Amit a worker a LEGUTOBBI felderitesi koreben a gepen talalt -- nyersen,
 *  MIELOTT a kizaras vagy a mar-regisztralt allapot barmit kiszurne belole.
 *
 *  Ezert kell: a projekt kezi felvetelehez eddig egy Windows-utvonalat ES egy
 *  session-UUID-t kellett BEGEPELNI, olyasmit, amit a felhasznalo sehonnan nem
 *  tud fejbol (Boss: "en egy komuves vagyok! hulyebiztosra kell megcsinalni").
 *  Kozben a worker mindket adatot ismeri -- csak sosem kerult a felulet ele.
 *
 *  Memoriaban el, es ez szandekos: a worker percenkent ujra jelent, tehat egy
 *  ujraindulas utan egy percen belul betelik. Ha a worker ALL, akkor pedig a
 *  helyes valasz ugyis az, hogy "nincs vegrehajto" -- nem egy regi lista,
 *  amirol a felhasznalo azt hinne, hogy elo. */
export interface CodeCandidate {
  workspacePath: string
  sessionId: string
  mtime: number | null
  host: string
  reportedAt: number
  /** A beszelgetes cime -- a transcript `ai-title` sora, vagyis PONTOSAN az a
   *  felirat, amit a VS Code is a fulre ir; ha meg nincs, az elso user-uzenet
   *  eleje. Ket session-UUID kozott ember nem tud valasztani, ket cim kozott
   *  igen -- ezert utazik a cim a jelentessel. */
  title: string | null
  /** A mappa LEGFRISSEBB beszelgetese. Csak ez kerul be projektkent (session),
   *  a tobbi ful cimezheto marad. Regi worker ezt a mezot nem kuldi -> ott
   *  minden sor primary, vagyis a korabbi viselkedes valtozatlan. */
  primary: boolean
  /** Mennyi kontextust hasznal EPPEN ez a beszelgetes (token). A transcript
   *  utolso assistant-sorabol jon: `input_tokens + cache_creation_input_tokens
   *  + cache_read_input_tokens` -- ugyanaz a szam, amit a Claude Code maga is
   *  szamol a statuszsoraba. A `null` itt KIZAROLAG azt jelenti, hogy NEM
   *  LATUNK ODA (regi worker, meg nincs assistant-valasz, olvashatatlan
   *  transcript). Nulla tokenes elo beszelgetes nem letezik, ezert a felulet
   *  a `null`-t sosem irhatja ki 0-nak. */
  contextTokens: number | null
  /** NYITVA van-e a ful a VS Code-ban. A worker a `~/.claude/sessions/<pid>.json`
   *  fajlokbol meri (elo PID + sessionId), mert a bezart ful transcriptje ott
   *  MARAD a lemezen -- ezert latszott 5 ful, ahol a VS Code-ban 2 volt
   *  (Boss, 2026-08-23).
   *
   *  Harom allapot, mert a "nem latok oda" nem ugyanaz, mint a "nincs nyitva":
   *   - `true`  : nyitva van
   *   - `false` : MERTUK, hogy nincs nyitva
   *   - `null`  : nem latunk oda (regi worker, olvashatatlan mappa) */
  live: boolean | null
  /** SZEREPEL-E a beszelgetes a VS Code SAJAT listajaban -- abban, amit a
   *  felhasznalo a panelen lat.
   *
   *  Miert kulon mezo a `live` mellett: a ketto KET KULONBOZO dolog, es pont
   *  az osszemosasuk volt a hiba. A `live` azt meri, fut-e a folyamat; egy
   *  nyitott, de eppen tetlen ful mellett nem fut. Boss, 2026-08-28: "a 47 es
   *  kanban kartya nevu chat az elo, az nincs bezarva. az kellene." Merve
   *  ugyanekkor: a fulhoz 22:45:09-ig nem futott claude.exe, kozben a VS Code
   *  panelen ott volt.
   *
   *  A worker a VS Code sajat munkateruleti allapotabol olvassa
   *  (`agentSessions.model.cache`), nem talalja ki.
   *
   *   - `true`  : ott van a VS Code listajaban
   *   - `false` : MERTUK, hogy nincs ott
   *   - `null`  : nem latunk oda (regi worker, olvashatatlan allapotfajl) */
  vscodeOpen: boolean | null
  /** MELYIK MODELL felel ebben a beszelgetesben (pl. `claude-opus-5`). A
   *  transcript utolso assistant-sorabol jon, ugyanabbol, ahonnan a kontextus.
   *  `null` = nem latunk oda -- olyankor a felulet sem talalhat ki egyet. */
  model: string | null
  /** A beszelgetest futtato Claude Code folyamat azonositoja, ugyanabbol a
   *  `~/.claude/sessions/<pid>.json` fajlbol, amibol a `live` jon.
   *
   *  Miert kell: Boss, 2026-08-23 -- "a vscode ban nem tudom bezarni. mert nem
   *  latok ott semmit. tehat bezarni sem tudok semmit mar." Egy olyan
   *  beszelgetes, aminek a fule mar nincs sehol, de a folyamata el, CSAK igy
   *  zarhato be a feluletrol. `null` = nem latunk oda (regi worker). */
  pid: number | null
  /** A beszelgetes naplojanak TELJES utja a Claude Code gepen. A worker kuldi,
   *  mert O tudja: Marveen a WSL-ben fut, a napló a Windowson van, es a
   *  projekt-mappa neve egy slug -- azt kitalalni tippeles volna.
   *
   *  Miert kell: Boss, 2026-08-28 -- "ha me van a bekototte, akor miert nem
   *  jeleniti meg a chat beszelgetest a kartyan???". Enelkul a kartya tud a
   *  beszelgetesrol (nev, token), de a TARTALMAT nem tudja megnyitni.
   *
   *  `null` = nem latunk oda (regi worker, ami meg nem kuldi ezt a mezot). */
  transcriptPath: string | null
}

/** Egy gepen ennyi projekt folott a lista amugy is athatolhatatlan lenne, es
 *  a memoriat sem hagyjuk korlatlanul nőni egy kulso jelentes nyoman. */
const MAX_CANDIDATES = 200
let codeCandidates: CodeCandidate[] = []
/**
 * Kaptunk-e EBBEN a folyamatban legalabb egy jelentest.
 *
 * A jeloltlista memoriaban el, a szivveres viszont a lemezen -- ujrainditas
 * utan tehat a worker online, a lista megis ures. E nelkul a mezo nelkul ezt
 * nem lehet megkulonboztetni attol, hogy tenyleg nincs nyitott beszelgetes.
 */
let candidatesEverReported = false

export function recordCodeCandidates(
  host: string,
  sessions: {
    workspacePath?: string
    sessionId?: string
    mtime?: number
    title?: string
    primary?: boolean
    contextTokens?: number
    live?: boolean | null
    vscodeOpen?: boolean | null
    model?: string
    pid?: number
    transcriptPath?: string
  }[],
  now = Date.now(),
): void {
  const id = (host || 'windows').trim().slice(0, 120) || 'windows'
  // A jelentes a TELJES lista errol a geprol, tehat felulirja az elozot --
  // kulonben egy bezart projekt orokre a valaszthato listaban maradna.
  const others = codeCandidates.filter((c) => c.host !== id)
  const mine: CodeCandidate[] = []
  // Egy REGI worker egyaltalan nem kuld `primary`-t. Olyankor minden bejelentett
  // sor primary (a 2026-08-23 elotti viselkedes), kulonben a frissites elott
  // allo gepeken egyetlen projekt sem regisztralodna.
  const reportsPrimary = sessions.some((s) => typeof s.primary === 'boolean')
  for (const s of sessions) {
    if (!s.workspacePath || !s.sessionId) continue
    const title = typeof s.title === 'string' ? s.title.trim().slice(0, 200) : ''
    mine.push({
      workspacePath: s.workspacePath,
      sessionId: s.sessionId,
      mtime: typeof s.mtime === 'number' ? s.mtime : null,
      host: id,
      reportedAt: now,
      title: title || null,
      primary: reportsPrimary ? s.primary === true : true,
      // Csak POZITIV szamot fogadunk el meresnek: a 0 es a negativ ertek itt
      // nem "ures kontextus", hanem hianyzo meres -- azt pedig `null`-kent
      // kell tovabbadni, nem nullakent kiirni.
      contextTokens:
        typeof s.contextTokens === 'number' && Number.isFinite(s.contextTokens) && s.contextTokens > 0
          ? Math.round(s.contextTokens)
          : null,
      // Csak a KIFEJEZETT logikai valasz szamit meresnek; barmi mas (hianyzo
      // mezo, regi worker) azt jelenti: nem latunk oda.
      live: typeof s.live === 'boolean' ? s.live : null,
      // Ugyanaz a szabaly, mint a `live`-nal: csak a KIFEJEZETT logikai valasz
      // szamit meresnek. A hianyzo mezo (regi worker) nem "nincs nyitva".
      vscodeOpen: typeof s.vscodeOpen === 'boolean' ? s.vscodeOpen : null,
      model: typeof s.model === 'string' && s.model.trim() ? s.model.trim().slice(0, 60) : null,
      // Csak ervenyes, pozitiv folyamatazonositot fogadunk el: barmi mas azt
      // jelenti, hogy nem latunk oda -- olyankor a bezaras-gomb sem jelenhet
      // meg, mert nem lenne mit bezarni.
      pid: typeof s.pid === 'number' && Number.isInteger(s.pid) && s.pid > 0 ? s.pid : null,
      // A napló utja KULSO bemenet: egy `.jsonl` fajlnev kell, aminek a neve
      // maga a sessionId -- barmi mas nem "furcsa ut", hanem olyasmi, amit
      // sosem szabad megnyitni. A szigoru ellenorzes a beolvasasnal (a
      // `code-conversation.ts`-ben) is megvan; ez itt az elso szuro.
      transcriptPath:
        typeof s.transcriptPath === 'string' && s.transcriptPath.trim().length > 0 && s.transcriptPath.length <= 4096
          ? s.transcriptPath.trim()
          : null,
    })
    if (mine.length >= MAX_CANDIDATES) break
  }
  codeCandidates = [...others, ...mine].slice(-MAX_CANDIDATES)
  candidatesEverReported = true
}

export function listCodeCandidates(): CodeCandidate[] {
  return codeCandidates.slice()
}

/** Csak teszthez: a modul-szintu lista kiurítese ket eset kozott. */
export function _resetCodeCandidates(): void {
  codeCandidates = []
  candidatesEverReported = false
}

export function listCodeWorkers(): CodeWorker[] {
  ensureTables()
  const rows = getDb()
    .prepare(`SELECT * FROM code_workers ORDER BY last_seen_at DESC`)
    .all() as Record<string, unknown>[]
  return rows.map((row) => ({
    host: row['host'] as string,
    lastSeenAt: row['last_seen_at'] as number,
    lastAction: (row['last_action'] as string | null) ?? null,
    sessionsReported: (row['sessions_reported'] as number | null) ?? null,
    version: (row['worker_version'] as string | null) ?? null,
  }))
}

/** Egy chat ful egy projekt mappajaban. A `sessionId` a cimezheto azonosito,
 *  a `title` az, amit EMBER felismer. */
export interface CodeTab {
  sessionId: string
  shortId: string
  title: string | null
  mtime: number | null
  primary: boolean
  /** Ide megy a feladat, ha senki nem valaszt fulet. */
  current: boolean
  /** Az eppen hasznalt kontextus tokenben, vagy `null` = nem latunk oda.
   *  Reszletek a `CodeCandidate.contextTokens`-nel. */
  contextTokens: number | null
  /** Nyitva van-e a ful a VS Code-ban; `null` = nem latunk oda.
   *  Reszletek a `CodeCandidate.live`-nal. */
  live: boolean | null
  /** Ott van-e a beszelgetes a VS Code sajat listajaban. Reszletek a
   *  `CodeCandidate.vscodeOpen`-nel. */
  vscodeOpen: boolean | null
  /** A beszelgetesben eppen felelo modell, vagy `null` = nem latunk oda. */
  model: string | null
  /** A futo Claude Code folyamat azonositoja; `null` = nem latunk oda.
   *  Reszletek a `CodeCandidate.pid`-nel. */
  pid: number | null
  /** A beszelgetes naplojanak TELJES utja azon a gepen, ahol a Claude Code fut
   *  (`C:\Users\...\.claude\projects\<slug>\<sessionId>.jsonl`). Ebbol tudja a
   *  vezerlopult megmutatni a beszelgetes TARTALMAT is, nem csak a nevet es a
   *  tokenszamot. `null` = nem latunk oda (regi worker, ami meg nem kuldi) --
   *  olyankor a felulet a gombot sem kinalja, mert nem lenne mit megnyitnia. */
  transcriptPath: string | null
}

export interface CodeTabProject {
  /** A regisztralt alias, VAGY null: latunk beszelgetest, de a mappa meg nincs
   *  bekotve projektkent. A kettot nem szabad osszemosni. */
  project: string | null
  workspacePath: string
  currentSessionId: string | null
  tabs: CodeTab[]
  /** Amit a nyitottsag-szuro KIDOBOTT a `tabs`-bol: a mappahoz tartozo tobbi
   *  beszelgetes, aminek a folyamata mar nem fut. Nem szemet, es nem is
   *  "nincs": a VS Code panelen ezek a fulek nyitva lehetnek (Boss,
   *  2026-08-28: "a kartyan csak eg chat van megjelenitve, most, de a vscode
   *  ban van vagy 3 beszelgetes"). A fo listaba nem valok -- oda a cimezheto,
   *  futo beszelgetesek mennek --, de elerhetonek KELL lenniuk. */
  closedTabs: CodeTab[]
}

export interface CodeTabsView {
  projects: CodeTabProject[]
  workerOnline: boolean
  lastSeenAt: number | null
  /** MIERT ures a lista. A NULLA ket dolgot jelenthet -- "meg nincs nyitott
   *  beszelgetes" es "nem latok oda" --, es ezt a kettot a hivonak nem szabad
   *  a lista hosszabol talalgatnia. */
  note: string | null
  /** MIERT ures a lista, GEPI formaban. A `note` magyar mondat (Telegram), ez
   *  viszont kulcs, hogy a vezerlopult a sajat nyelven mondhassa el ugyanazt:
   *  a NULLA ket dolgot jelenthet, es ezt a kettot a felhasznalonak latnia kell.
   *   - `ok`            : van mit mutatni
   *   - `empty`         : a vegrehajto el, es TENYLEG nincs beszelgetes
   *   - `worker-never`  : a vegrehajto meg egyszer sem jelentkezett
   *   - `not-reported-yet`: a vegrehajto el, de EZ a folyamat (dashboard-
   *     ujrainditas ota) meg nem kapott tole jelentest -- a lista nem ures,
   *     hanem meg nem erkezett meg
   *   - `worker-stale`  : jelentkezett mar, de most nem valaszol */
  reason: 'ok' | 'empty' | 'not-reported-yet' | 'worker-never' | 'worker-stale'
  window: { maxTabsPerProject: number; maxAgeDays: number }
}

/** A worker ennyi fulet jelent projektenkent, ennyi napig visszamenoleg.
 *  Ugyanez a ket szam all a `scripts/windows/marvin-code-worker.ps1`-ben
 *  (`$script:MaxTabsPerWorkspace` / `$script:TabMaxAgeDays`); itt azert kell,
 *  hogy a felulet meg tudja mondani, MIT nem lat a listaban. */
export const TABS_MAX_PER_PROJECT = 10
export const TABS_MAX_AGE_DAYS = 21

// ---- BEZARAS-KERESEK ------------------------------------------------------
//
// Boss, 2026-08-23: "a vscode ban nem tudom bezarni. mert nem latok ott semmit.
// tehat bezarni sem tudok semmit mar. valamiert az a rendszerben maradt."
//
// Merve ugyanaznap: hat elo `claude` folyamat futott, mind ugyanannak az EGY VS
// Code ablaknak a gyereke, kozben a felulet ket beszelgetest listazott. A
// folyamat tehat tullep a fulen -- es amit a VS Code mar nem mutat, azt ott
// bezarni sem lehet. A Marveen viszont latja (PID-je van), tehat itt kell hogy
// legyen gomb ra.
//
// A kerest MEMORIABAN tartjuk, nem adatbazisban: ez egy MOSTANI szandek, aminek
// egy ujraindult vezerlopult utan mar nincs ertelme (a folyamat kozben barmi
// lehet). A worker a kovetkezo jelentesenel viszi el.
const codeTabCloseRequests = new Map<string, number>()
/** Ennyi ideig var egy kilepetlen keres a workerre. Ha ennyi alatt nem vitte
 *  el, akkor nem is fogja (all a worker) -- a keres elavul, hogy egy kesobb
 *  induló worker ne csukjon be valamit napokkal a kattintas utan. */
export const CLOSE_REQUEST_TTL_MS = 10 * 60 * 1000

/** Csak teszthez. */
export function _resetCodeTabCloseRequests(): void { codeTabCloseRequests.clear() }

export function requestCodeTabClose(sessionId: string, now = Date.now()): void {
  const id = (sessionId || '').trim()
  if (!id) return
  codeTabCloseRequests.set(id, now)
}

/** A worker jelentesekor: elviszi a kereseket. A lejartakat NEM adjuk ki. */
export function takeCodeTabCloseRequests(now = Date.now()): string[] {
  const out: string[] = []
  for (const [id, at] of codeTabCloseRequests) {
    if (now - at <= CLOSE_REQUEST_TTL_MS) out.push(id)
    codeTabCloseRequests.delete(id)
  }
  return out
}

/** A jelentett beszelgetesek projektenkent csoportositva -- ez all a
 *  `/api/code/tabs` es a `/tabs` Telegram-parancs mogott is, hogy a ket felulet
 *  ne kulon logikaval szamolja ki ugyanazt. */
export function listCodeTabs(now = Date.now()): CodeTabsView {
  const workers = listCodeWorkers()
  const lastSeenAt = workers.length > 0 ? Math.max(...workers.map((w) => w.lastSeenAt)) : null
  const workerOnline = lastSeenAt !== null && now - lastSeenAt <= WORKER_STALE_MS
  const known = listCodeSessions()

  const groups = new Map<string, CodeTabProject>()
  for (const c of listCodeCandidates()) {
    const key = c.workspacePath.toLowerCase()
    const registered = known.find((k) => k.workspacePath.toLowerCase() === key)
    let g = groups.get(key)
    if (!g) {
      g = {
        project: registered ? registered.project : null,
        workspacePath: c.workspacePath,
        currentSessionId: registered ? registered.sessionId : null,
        tabs: [],
        // A szetvalogatas lentebb tortenik (a nyitottsag-szuro utan); itt meg
        // minden ful egy listaban gyulik.
        closedTabs: [],
      }
      groups.set(key, g)
    }
    g.tabs.push({
      sessionId: c.sessionId,
      shortId: c.sessionId.slice(0, 8),
      title: c.title,
      mtime: c.mtime,
      primary: c.primary,
      // Ha a mappa be van kotve, a REGISZTRALT session a celpont -- nem a
      // legfrissebb ful --, kulonben a lista mast mutatna, mint ami tortenne.
      current: registered ? registered.sessionId === c.sessionId : c.primary,
      contextTokens: c.contextTokens,
      live: c.live,
      vscodeOpen: c.vscodeOpen,
      model: c.model,
      pid: c.pid,
      transcriptPath: c.transcriptPath,
    })
  }

  // Boss, 2026-08-23: "amit a vscode ban kitorolnek azt a maveen kartyaja se
  // mutassa!" -- a bezart ful transcriptje a lemezen marad, ezert a listat a
  // MERT nyitottsag szuri. Ket dolgot viszont sosem dobunk el:
  //   * a `current` fulet (oda megy a feladat, ha senki nem valaszt kulon):
  //     ha eltunne, a lap ugy nezne ki, mintha a projekt cimezhetetlen lenne;
  //   * semmit, ha a worker egyaltalan nem jelent nyitottsagot (mindenhol
  //     `live === null`), mert olyankor NEM TUDJUK, mi van nyitva -- regi
  //     worker mellett tehat valtozatlan a viselkedes.
  //
  // 2026-08-28 (Boss, Telegram 649): a szuro EDDIG csak a futo folyamatot
  // ismerte, es ez keveset mert. "latom hogy ott van a listaban a 47 es kanban
  // kartya nevu chat, de nem tudom kijelolni! (...) viszont a 47 es kanban
  // kartya nevu chat az elo, az nincs bezarva. az kellene." Merve ugyanekkor:
  // a fulhoz 22:45:09-ig nem futott claude.exe (`live === false`), kozben a VS
  // Code panelen nyitva volt -- a fo listaba tehat oda tartozott volna.
  //
  // Ezert a nyitottsag KET forrasbol jon, es barmelyik eleg:
  //   * `live === true`       : fut a folyamat (cimezheto, most is dolgozhat);
  //   * `vscodeOpen === true` : ott van a VS Code sajat listajaban -- ezt LATJA
  //     a felhasznalo, es a kartyanak ugyanazt kell mutatnia.
  // A ketto unioja kell, nem az egyik helyett a masik: merve 2026-08-28-an
  // harom claude.exe futott, de a VS Code listajaban ket beszelgetes szerepelt.
  // Barmelyik forrasra egyedul hagyatkozva elveszett volna egy elo beszelgetes.
  const filterOpen = (tabs: CodeTab[]): CodeTab[] => {
    // A NULLA KET DOLGOT JELENTHET: ha EGYIK forrast sem tudtuk megmerni, nem
    // "semmi nincs nyitva", hanem "nem latunk oda" -- olyankor nem szurunk.
    if (!tabs.some((t) => t.live !== null || t.vscodeOpen !== null)) return tabs
    const kept = tabs.filter((t) => t.live === true || t.vscodeOpen === true || t.current)
    return kept.length > 0 ? kept : tabs.filter((t) => t.current)
  }

  // A KIDOBOTT sorok NEM tunnek el nyomtalanul: kulon listaba mennek.
  //
  // Boss, 2026-08-28: "a kartyan csak eg chat van megjelenitve, most, de a
  // vscode ban van vagy 3 beszelgetes." Mert allapot: a masik ketto NYITVA van
  // a VS Code panelen, de a folyamata mar nem fut (ma egy sort sem irtak),
  // ezert `live === false`. A ket allitas nem mond ellent egymasnak -- a
  // "nyitott ful" es a "futo folyamat" KET KULONBOZO dolog --, de a felulet
  // eddig csak az egyiket ismerte, es a masikat nyomtalanul eldobta.
  //
  // A `tabs` ezert valtozatlan marad (a fo lista tiszta, ahogy 2026-08-23-ban
  // kerted), a tobbi beszelgetes pedig a `closedTabs`-ban erheto el -- ott,
  // ahol keresed oket, es nem ott, ahol utban vannak.
  const projects = [...groups.values()]
    .map((g) => {
      const byTime = (a: CodeTab, b: CodeTab): number => (b.mtime ?? 0) - (a.mtime ?? 0)
      const shown = filterOpen(g.tabs).sort(byTime)
      const shownIds = new Set(shown.map((t) => t.sessionId))
      // HA LATJUK A VS CODE LISTAJAT, a maradek nem kell.
      //
      // Boss, 2026-08-28: "ezek a tobbiek amik mar be voltak zarva nem
      // erdekesek. nem is kelleenk. ugy sem lehet rajuk kattintani es kijelolni.
      // hogy az legyen az aktualis chat. szoval feleslegesek..." Amit sem a
      // folyamat-meres, sem a VS Code listaja nem tamaszt ala, az tenyleg
      // bezart beszelgetes -- a panelen sincs ott, tehat a kartyan sem valo.
      //
      // Ha viszont a VS Code listajat NEM tudtuk megnezni, ez a lista marad a
      // regi: olyankor a `live === false` meg nem bizonyitja, hogy a ful be van
      // zarva (pont ez volt a 649-es bejelentes), es egy nyitott beszelgetes
      // tunne el nyomtalanul.
      const vscodeMeasured = g.tabs.some((t) => t.vscodeOpen !== null)
      const closedTabs = vscodeMeasured
        ? []
        : g.tabs.filter((t) => !shownIds.has(t.sessionId)).sort(byTime)
      return { ...g, tabs: shown, closedTabs }
    })
    .sort((a, b) => (b.tabs[0]?.mtime ?? 0) - (a.tabs[0]?.mtime ?? 0))

  const reason: CodeTabsView['reason'] = workerOnline
    ? projects.length === 0
      ? candidatesEverReported
        ? 'empty'
        : 'not-reported-yet'
      : 'ok'
    : lastSeenAt === null
      ? 'worker-never'
      : 'worker-stale'

  const note =
    reason === 'ok'
      ? null
      : reason === 'not-reported-yet'
        ? 'A vegrehajto el, de a Marveen ujrainditasa ota meg nem kuldott jelentest -- ez a lista NEM azt jelenti, hogy nincs nyitott beszelgetes. Egy percen belul megjon.'
        : reason === 'empty'
        ? 'A vegrehajto el, de egyetlen beszelgetest sem talalt: nyiss meg egy projektet VS Code-ban, es irj bele valamit.'
        : reason === 'worker-never'
          ? 'A vegrehajto (Windows worker) meg egyszer sem jelentkezett -- ez a lista NEM azt jelenti, hogy nincs nyitott beszelgetes.'
          : 'A vegrehajto (Windows worker) nem valaszol, ezert ez a lista elavult lehet.'

  return {
    projects,
    workerOnline,
    lastSeenAt,
    note,
    reason,
    window: { maxTabsPerProject: TABS_MAX_PER_PROJECT, maxAgeDays: TABS_MAX_AGE_DAYS },
  }
}

/** Egy beszelgetes a jelentett fulek kozul -- futo ES nem futo egyarant.
 *
 *  A beszelgetes-nezet ezen keresztul jut el a naplo utjahoz. Kifejezetten a
 *  `closedTabs`-ot IS nezi: a nem futo beszelgetes tartalma ugyanugy olvashato
 *  kell hogy legyen, kulonben a nezet pont azt nem mutatna meg, amiert
 *  keszult. `null` = ilyen sessiont egyetlen worker sem jelentett -- ami mas,
 *  mint hogy "ures a beszelgetes". */
export function findCodeTab(sessionId: string, now = Date.now()): CodeTab | null {
  const id = (sessionId || '').trim()
  if (!id) return null
  for (const g of listCodeTabs(now).projects) {
    for (const tb of [...g.tabs, ...g.closedTabs]) {
      if (tb.sessionId === id) return tb
    }
  }
  return null
}

export interface CodeBridgeHealth {
  workerOnline: boolean
  /** Newest contact from ANY worker, null if one has never called. */
  lastSeenAt: number | null
  workers: CodeWorker[]
  sessions: number
  queued: number
  running: number
  /** Failures in the last 24h -- a bridge that accepts work and errors on all
   *  of it is broken in a way an "online" flag alone would call healthy. */
  failed24h: number
  done24h: number
}

export function codeBridgeHealth(now = Date.now()): CodeBridgeHealth {
  ensureTables()
  const db = getDb()
  const workers = listCodeWorkers()
  const lastSeenAt = workers.length > 0 ? (workers[0]?.lastSeenAt ?? null) : null
  const count = (sql: string, args: Record<string, unknown> = {}): number => {
    const row = db.prepare(sql).get(args) as Record<string, unknown> | undefined
    return Number(row?.['n'] ?? 0)
  }
  const dayAgo = now - 24 * 60 * 60 * 1000
  return {
    workerOnline: lastSeenAt !== null && now - lastSeenAt <= WORKER_STALE_MS,
    lastSeenAt,
    workers,
    sessions: count(`SELECT COUNT(*) AS n FROM code_sessions`),
    queued: count(`SELECT COUNT(*) AS n FROM code_tasks WHERE status = 'queued'`),
    running: count(`SELECT COUNT(*) AS n FROM code_tasks WHERE status = 'running'`),
    failed24h: count(`SELECT COUNT(*) AS n FROM code_tasks WHERE status = 'error' AND finished_at >= @t`, { t: dayAgo }),
    done24h: count(`SELECT COUNT(*) AS n FROM code_tasks WHERE status = 'done' AND finished_at >= @t`, { t: dayAgo }),
  }
}
