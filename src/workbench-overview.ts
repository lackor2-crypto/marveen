/**
 * MUNKAPAD PROJEKT-ATTEKINTO (kanban #406, 2. pont).
 *
 * A Munkapad tetejen egy pillantasra: mi van NYITVA, mi VAR JOVAHAGYASRA, mi
 * lett FRISSEN KESZ, es melyik FAJL valtozott utoljara. Csak OLVAS.
 *
 * A NULLA KET DOLGOT JELENTHET: "nincs ilyen" vagy "nem lattam oda". Ezert
 * minden forras (munkadarabok, kanban-kartyak, jovahagyasok) KULON kerdezodik
 * meg, es ha egy forras nem valaszol, az a sajat `error` mezojeben all -- a
 * szama ilyenkor `null`, nem nulla. Friss telepitesen (nincs kanban-tabla,
 * nincs egy jovahagyas sem) a valasz ures, de nem hiba.
 */
import { basename } from 'node:path'
import { getDb, listPendingApprovals } from './db.js'
import { hasTable } from './projects.js'
import { approvalCardId } from './kanban-related.js'
import { ensureWorkbenchTables, type WorkItemStatus } from './workbench.js'

/** Mennyi ideig "friss" egy kesz munkadarab. */
export const RECENT_DONE_DAYS = 14
/** Listankent ennyit adunk vissza (a tobbit a szam mondja meg). */
export const OVERVIEW_LIST_MAX = 5

export interface OverviewItem {
  id: string
  title: string
  status: WorkItemStatus
  updated_at: number
}

export interface OverviewApproval {
  id: string
  category: string
  description: string
  requested_at: number
  /** The kanban card the approval is about, so the tile can show it as its
   *  own small card (#number + title) instead of a run of text. `null` when
   *  the approval names no card or the card is gone. */
  card_seq: number | null
  card_title: string | null
}

export interface WorkbenchOverview {
  /** Nem kesz munkadarabok (draft / in_progress / review). */
  open: { count: number; items: OverviewItem[] }
  /** A projekt nyitott kanban-kartyai. `null` = nem tudtam megszamolni. */
  cards: { open: number | null; error: string | null }
  /** Jovahagyasra var: az "atnezesre var" munkadarabok + a projekt fuggo
   *  jovahagyas-jegyei. A jegyek szama `null`, ha nem tudtam lekerdezni. */
  review: { count: number; items: OverviewItem[] }
  approvals: { count: number | null; items: OverviewApproval[]; error: string | null }
  /** Az utobbi napokban kesz lett munkadarabok. */
  recent_done: { count: number; items: OverviewItem[]; days: number }
  /** Az utoljara valtozott fajl (a munkadarabok verzioiban/reszeiben). */
  last_file: { name: string; rel: string; item_id: string; item_title: string; at: number } | null
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** A jegy ehhez a projekthez tartozik-e: a Munkapad sajat jegye (payload
 *  `project`), vagy a projekt egyik kanban-kartyajara hivatkozik. */
function approvalBelongs(a: { action_payload: string | null; action_description: string }, projectId: string, cardIds: string[]): boolean {
  if (a.action_payload) {
    try {
      const p = JSON.parse(a.action_payload) as Record<string, unknown>
      if (p && typeof p === 'object' && (p['project'] === projectId || p['project_id'] === projectId)) return true
    } catch { /* nem JSON: a kartya-hivatkozas meg donthet */ }
  }
  const card = approvalCardId(a.action_payload, a.action_description || '')
  if (!card) return false
  return cardIds.some((id) => id === card || id.startsWith(card))
}

export function buildWorkbenchOverview(projectId: string, now: number = Math.floor(Date.now() / 1000)): WorkbenchOverview {
  ensureWorkbenchTables()
  const db = getDb()
  const pid = String(projectId || '').trim()

  const rows = db.prepare(
    'SELECT id, title, status, updated_at FROM work_items WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC',
  ).all(pid) as OverviewItem[]
  const open = rows.filter((r) => r.status !== 'done')
  const review = rows.filter((r) => r.status === 'review')
  const since = now - RECENT_DONE_DAYS * 86400
  const done = rows.filter((r) => r.status === 'done' && r.updated_at >= since)

  // KANBAN: friss telepitesen a tabla meg nincs -- az "nincs kartya", nem hiba.
  let cardIds: string[] = []
  const cards: WorkbenchOverview['cards'] = { open: 0, error: null }
  try {
    if (hasTable('kanban_cards')) {
      cardIds = (db.prepare('SELECT id FROM kanban_cards WHERE project = ? AND archived_at IS NULL').all(pid) as { id: string }[]).map((r) => r.id)
      const n = db.prepare(
        "SELECT COUNT(*) AS n FROM kanban_cards WHERE project = ? AND archived_at IS NULL AND status != 'done'",
      ).get(pid) as { n: number }
      cards.open = n.n
    }
  } catch (e) {
    cards.open = null
    cards.error = errText(e)
  }

  const approvals: WorkbenchOverview['approvals'] = { count: 0, items: [], error: null }
  try {
    const mine = listPendingApprovals().filter((a) => approvalBelongs(a, pid, cardIds))
    approvals.count = mine.length
    // Boss, 2026-09-26 (TG 6535): the tile ran the approvals together as one
    // block of text, so two cards read like one. Each approval now carries its
    // card's number and title, and the page draws it as its own small card.
    const cardStmt = hasTable('kanban_cards')
      ? db.prepare('SELECT rowid AS seq, title FROM kanban_cards WHERE id = ? OR id LIKE ? ORDER BY length(id) LIMIT 1')
      : null
    approvals.items = mine.slice(0, OVERVIEW_LIST_MAX).map((a) => {
      const ref = approvalCardId(a.action_payload, a.action_description || '')
      let card: { seq: number; title: string } | undefined
      if (ref && cardStmt) {
        try { card = cardStmt.get(ref, `${ref}%`) as { seq: number; title: string } | undefined } catch { card = undefined }
      }
      return {
        id: a.id,
        category: a.category,
        // A leiras elso sora eleg a csempere; a teljes szoveg a Jovahagyasok oldalon all.
        description: String(a.action_description || '').split('\n')[0].slice(0, 200),
        requested_at: a.requested_at,
        card_seq: card ? Number(card.seq) : null,
        card_title: card ? String(card.title || '') : null,
      }
    })
  } catch (e) {
    approvals.count = null
    approvals.error = errText(e)
  }

  // UTOLJARA VALTOZOTT FAJL: a verziok forrasfajljai es a kep-reszek kozul a
  // legfrissebb. Csak a Munkapad sajat adatabol -- a lemezt nem jarjuk be.
  const lastVersion = db.prepare(`
    SELECT v.source_path AS rel, v.created_at AS at, i.id AS item_id, i.title AS item_title
      FROM work_item_versions v JOIN work_items i ON i.id = v.work_item_id
     WHERE i.project_id = ? AND v.source_path IS NOT NULL AND v.source_path != ''
     ORDER BY v.created_at DESC LIMIT 1`).get(pid) as { rel: string; at: number; item_id: string; item_title: string } | undefined
  const lastPart = db.prepare(`
    SELECT p.asset_path AS rel, p.updated_at AS at, i.id AS item_id, i.title AS item_title
      FROM work_item_parts p JOIN work_items i ON i.id = p.work_item_id
     WHERE i.project_id = ? AND p.asset_path IS NOT NULL AND p.asset_path != ''
     ORDER BY p.updated_at DESC LIMIT 1`).get(pid) as { rel: string; at: number; item_id: string; item_title: string } | undefined
  const last = [lastVersion, lastPart].filter(Boolean).sort((a, b) => b!.at - a!.at)[0]

  return {
    open: { count: open.length, items: open.slice(0, OVERVIEW_LIST_MAX) },
    cards,
    review: { count: review.length, items: review.slice(0, OVERVIEW_LIST_MAX) },
    approvals,
    recent_done: { count: done.length, items: done.slice(0, OVERVIEW_LIST_MAX), days: RECENT_DONE_DAYS },
    last_file: last ? { name: basename(last.rel), rel: last.rel, item_id: last.item_id, item_title: last.item_title, at: last.at } : null,
  }
}
