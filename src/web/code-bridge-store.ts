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
  sessionId: string | null
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_tasks_status ON code_tasks(status, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_tasks_project ON code_tasks(project, created_at)`)
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
 *  `/code tradingbot ...` are the same project. */
export function normalizeAlias(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '')
    .slice(0, ALIAS_MAX)
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
export function upsertCodeSession(input: UpsertSessionInput, opts: { fromDiscovery?: boolean } = {}): CodeSession {
  ensureTables()
  const project = normalizeAlias(input.project)
  if (!project) throw new Error('project alias is empty after normalization')
  if (!input.sessionId) throw new Error('sessionId is required')
  if (!input.workspacePath) throw new Error('workspacePath is required')

  const existing = getCodeSession(project)
  const now = Date.now()

  if (existing && opts.fromDiscovery) {
    // Discovery never overrides a pin, and never moves a project to a DIFFERENT
    // workspace -- an alias collision across two folders must be resolved by the
    // owner, not by whichever worker reported last.
    if (existing.pinned) return existing
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

  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO code_tasks (id, project, prompt, status, origin, requested_by, chat_id, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
    )
    .run(id, resolved.session.project, prompt, input.origin ?? 'api', input.requestedBy ?? null, input.chatId ?? null, now)
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

      db.prepare(
        `UPDATE code_tasks
           SET status = 'running', host = ?, session_id = ?, workspace_path = ?,
               started_at = COALESCE(started_at, ?), attempts = attempts + 1, lease_expires_at = ?
         WHERE id = ?`,
      ).run(host, session.sessionId, session.workspacePath, now, now + LEASE_MS, task.id)
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

export function completeCodeTask(id: string, input: CompleteInput, now = Date.now()): CodeTask | null {
  ensureTables()
  const existing = getCodeTask(id)
  if (!existing) return null
  const result = input.result ?? null
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
  return getCodeTask(id)
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
