/**
 * DONTESNAPLO (kanban #406, 10. pont).
 *
 * "Amiben megallapodunk, az rogzitve maradna, peldaul: a logo kek marad. Igy
 * kesobb nem kell ujra elmondanod." -- projektenkent egy rovid lista.
 *
 * Ket uton kerul bele sor, ugyanabba a tablaba:
 *   - a tulajdonos a Munkapad "Dontesnaplo" paneljen irja be;
 *   - a Munkapad-agens a `decision.record` eszkozzel rogziti, amikor a
 *     beszelgetesben megallapodtak valamiben.
 * A Munkapad-agens minden forduloban MEGKAPJA a projekt dontesit (context.ts),
 * es a szabalya, hogy nem mond nekik ellent -- ettol nem kell ujra elmondani.
 *
 * A dontest nem toroljuk ki a nyom nelkul: a visszavont dontes `revoked_at`
 * jelolest kap, a naplo mutatja (athuzva), de az agens mar nem kapja meg.
 * Visszavont dontes visszaallithato.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import { getWorkItem } from './workbench.js'

export const DECISION_MAX_CHARS = 500
/** Egy projektben ennyi ervenyes dontes lehet; felette a regieket
 *  vissza kell vonni -- egy hosszabb lista mar nem "emlekezteto". */
export const DECISIONS_MAX_ACTIVE = 200
/** Az agens kontextusaba ennyi (a legfrissebb) kerul. */
export const DECISIONS_IN_CONTEXT = 40

export interface DecisionRow {
  id: string
  project_id: string
  work_item_id: string | null
  text: string
  /** Ki rogzitette: a bejelentkezett felhasznalo neve, vagy 'agent'. */
  created_by: string | null
  source: 'owner' | 'agent'
  created_at: number
  updated_at: number
  revoked_at: number | null
}

export type DecisionCode = 'text_required' | 'text_too_long' | 'too_many' | 'not_found' | 'item_not_in_project'

export type DecisionResult =
  | { ok: true; decision: DecisionRow }
  | { ok: false; code: DecisionCode }

let tablesDb: unknown = null

export function ensureDecisionTable(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      work_item_id TEXT,
      text TEXT NOT NULL,
      created_by TEXT,
      source TEXT NOT NULL DEFAULT 'owner',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_workbench_decisions_project ON workbench_decisions(project_id, created_at);
  `)
  tablesDb = db
}

const now = (): number => Math.floor(Date.now() / 1000)

function cleanText(v: unknown): { ok: true; text: string } | { ok: false; code: DecisionCode } {
  const text = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  if (!text) return { ok: false, code: 'text_required' }
  if (text.length > DECISION_MAX_CHARS) return { ok: false, code: 'text_too_long' }
  return { ok: true, text }
}

export function getDecision(id: string): DecisionRow | undefined {
  ensureDecisionTable()
  return getDb().prepare('SELECT * FROM workbench_decisions WHERE id = ?').get(id) as DecisionRow | undefined
}

/** A projekt dontesei, a legfrissebb elol. A visszavontak csak kerve. */
export function listDecisions(projectId: string, opts: { includeRevoked?: boolean } = {}): DecisionRow[] {
  ensureDecisionTable()
  const sql = 'SELECT * FROM workbench_decisions WHERE project_id = ?'
    + (opts.includeRevoked ? '' : ' AND revoked_at IS NULL')
    + ' ORDER BY created_at DESC, rowid DESC'
  return getDb().prepare(sql).all(projectId) as DecisionRow[]
}

function activeCount(projectId: string): number {
  ensureDecisionTable()
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM workbench_decisions WHERE project_id = ? AND revoked_at IS NULL')
    .get(projectId) as { n: number }
  return r.n
}

export function addDecision(input: {
  project_id: string
  text: unknown
  work_item_id?: string | null
  by?: string | null
  source?: 'owner' | 'agent'
}): DecisionResult {
  const c = cleanText(input.text)
  if (!c.ok) return c
  let itemId: string | null = null
  if (input.work_item_id) {
    const it = getWorkItem(input.work_item_id)
    if (!it || it.project_id !== input.project_id) return { ok: false, code: 'item_not_in_project' }
    itemId = it.id
  }
  if (activeCount(input.project_id) >= DECISIONS_MAX_ACTIVE) return { ok: false, code: 'too_many' }
  const t = now()
  const row: DecisionRow = {
    id: randomUUID(),
    project_id: input.project_id,
    work_item_id: itemId,
    text: c.text,
    created_by: input.by ?? null,
    source: input.source === 'agent' ? 'agent' : 'owner',
    created_at: t,
    updated_at: t,
    revoked_at: null,
  }
  getDb().prepare(`INSERT INTO workbench_decisions
    (id, project_id, work_item_id, text, created_by, source, created_at, updated_at, revoked_at)
    VALUES (@id, @project_id, @work_item_id, @text, @created_by, @source, @created_at, @updated_at, @revoked_at)`).run(row)
  return { ok: true, decision: row }
}

/** A szoveg javitasa (pl. elgepeles). */
export function updateDecision(id: string, text: unknown): DecisionResult {
  const d = getDecision(id)
  if (!d) return { ok: false, code: 'not_found' }
  const c = cleanText(text)
  if (!c.ok) return c
  getDb().prepare('UPDATE workbench_decisions SET text = ?, updated_at = ? WHERE id = ?').run(c.text, now(), id)
  return { ok: true, decision: getDecision(id)! }
}

/** Visszavonas (a sor megmarad, athuzva) vagy visszaallitas. */
export function setDecisionRevoked(id: string, revoked: boolean): DecisionResult {
  const d = getDecision(id)
  if (!d) return { ok: false, code: 'not_found' }
  if (!revoked && d.revoked_at != null && activeCount(d.project_id) >= DECISIONS_MAX_ACTIVE) return { ok: false, code: 'too_many' }
  const t = now()
  getDb().prepare('UPDATE workbench_decisions SET revoked_at = ?, updated_at = ? WHERE id = ?').run(revoked ? t : null, t, id)
  return { ok: true, decision: getDecision(id)! }
}

/** Az agens kontextus-blokkja. Ures listanal KIMONDJA, hogy meg nincs. */
export function decisionsForContext(projectId: string): string {
  const all = listDecisions(projectId)
  if (!all.length) return 'Decisions agreed in this project: none recorded yet (the log was read and it is empty).'
  const shown = all.slice(0, DECISIONS_IN_CONTEXT)
  const lines = shown.map((d) => {
    const it = d.work_item_id ? getWorkItem(d.work_item_id) : undefined
    return `- ${d.text}${it ? ` (about work item "${it.title}")` : ''}`
  })
  if (all.length > shown.length) lines.push(`- ... and ${all.length - shown.length} older decisions`)
  return `Decisions agreed in this project (${all.length}, newest first). Follow them; do not contradict them unless the owner changes one:\n${lines.join('\n')}`
}
