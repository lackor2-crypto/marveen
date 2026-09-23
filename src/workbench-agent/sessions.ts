/**
 * A MUNKAPAD-AGENT ADATMODELLJE (kanban #336, 2. fazis, spec 14).
 *
 * Harom tabla, ugyanazzal a fork-barat mintaval, mint a `src/workbench.ts`:
 * a `db.ts` erintese nelkul, idempotensen, a DB-peldanyhoz kotott "kesz
 * vagyok" jelzovel -- egy ujrainicializalt (teszt-) adatbazis mas peldany, ott
 * a tablakat ujra meg kell csinalni. Friss telepitesen (ures store/, ures db)
 * az elso hivas hozza letre oket.
 *
 *   workbench_agent_sessions   -- egy beszelgetes egy work itemrol (vagy a projektrol)
 *   workbench_agent_messages   -- a beszelgetes uzenetei (user / assistant / system)
 *   workbench_agent_tool_calls -- minden tool-hivas: mi ment be, mi jott ki, mi lett vele
 *
 * A `work_item_assets` es a `render_jobs` KESOBBI fazisoke -- itt nincsenek.
 *
 * MIERT `workbench_` ELOTAG, ha a spec 14. szakasza `agent_sessions` /
 * `agent_messages` / `agent_tool_calls` neveket ir: mert az `agent_messages`
 * MAR LETEZIK ebben a telepitesben -- az a flotta AGENSEK KOZOTTI uzenetbusza
 * (`src/db.ts`, `from_agent`/`to_agent`/`status`). A spec nevet felvenni
 * csendes adatromlas lett volna: a `CREATE TABLE IF NOT EXISTS` no-opol, es a
 * Munkapad sorai a busz tablajaba mennek. A MEZOK pontosan a spec szerintiek,
 * csak a tabla-nevek kaptak elotagot.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'

export const SESSION_STATUSES = ['active', 'ended'] as const
export type SessionStatus = typeof SESSION_STATUSES[number]

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const
export type MessageRole = typeof MESSAGE_ROLES[number]

export const TOOL_CALL_STATUSES = ['running', 'ok', 'error', 'needs_approval', 'blocked'] as const
export type ToolCallStatus = typeof TOOL_CALL_STATUSES[number]

export interface AgentSessionRow {
  id: string
  project_id: string
  work_item_id: string | null
  started_at: number
  ended_at: number | null
  status: SessionStatus
  language: string
}

export interface AgentMessageRow {
  id: string
  session_id: string
  role: MessageRole
  content: string
  created_at: number
}

export interface AgentToolCallRow {
  id: string
  session_id: string
  tool_name: string
  input_json: string | null
  output_json: string | null
  status: ToolCallStatus
  started_at: number
  finished_at: number | null
  /** A MEGLEVO `/api/approvals` rendszer jegyenek azonositoja, ha kellett. */
  approval_id: string | null
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

let tablesDb: unknown = null

export function ensureAgentTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_agent_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      work_item_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      language TEXT NOT NULL DEFAULT 'hu'
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_agent_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_agent_tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      approval_id TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_agent_sessions_item ON workbench_agent_sessions(work_item_id, started_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_agent_messages_session ON workbench_agent_messages(session_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_agent_tool_calls_session ON workbench_agent_tool_calls(session_id, started_at)')
  tablesDb = db
}

export function createAgentSession(input: {
  project_id: string
  work_item_id?: string | null
  language?: string
}): AgentSessionRow {
  ensureAgentTables()
  const id = randomUUID()
  const ts = nowSec()
  const language = input.language === 'en' ? 'en' : 'hu'
  getDb().prepare(
    'INSERT INTO workbench_agent_sessions (id, project_id, work_item_id, started_at, ended_at, status, language) VALUES (?, ?, ?, ?, NULL, ?, ?)',
  ).run(id, input.project_id, input.work_item_id ?? null, ts, 'active', language)
  return { id, project_id: input.project_id, work_item_id: input.work_item_id ?? null, started_at: ts, ended_at: null, status: 'active', language }
}

export function getAgentSession(id: string): AgentSessionRow | undefined {
  ensureAgentTables()
  const v = String(id || '').trim()
  if (!v) return undefined
  return getDb().prepare('SELECT * FROM workbench_agent_sessions WHERE id = ?').get(v) as AgentSessionRow | undefined
}

/**
 * A MUNKADARAB NELKULI (projekt-szintu) beszelgetes kulcsa.
 *
 * A Munkapadon akkor is lehet beszelgetni, ha meg egyetlen munkadarab sincs
 * kivalasztva -- eppen abbol szuletik az elso. Az ilyen beszelgetes ugyanabban
 * a tablaban lakik, egy SZINTETIKUS `work_item_id`-val. Azert EGY helyen all
 * ez a kulcs, mert ket helyrol kell ugyanaz: a fordulo-futtato (ide MENT) es a
 * visszaolvaso vegpont (innen OLVAS). Ha a ketto elcsuszna, a beszelgetes ugy
 * tunne el, mintha sosem lett volna -- pedig ott allna az adatbazisban.
 */
export function projectSessionKey(projectId: string): string {
  return `project:${projectId}`
}

/**
 * A work item ELO beszelgetese, vagy egy uj.
 *
 * Egy munkadarabhoz egy folyo beszelgetes tartozik: a felhasznalo a
 * munkadarabbal beszel, nem munkamenet-azonositokkal. Ha nincs meg, szuletik.
 */
export function openSessionForWorkItem(projectId: string, workItemId: string, language: 'hu' | 'en'): AgentSessionRow {
  ensureAgentTables()
  const row = getDb().prepare(
    "SELECT * FROM workbench_agent_sessions WHERE work_item_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1",
  ).get(workItemId) as AgentSessionRow | undefined
  if (row) return row
  return createAgentSession({ project_id: projectId, work_item_id: workItemId, language })
}

export function endAgentSession(id: string): boolean {
  ensureAgentTables()
  const r = getDb().prepare("UPDATE workbench_agent_sessions SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'")
    .run(nowSec(), id)
  return r.changes > 0
}

export function listAgentSessions(workItemId: string): AgentSessionRow[] {
  ensureAgentTables()
  const v = String(workItemId || '').trim()
  if (!v) return []
  return getDb().prepare('SELECT * FROM workbench_agent_sessions WHERE work_item_id = ? ORDER BY started_at DESC').all(v) as AgentSessionRow[]
}

export function addAgentMessage(sessionId: string, role: MessageRole, content: string): AgentMessageRow {
  ensureAgentTables()
  const id = randomUUID()
  const ts = nowSec()
  getDb().prepare('INSERT INTO workbench_agent_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, sessionId, role, content, ts)
  return { id, session_id: sessionId, role, content, created_at: ts }
}

export function listAgentMessages(sessionId: string, limit = 200): AgentMessageRow[] {
  ensureAgentTables()
  const v = String(sessionId || '').trim()
  if (!v) return []
  return getDb().prepare('SELECT * FROM workbench_agent_messages WHERE session_id = ? ORDER BY created_at, rowid LIMIT ?')
    .all(v, limit) as AgentMessageRow[]
}

export function startToolCall(sessionId: string, toolName: string, input: unknown): AgentToolCallRow {
  ensureAgentTables()
  const id = randomUUID()
  const ts = nowSec()
  const input_json = input === undefined ? null : JSON.stringify(input)
  getDb().prepare(
    'INSERT INTO workbench_agent_tool_calls (id, session_id, tool_name, input_json, output_json, status, started_at, finished_at, approval_id) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL)',
  ).run(id, sessionId, toolName, input_json, 'running', ts)
  return { id, session_id: sessionId, tool_name: toolName, input_json, output_json: null, status: 'running', started_at: ts, finished_at: null, approval_id: null }
}

export function finishToolCall(id: string, status: ToolCallStatus, output: unknown, approvalId?: string | null): boolean {
  ensureAgentTables()
  const r = getDb().prepare('UPDATE workbench_agent_tool_calls SET status = ?, output_json = ?, finished_at = ?, approval_id = ? WHERE id = ?')
    .run(status, output === undefined ? null : JSON.stringify(output), nowSec(), approvalId ?? null, id)
  return r.changes > 0
}

export function listToolCalls(sessionId: string): AgentToolCallRow[] {
  ensureAgentTables()
  const v = String(sessionId || '').trim()
  if (!v) return []
  return getDb().prepare('SELECT * FROM workbench_agent_tool_calls WHERE session_id = ? ORDER BY started_at, rowid').all(v) as AgentToolCallRow[]
}

/** Egy jovahagyas-jegy mar egy SIKERES futast fedezett-e (egyszer hasznalhato). */
export function isApprovalConsumed(approvalId: string): boolean {
  ensureAgentTables()
  const v = String(approvalId || '').trim()
  if (!v) return false
  return !!getDb().prepare("SELECT 1 FROM workbench_agent_tool_calls WHERE approval_id = ? AND status = 'ok' LIMIT 1").get(v)
}
