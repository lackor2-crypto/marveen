/**
 * BETEKINTO LINK MASOKNAK (kanban #406, 18. pont).
 *
 * A tulajdonos egy munkadarabrol (vagy a projekt atadasi csomagjarol) egy
 * CSAK OLVASHATO, LEJARO linket adhat ki valakinek, akinek nincs Marveen-
 * fiokja. Kikotesek (lackor2-bot, msg 4625):
 *   - A link EGY dolgot mutat: egy munkadarab jelenlegi valtozatat, VAGY egy
 *     projekt atadasi csomagjat. Mas projektet, mas munkadarabot nem sorol fel.
 *   - Semmilyen API-hozzaferest nem ad: a lap a `/view/<token>` utvonalon el
 *     (nem `/api/` alatt), szkript nelkul, sandbox CSP-vel; a token mas
 *     vegponton ervenytelen.
 *   - Lejar (1 / 7 / 30 nap), es barmikor visszavonhato.
 *   - A link LETREHOZASA hozzaferes-adas: a `permission_change` autonomia-
 *     kategoria szintje dont (3 = azonnal el, 2 = jovahagyasi jegy, 1 = nem
 *     adunk ki). A VISSZAVONAS jogot vesz el, az mindig azonnali.
 *
 * A token nem all az adatbazisban: `<id>.<HMAC(kulcs, id)>`, a kulcs egy
 * egyszer generalt veletlen ertek. Igy a tulajdonos a linket kesobb is
 * kimasolhatja, mikozben a sorokbol magukbol nem rakhato ossze link.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { MAIN_AGENT_ID } from './config.js'
import { createAgentMessage, createApproval, getApproval, getDb } from './db.js'
import { loadAutonomyConfig, effectiveLevel } from './autonomy.js'
import { logger } from './logger.js'
import { getProject } from './projects.js'
import { getWorkItem } from './workbench.js'
import { isHandoffScope, type HandoffScope } from './workbench-handoff.js'

type Lang = 'hu' | 'en'

export const SHARE_CATEGORY = 'permission_change'
export const SHARE_DAYS = [1, 7, 30] as const
export const SHARE_DEFAULT_DAYS = 7
const REJECTED = new Set(['rejected', 'timeout', 'withdrawn', 'expired'])

export type ShareKind = 'item' | 'handoff'
export type ShareStatus = 'pending' | 'active' | 'rejected'

export interface ShareRow {
  id: string
  kind: ShareKind
  project_id: string
  work_item_id: string | null
  scope: HandoffScope | null
  days: number
  lang: Lang
  status: ShareStatus
  approval_id: string | null
  created_by: string | null
  created_at: number
  expires_at: number | null
  revoked_at: number | null
  view_count: number
  last_viewed_at: number | null
}

let tablesDb: unknown = null

export function ensureShareTable(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_shares (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      work_item_id TEXT,
      scope TEXT,
      days INTEGER NOT NULL,
      lang TEXT NOT NULL,
      status TEXT NOT NULL,
      approval_id TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      view_count INTEGER NOT NULL DEFAULT 0,
      last_viewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_shares_project ON work_item_shares(project_id, created_at);
    CREATE TABLE IF NOT EXISTS work_item_share_key (k TEXT NOT NULL);
  `)
  tablesDb = db
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

// --- a token ------------------------------------------------------------------

function shareKey(): Buffer {
  ensureShareTable()
  const db = getDb()
  const row = db.prepare('SELECT k FROM work_item_share_key LIMIT 1').get() as { k: string } | undefined
  if (row) return Buffer.from(row.k, 'base64')
  const k = randomBytes(32).toString('base64')
  db.prepare('INSERT INTO work_item_share_key (k) VALUES (?)').run(k)
  return Buffer.from(k, 'base64')
}

function sign(id: string): string {
  return createHmac('sha256', shareKey()).update(id).digest('base64url')
}

export function shareToken(id: string): string {
  return `${id}.${sign(id)}`
}

/** A token ellenorzese. Barmilyen hibanal `null` -- a hivo nem tudja meg, miert. */
function idFromToken(token: string): string | null {
  const m = /^([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''))
  if (!m) return null
  const want = Buffer.from(sign(m[1]))
  const got = Buffer.from(m[2])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  return m[1]
}

// --- olvasas ------------------------------------------------------------------

export function getShare(id: string): ShareRow | undefined {
  ensureShareTable()
  return getDb().prepare('SELECT * FROM work_item_shares WHERE id = ?').get(id) as ShareRow | undefined
}

export interface ShareView extends ShareRow {
  item_title: string | null
  /** Csak elo linknel: a `/view/...` ut (a hivo teszi ele a cimet). */
  path: string | null
  live: boolean
}

export function isLive(s: ShareRow, at = nowSec()): boolean {
  return s.status === 'active' && !s.revoked_at && !!s.expires_at && s.expires_at > at
}

export function listProjectShares(projectId: string): ShareView[] {
  ensureShareTable()
  const rows = getDb().prepare('SELECT * FROM work_item_shares WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId) as ShareRow[]
  const at = nowSec()
  return rows.map((s) => {
    const live = isLive(s, at)
    return {
      ...s,
      item_title: s.work_item_id ? (getWorkItem(s.work_item_id)?.title ?? null) : null,
      path: live ? `/view/${shareToken(s.id)}` : null,
      live,
    }
  })
}

/**
 * A nyilvanos lap ezt kerdezi: a token ervenyes, a link el, es a mutatott
 * dolog meg letezik. Minden mas `null` -- a lap ugyanazt a mondatot mondja.
 */
export function resolveShareToken(token: string): ShareRow | null {
  const id = idFromToken(token)
  if (!id) return null
  const s = getShare(id)
  if (!s || !isLive(s)) return null
  if (!getProject(s.project_id)) return null
  if (s.kind === 'item') {
    const it = s.work_item_id ? getWorkItem(s.work_item_id) : undefined
    if (!it || it.project_id !== s.project_id) return null
  }
  return s
}

/** Csak a lap megnyitasa szamol (a fajl-letoltes nem), hogy a szam olvashato legyen. */
export function noteShareView(id: string): void {
  try { getDb().prepare('UPDATE work_item_shares SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?').run(nowSec(), id) } catch { /* a szamlalo nem allithatja meg a lapot */ }
}

/** Nyelv a nyilvanos laphoz, token-ellenorzes nelkul (a hibalap nyelvehez). */
export function shareLangHint(token: string): Lang | null {
  const id = idFromToken(token)
  const s = id ? getShare(id) : undefined
  return s ? s.lang : null
}

// --- letrehozas es visszavonas ----------------------------------------------------

let levelReader: () => number = defaultLevel

/** Csak teszteknek. Argumentum nelkul visszaallit. */
export function _setShareDeps(d: { level?: () => number } = {}): void {
  levelReader = d.level || defaultLevel
}

/** A kategoria szintje a fo agensre. Olvashatatlan config: 0 (= jegy kell). */
function defaultLevel(): number {
  try {
    const config = loadAutonomyConfig()
    const cat = config.categories.find((c) => c.key === SHARE_CATEGORY)
    return cat ? effectiveLevel(cat, MAIN_AGENT_ID, config) : 0
  } catch { return 0 }
}

export type ShareCode = 'project_not_found' | 'project_archived' | 'item_not_found' | 'bad_kind' | 'bad_days' | 'bad_scope' | 'blocked'
export type CreateShareResult =
  | { ok: true; state: 'active' | 'pending'; share: ShareRow }
  | { ok: false; code: ShareCode }

export function cleanDays(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return SHARE_DEFAULT_DAYS
  const n = Number(v)
  return (SHARE_DAYS as readonly number[]).includes(n) ? n : null
}

function activate(id: string, days: number): void {
  const at = nowSec()
  getDb().prepare("UPDATE work_item_shares SET status = 'active', approval_id = NULL, expires_at = ? WHERE id = ?").run(at + days * 86_400, id)
}

/**
 * A tulajdonos kattintasa. Ugyanarra a dologra nyitott jegy mellett nem nyit
 * masodikat. A lejarat az ELESITESTOL szamit (egy napokig fuggo jegy ne egye
 * meg a link idejet).
 */
export function requestShare(input: {
  kind: unknown; project_id: unknown; work_item_id?: unknown; scope?: unknown; days?: unknown
  lang: Lang; actor: string | null
}): CreateShareResult {
  ensureShareTable()
  const kind = input.kind === 'item' || input.kind === 'handoff' ? input.kind : null
  if (!kind) return { ok: false, code: 'bad_kind' }
  const days = cleanDays(input.days)
  if (!days) return { ok: false, code: 'bad_days' }
  let project = getProject(String(input.project_id ?? ''))
  let itemId: string | null = null
  let itemTitle = ''
  if (kind === 'item') {
    const it = getWorkItem(String(input.work_item_id ?? ''))
    if (!it) return { ok: false, code: 'item_not_found' }
    if (!project) project = getProject(it.project_id)
    if (!project || it.project_id !== project.id) return { ok: false, code: 'item_not_found' }
    itemId = it.id
    itemTitle = it.title
  }
  if (!project) return { ok: false, code: 'project_not_found' }
  if (project.archived_at) return { ok: false, code: 'project_archived' }
  let scope: HandoffScope | null = null
  if (kind === 'handoff') {
    const sc = input.scope ?? 'done'
    if (!isHandoffScope(sc)) return { ok: false, code: 'bad_scope' }
    scope = sc
  }

  const level = levelReader()
  if (level === 1) return { ok: false, code: 'blocked' }

  const db = getDb()
  const open = db.prepare(`SELECT * FROM work_item_shares WHERE status = 'pending' AND kind = ? AND project_id = ?
    AND IFNULL(work_item_id, '') = ? AND IFNULL(scope, '') = ? AND days = ?`).get(kind, project.id, itemId ?? '', scope ?? '', days) as ShareRow | undefined
  if (open && open.approval_id && getApproval(open.approval_id)?.status === 'pending') {
    return { ok: true, state: 'pending', share: open }
  }

  const id = randomUUID().replace(/-/g, '')
  db.prepare(`INSERT INTO work_item_shares (id, kind, project_id, work_item_id, scope, days, lang, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, kind, project.id, itemId, scope, days, input.lang, input.actor, nowSec())

  if (level >= 3) {
    activate(id, days)
    return { ok: true, state: 'active', share: getShare(id) as ShareRow }
  }

  const hu = input.lang !== 'en'
  const what = kind === 'item'
    ? (hu ? `a(z) „${itemTitle}” munkadarab jelenlegi változata` : `the current version of the work item "${itemTitle}"`)
    : (hu ? `a projekt átadási csomagja (${scope === 'all' ? 'minden munkadarab' : 'a kész munkadarabok'})` : `the project's handoff package (${scope === 'all' ? 'every work item' : 'the finished work items'})`)
  const description = [
    hu ? 'Munkapad: csak olvasható betekintő link kiadása' : 'Workbench: issue a read-only viewer link',
    hu ? `Projekt: ${project.name}` : `Project: ${project.name}`,
    hu ? `Mit lát, aki megkapja: ${what}` : `What the recipient sees: ${what}`,
    hu ? `Lejár: az élesítés után ${days} nappal; bármikor visszavonható` : `Expires: ${days} day(s) after it goes live; can be revoked any time`,
    hu ? 'Más projektet és semmilyen API-t nem ér el.' : 'It reaches no other project and no API.',
    input.actor ? (hu ? `Kérte: ${input.actor}` : `Requested by: ${input.actor}`) : '',
  ].filter(Boolean).join(' · ')
  const approvalId = randomUUID()
  createApproval({
    id: approvalId,
    agent_id: MAIN_AGENT_ID,
    category: SHARE_CATEGORY,
    action_description: description,
    action_payload: JSON.stringify({ source: 'workbench', tool: 'share.create', project: project.id, workItem: itemId, share: id, kind, scope, days, actor: input.actor }),
  })
  db.prepare('UPDATE work_item_shares SET approval_id = ? WHERE id = ?').run(approvalId, id)
  try {
    createAgentMessage('system', MAIN_AGENT_ID, [
      '[APPROVAL_REQUEST]', `id=${approvalId}`, `agent=${MAIN_AGENT_ID}`, `category=${SHARE_CATEGORY}`, `action=${description}`, 'timeout_at=null',
    ].join(' '))
  } catch (err) {
    logger.warn({ err, approvalId }, 'workbench-share: approval notification failed')
  }
  return { ok: true, state: 'pending', share: getShare(id) as ShareRow }
}

/** Visszavonas: azonnali, jegy nelkul (jogot vesz el, nem ad). A fuggo kerest is lezarja. */
export function revokeShare(id: string): ShareRow | null {
  ensureShareTable()
  const s = getShare(id)
  if (!s) return null
  if (!s.revoked_at) getDb().prepare('UPDATE work_item_shares SET revoked_at = ? WHERE id = ?').run(nowSec(), id)
  return getShare(id) as ShareRow
}

/**
 * A mar eldontott link-jegyek feldolgozasa: jovahagyott -> a link el;
 * elutasitott/lejart/eltunt -> 'rejected'. Egy jegy egy futas: a sort
 * feltetelhez kotott UPDATE foglalja le.
 */
export function settleShareApprovals(): number {
  ensureShareTable()
  const db = getDb()
  const rows = db.prepare("SELECT id, approval_id, days FROM work_item_shares WHERE status = 'pending' AND approval_id IS NOT NULL").all() as { id: string; approval_id: string; days: number }[]
  let done = 0
  for (const row of rows) {
    const a = getApproval(row.approval_id)
    if (a && a.status === 'pending') continue
    const approved = !!a && a.status === 'approved'
    if (a && !approved && !REJECTED.has(a.status)) continue
    const at = nowSec()
    const ch = approved
      ? db.prepare("UPDATE work_item_shares SET status = 'active', approval_id = NULL, expires_at = ? WHERE id = ? AND approval_id = ? AND status = 'pending'").run(at + row.days * 86_400, row.id, row.approval_id).changes
      : db.prepare("UPDATE work_item_shares SET status = 'rejected', approval_id = NULL WHERE id = ? AND approval_id = ? AND status = 'pending'").run(row.id, row.approval_id).changes
    if (ch === 1) done++
  }
  return done
}
