/**
 * DOKUMENTUM-LAP: VISSZAVONAS ES UJRA (#533, Boss 2026-10-10).
 *
 * A dokumentum es a birosagi beadvany (ugyanaz a lap) tartalma a vazlat tablaiban
 * el (fejezetek, blokkok, allitasok, forrasok, atirasi javaslatok), es a lap
 * magatol ment. Ezert a visszavonas NEM a bongeszo mezonkenti sajat visszavonasa
 * (az mentes utan mar nem latja a regi szoveget): a szerver minden tulajdonosi
 * muvelet elott es utan pillanatkepet tart a vazlat tablairol, es a visszavonas
 * egy pillanatkep visszaallitasa, UGYANAZOKKAL az azonositokkal.
 *
 * Egy muvelet = egy lepes: a hivo (az /outline utvonal) a muvelet ELE hivja a
 * `beginDocStep`-et, az utana jovo kovetkezo hivas (leggyakrabban a muvelet
 * sajat valaszanak `docHistoryState`-je) a `settle`-lel rogziti az utana allapotot.
 * Ami a lap mogott, mas uton valtozott (az agent a doc.* eszkozzel), az a
 * kovetkezo visszavonasnal / muveletnel KULON lepesként bekerul -- igy a
 * visszavonas soha nem ir at csendben mas munkajat.
 *
 * A tortenet a munkadarab vegleges torlesekor (`purgeWorkItem`) magatol megy: a
 * tabla `work_item_id` oszlopos.
 */
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { getDb } from './db.js'
import { ensureDocModelTables } from './workbench-docmodel.js'

/** Ennyi lepest orzunk munkadarabonkent (a vaszon es a videovagas is 100-at). */
export const DOC_HISTORY_MAX = 100
/** A tomoritett pillanatkepek osszmerete munkadarabonkent: a legregebbiek mennek, ha tul sok. */
export const DOC_HISTORY_MAX_BYTES = 32 * 1024 * 1024

type Row = Record<string, unknown>
interface Snapshot { sections: Row[]; blocks: Row[]; claims: Row[]; sources: Row[]; rewrites: Row[] }

export interface DocHistoryState {
  can_undo: boolean
  can_redo: boolean
  /** A visszavonando / ujra elvegezheto lepes cimkeje (gepi szo, a felulet forditja le). */
  undo: string | null
  redo: string | null
}

export type DocStepResult =
  | { ok: true; label: string }
  | { ok: false; code: 'nothing_to_undo' | 'nothing_to_redo' | 'restore_failed'; detail?: string }

/** A tablak, amiket a pillanatkep tartalmaz: egy uj, a vazlathoz tartozo tablat IDE kell felvenni. */
const SNAPSHOT_TABLES: { key: keyof Snapshot; table: string; where: string; order: string; volatile: string[] }[] = [
  { key: 'sections', table: 'wb_doc_sections', where: 'work_item_id = ?', order: 'id', volatile: ['created_at', 'updated_at'] },
  { key: 'blocks', table: 'wb_doc_blocks', where: 'work_item_id = ?', order: 'id', volatile: ['created_at', 'updated_at', 'owner_edited_at'] },
  { key: 'claims', table: 'wb_doc_claims', where: 'work_item_id = ?', order: 'id', volatile: ['created_at'] },
  // A forrasok az allitasukon keresztul tartoznak a munkadarabhoz. Az ellenorzes eredmenye (verdict,
  // detail, checked_at) a hatterben ujraszamolodik, ezert nem szamit "valtozasnak".
  { key: 'sources', table: 'wb_doc_sources', where: 'claim_id IN (SELECT id FROM wb_doc_claims WHERE work_item_id = ?)', order: 'id', volatile: ['created_at', 'checked_at', 'verdict', 'detail'] },
  { key: 'rewrites', table: 'wb_doc_rewrites', where: 'work_item_id = ?', order: 'block_id', volatile: ['created_at'] },
]

let tablesDb: unknown = null

function ensureTables(): void {
  ensureDocModelTables()
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL,
      label TEXT NOT NULL,
      sig TEXT NOT NULL,
      snapshot BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wb_doc_history_item ON wb_doc_history(work_item_id, id);
    CREATE TABLE IF NOT EXISTS wb_doc_history_head (
      work_item_id TEXT PRIMARY KEY,
      head_id INTEGER NOT NULL
    );
  `)
  tablesDb = db
}

/** The label of an operation the history does not know (the agent, another window): the page words it neutrally. */
export const EXTERNAL_LABEL = 'external'

const given = (v: unknown): boolean => v !== undefined && v !== null && v !== ''

/**
 * What an owner request on `.../outline/...` is, as a machine word the page translates -- or null when it is not
 * an edit of the page itself (annexes, "sent", the translation, finalizing have their own records).
 * `segs` are the path pieces after `/api/workbench/items/`: [item, 'outline', sub, id, ...].
 */
export function docStepLabel(method: string, segs: string[], body: Record<string, unknown>): string | null {
  const sub = segs[2] || ''
  const n = segs.length
  if (sub === 'page' && n === 3 && method === 'POST') return 'edit_page'
  if (sub === 'sections' && n === 3 && method === 'POST') return 'add_section'
  if (sub === 'sections' && n === 4 && method === 'PATCH') {
    if (given(body['title'])) return 'rename_section'
    return given(body['position']) ? 'move_section' : 'edit_section'
  }
  if (sub === 'sections' && n === 4 && method === 'DELETE') return 'remove_section'
  if (sub === 'blocks' && n === 3 && method === 'POST') return 'add_block'
  if (sub === 'blocks' && n === 4 && method === 'PATCH') {
    if (given(body['section']) || given(body['position'])) return 'move_block'
    return given(body['text']) || given(body['rich']) ? 'edit_block' : 'format_block'
  }
  if (sub === 'blocks' && n === 4 && method === 'DELETE') return 'remove_block'
  if (sub === 'blocks' && n === 6 && segs[4] === 'rewrite' && segs[5] === 'accept' && method === 'POST') return 'accept_rewrite'
  if (sub === 'blocks' && n === 5 && segs[4] === 'rewrite' && method === 'DELETE') return 'dismiss_rewrite'
  if (sub === 'drop' && n === 3 && method === 'POST') return 'drop'
  if (sub === 'claims' && n === 5 && segs[4] === 'confirm' && method === 'POST') return 'confirm'
  return null
}

/** The step that is begun and not yet closed, per work item (in memory: a restart only loses its label). */
const pending = new Map<string, string>()

function takeSnapshot(itemId: string): Snapshot {
  const db = getDb()
  const out = {} as Snapshot
  for (const t of SNAPSHOT_TABLES) {
    out[t.key] = db.prepare(`SELECT * FROM ${t.table} WHERE ${t.where} ORDER BY ${t.order}`).all(itemId) as Row[]
  }
  return out
}

function signature(s: Snapshot): string {
  const norm: Record<string, Row[]> = {}
  for (const t of SNAPSHOT_TABLES) {
    norm[t.key] = s[t.key].map((r) => {
      const o: Row = {}
      for (const k of Object.keys(r).sort()) if (!t.volatile.includes(k)) o[k] = r[k]
      return o
    })
  }
  return createHash('sha1').update(JSON.stringify(norm)).digest('hex')
}

function headOf(itemId: string): { id: number; sig: string } | null {
  const db = getDb()
  const h = db.prepare('SELECT head_id FROM wb_doc_history_head WHERE work_item_id = ?').get(itemId) as { head_id: number } | undefined
  if (!h) return null
  const row = db.prepare('SELECT id, sig FROM wb_doc_history WHERE id = ? AND work_item_id = ?').get(h.head_id, itemId) as { id: number; sig: string } | undefined
  return row ?? null
}

/** Push a state after the head: the redo branch is gone (as in every editor) and the oldest steps age out. */
function push(itemId: string, snap: Snapshot, sig: string, label: string): void {
  const db = getDb()
  db.transaction(() => {
    const head = headOf(itemId)
    if (head) db.prepare('DELETE FROM wb_doc_history WHERE work_item_id = ? AND id > ?').run(itemId, head.id)
    const info = db.prepare('INSERT INTO wb_doc_history (work_item_id, label, sig, snapshot, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(itemId, label, sig, gzipSync(Buffer.from(JSON.stringify(snap), 'utf-8')), Math.floor(Date.now() / 1000))
    db.prepare('INSERT INTO wb_doc_history_head (work_item_id, head_id) VALUES (?, ?) ON CONFLICT(work_item_id) DO UPDATE SET head_id = excluded.head_id')
      .run(itemId, Number(info.lastInsertRowid))
    // +1: the oldest kept row is the base state the oldest step goes back to.
    db.prepare(`DELETE FROM wb_doc_history WHERE work_item_id = ? AND id NOT IN (
      SELECT id FROM wb_doc_history WHERE work_item_id = ? ORDER BY id DESC LIMIT ?)`).run(itemId, itemId, DOC_HISTORY_MAX + 1)
    let total = (db.prepare('SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS n FROM wb_doc_history WHERE work_item_id = ?').get(itemId) as { n: number }).n
    while (total > DOC_HISTORY_MAX_BYTES) {
      const oldest = db.prepare('SELECT id, LENGTH(snapshot) AS n FROM wb_doc_history WHERE work_item_id = ? ORDER BY id ASC LIMIT 2').all(itemId) as { id: number; n: number }[]
      if (oldest.length < 2) break
      db.prepare('DELETE FROM wb_doc_history WHERE id = ?').run(oldest[0].id)
      total -= oldest[0].n
    }
  })()
}

/** Closes the pending step: the state after the operation becomes the new head (if anything changed). */
export function settleDocStep(itemId: string): void {
  const label = pending.get(itemId)
  if (label === undefined) return
  pending.delete(itemId)
  ensureTables()
  const snap = takeSnapshot(itemId)
  const sig = signature(snap)
  const head = headOf(itemId)
  if (head && head.sig === sig) return
  push(itemId, snap, sig, label)
}

/** Brings the history up to date with the live document: a base state when there is none yet, and the
 *  changes made behind the page's back (the agent) as a step of their own. */
function syncExternal(itemId: string): void {
  const snap = takeSnapshot(itemId)
  const sig = signature(snap)
  const head = headOf(itemId)
  if (!head) { push(itemId, snap, sig, 'base'); return }
  if (head.sig !== sig) push(itemId, snap, sig, EXTERNAL_LABEL)
}

/**
 * Call BEFORE a mutating operation of the owner on the document. `label` is a machine word the page translates
 * ("edit_block", "remove_block", ...). The matching end of the step is closed lazily by `settleDocStep`.
 */
export function beginDocStep(itemId: string, label: string): void {
  ensureTables()
  settleDocStep(itemId)
  syncExternal(itemId)
  pending.set(itemId, /^[a-z_]{1,24}$/.test(label) ? label : 'edit')
}

/** What the page's two buttons need. Cheap: reads the stored steps (and closes a pending one). */
export function docHistoryState(itemId: string): DocHistoryState {
  ensureTables()
  settleDocStep(itemId)
  const db = getDb()
  const none: DocHistoryState = { can_undo: false, can_redo: false, undo: null, redo: null }
  const head = headOf(itemId)
  if (!head) return none
  // A change made behind the page's back is a step too, so the buttons show it -- but only once a history exists.
  syncExternal(itemId)
  const cur = headOf(itemId)
  if (!cur) return none
  const prev = db.prepare('SELECT 1 FROM wb_doc_history WHERE work_item_id = ? AND id < ? LIMIT 1').get(itemId, cur.id)
  const label = (db.prepare('SELECT label FROM wb_doc_history WHERE id = ?').get(cur.id) as { label: string }).label
  const next = db.prepare('SELECT label FROM wb_doc_history WHERE work_item_id = ? AND id > ? ORDER BY id ASC LIMIT 1').get(itemId, cur.id) as { label: string } | undefined
  return { can_undo: !!prev, can_redo: !!next, undo: prev ? label : null, redo: next ? next.label : null }
}

function restore(itemId: string, snap: Snapshot): void {
  const db = getDb()
  db.transaction(() => {
    // Sources first: they are found through their claims.
    for (const t of [...SNAPSHOT_TABLES].reverse()) {
      db.prepare(`DELETE FROM ${t.table} WHERE ${t.where}`).run(itemId)
    }
    for (const t of SNAPSHOT_TABLES) {
      const cols = new Set((db.prepare(`PRAGMA table_info(${t.table})`).all() as { name: string }[]).map((c) => c.name))
      for (const raw of snap[t.key] || []) {
        // A file-based source was checked against the files as they were THEN: it is checked again (the page
        // does that for every "pending" one), so a restored claim never shows a verification that is out of date.
        const row = t.key === 'sources' && raw['kind'] === 'document' ? { ...raw, verdict: 'pending', detail: null, checked_at: null } : raw
        const keys = Object.keys(row).filter((k) => cols.has(k))
        if (!keys.length) continue
        db.prepare(`INSERT OR REPLACE INTO ${t.table} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
          .run(...keys.map((k) => row[k] as never))
      }
    }
  })()
}

function step(itemId: string, dir: 'undo' | 'redo'): DocStepResult {
  ensureTables()
  settleDocStep(itemId)
  syncExternal(itemId)
  const db = getDb()
  const head = headOf(itemId)
  if (!head) return { ok: false, code: dir === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo' }
  // Undo goes back to the state before the step the head is; redo goes to the next state.
  const target = dir === 'undo'
    ? db.prepare('SELECT id, label FROM wb_doc_history WHERE work_item_id = ? AND id < ? ORDER BY id DESC LIMIT 1').get(itemId, head.id)
    : db.prepare('SELECT id, label FROM wb_doc_history WHERE work_item_id = ? AND id > ? ORDER BY id ASC LIMIT 1').get(itemId, head.id)
  const t = target as { id: number; label: string } | undefined
  if (!t) return { ok: false, code: dir === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo' }
  const label = dir === 'undo' ? (db.prepare('SELECT label FROM wb_doc_history WHERE id = ?').get(head.id) as { label: string }).label : t.label
  const raw = db.prepare('SELECT snapshot FROM wb_doc_history WHERE id = ?').get(t.id) as { snapshot: Buffer }
  let snap: Snapshot
  try { snap = JSON.parse(gunzipSync(raw.snapshot).toString('utf-8')) as Snapshot } catch (e) {
    return { ok: false, code: 'restore_failed', detail: e instanceof Error ? e.message : String(e) }
  }
  try { restore(itemId, snap) } catch (e) {
    return { ok: false, code: 'restore_failed', detail: e instanceof Error ? e.message : String(e) }
  }
  db.prepare('INSERT INTO wb_doc_history_head (work_item_id, head_id) VALUES (?, ?) ON CONFLICT(work_item_id) DO UPDATE SET head_id = excluded.head_id').run(itemId, t.id)
  return { ok: true, label }
}

export const undoDocStep = (itemId: string): DocStepResult => step(itemId, 'undo')
export const redoDocStep = (itemId: string): DocStepResult => step(itemId, 'redo')
