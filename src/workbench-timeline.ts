/**
 * PROJEKT-IDOVONAL a Munkapadon (kanban #406, 7. pont).
 *
 * A projekt minden esemenye egyetlen, idoben visszafele rendezett sorban: uj
 * munkadarab, uj verzio (es visszaallitas), felkerult kep/fajl, jovahagyas
 * (kerve, elfogadva, visszadobva), uj kartya es lezart kartya.
 *
 * CSAK OLVAS. Nincs kulon esemenytabla: minden sor a mar meglevo adatbol
 * szarmazik (work_items, work_item_versions, work_item_parts, approvals,
 * kanban_cards, kanban_card_events). Igy a regi projekteknek is van multja,
 * es nincs olyan "esemeny", ami a valodi adattal ellentmondasba kerulhetne.
 *
 * NULLA != "NEM LATTAM": minden forrast KULON kerdezunk. Ha egy nem olvashato,
 * a neve es a hiba bekerul az `errors` listaba -- a felulet kimondja, hogy
 * abbol a forrasbol nem latszik semmi, nem allitja, hogy nem tortent semmi.
 *
 * A szovegeket (mi tortent) a felulet rakja ossze a `kind` alapjan, ket
 * nyelven; innen csak adat jon (cim, verzioszam, fajlnev).
 */
import { getDb } from './db.js'
import { ensureWorkbenchTables } from './workbench.js'

export const TIMELINE_KINDS = [
  'item_created',
  'version',
  'version_restored',
  'file_added',
  'approval_requested',
  'approval_approved',
  'approval_rejected',
  'card_created',
  'card_done',
] as const
export type TimelineKind = typeof TIMELINE_KINDS[number]

export const TIMELINE_SOURCES = ['items', 'versions', 'files', 'approvals', 'cards'] as const
export type TimelineSource = typeof TIMELINE_SOURCES[number]

export interface TimelineEvent {
  kind: TimelineKind
  at: number
  /** Munkadarab, ha az esemeny egyhez tartozik -- a felulet ezzel nyitja meg. */
  item_id: string | null
  item_title: string | null
  /** Verzioszam (version / version_restored), kulonben null. */
  version_no: number | null
  /** Visszaallitasnal: melyik regi verziobol. */
  from_version_no: number | null
  /** Fajl neve (file_added), csak a nev, nem a teljes ut. */
  file_name: string | null
  /** Kartya (card_*), vagy a jovahagyas kartyaja, ha van. */
  card_id: string | null
  card_seq: number | null
  card_title: string | null
  /** Jovahagyas (approval_*). */
  approval_id: string | null
  approval_description: string | null
}

export interface TimelineResult {
  events: TimelineEvent[]
  /** Van-e meg regebbi esemeny a `before` hataron tul. */
  more: boolean
  /** A kovetkezo oldal hatara (`before`), ha van meg. */
  next_before: number | null
  /** Forrasok, amiket NEM tudtunk elolvasni -- ezekbol nem latszik semmi. */
  errors: { source: TimelineSource; detail: string }[]
}

export const TIMELINE_DEFAULT_LIMIT = 50
export const TIMELINE_MAX_LIMIT = 200

function blank(kind: TimelineKind, at: number): TimelineEvent {
  return {
    kind, at,
    item_id: null, item_title: null,
    version_no: null, from_version_no: null,
    file_name: null,
    card_id: null, card_seq: null, card_title: null,
    approval_id: null, approval_description: null,
  }
}

function baseName(p: string | null): string | null {
  if (!p) return null
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : null
}

function tableExists(name: string): boolean {
  const row = getDb().prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return !!row
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function clampTimelineLimit(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return TIMELINE_DEFAULT_LIMIT
  return Math.min(n, TIMELINE_MAX_LIMIT)
}

/**
 * A projekt idovonala, a legfrissebb elol. `before` (masodperc): csak az ennel
 * REGEBBI esemenyek -- ezzel lapoz a felulet visszafele.
 */
export function buildProjectTimeline(
  projectId: string,
  opts: { before?: number | null; limit?: number } = {},
): TimelineResult {
  ensureWorkbenchTables()
  const db = getDb()
  const limit = clampTimelineLimit(opts.limit)
  const before = opts.before && Number.isFinite(opts.before) && opts.before > 0 ? Math.floor(opts.before) : null
  const events: TimelineEvent[] = []
  const errors: TimelineResult['errors'] = []

  const attempt = (source: TimelineSource, fn: () => void): void => {
    try { fn() } catch (e) { errors.push({ source, detail: errText(e) }) }
  }

  // -- munkadarabok: letrejott ------------------------------------------------
  const titles = new Map<string, string>()
  attempt('items', () => {
    const rows = db.prepare('SELECT id, title, created_at FROM work_items WHERE project_id = ?')
      .all(projectId) as { id: string; title: string; created_at: number }[]
    for (const r of rows) {
      titles.set(r.id, r.title)
      const ev = blank('item_created', r.created_at)
      ev.item_id = r.id
      ev.item_title = r.title
      events.push(ev)
    }
  })

  // -- verziok: a v1 maga a letrehozas, azt nem mondjuk ketszer --------------
  attempt('versions', () => {
    const rows = db.prepare(`
      SELECT v.work_item_id, v.version_no, v.created_at, v.metadata_json, w.title
        FROM work_item_versions v JOIN work_items w ON w.id = v.work_item_id
       WHERE w.project_id = ? AND v.version_no > 1`)
      .all(projectId) as { work_item_id: string; version_no: number; created_at: number; metadata_json: string | null; title: string }[]
    for (const r of rows) {
      let fromNo: number | null = null
      if (r.metadata_json) {
        try {
          const m = JSON.parse(r.metadata_json) as Record<string, unknown>
          if (typeof m['restored_from_no'] === 'number') fromNo = m['restored_from_no']
        } catch { /* rosszul tarolt metaadat: sima verziokent latszik */ }
      }
      const ev = blank(fromNo !== null ? 'version_restored' : 'version', r.created_at)
      ev.item_id = r.work_item_id
      ev.item_title = r.title
      ev.version_no = r.version_no
      ev.from_version_no = fromNo
      events.push(ev)
    }
  })

  // -- felkerult kepek/fajlok --------------------------------------------------
  // Egy uj verzio a reszeket MASOLJA: ugyanaz a kep sok sorban all. Egy fajl
  // egyszer kerult fel -- az elso megjelenese az esemeny.
  attempt('files', () => {
    const rows = db.prepare(`
      SELECT p.work_item_id, p.asset_path, MIN(p.created_at) AS at, w.title
        FROM work_item_parts p JOIN work_items w ON w.id = p.work_item_id
       WHERE w.project_id = ? AND p.kind = 'image' AND p.asset_path IS NOT NULL AND p.asset_path != ''
       GROUP BY p.work_item_id, p.asset_path`)
      .all(projectId) as { work_item_id: string; asset_path: string; at: number; title: string }[]
    for (const r of rows) {
      const ev = blank('file_added', r.at)
      ev.item_id = r.work_item_id
      ev.item_title = r.title
      ev.file_name = baseName(r.asset_path)
      events.push(ev)
    }
  })

  // -- kartyak: letrejott / lezarva --------------------------------------------
  const cardInfo = new Map<string, { seq: number; title: string }>()
  attempt('cards', () => {
    if (!tableExists('kanban_cards')) return
    const cards = db.prepare('SELECT rowid AS seq, id, title, created_at FROM kanban_cards WHERE project = ?')
      .all(projectId) as { seq: number; id: string; title: string; created_at: number }[]
    for (const c of cards) {
      cardInfo.set(c.id, { seq: c.seq, title: c.title })
      const ev = blank('card_created', c.created_at)
      ev.card_id = c.id
      ev.card_seq = c.seq
      ev.card_title = c.title
      events.push(ev)
    }
    if (!cards.length || !tableExists('kanban_card_events')) return
    const done = db.prepare(`
      SELECT e.card_id, e.created_at FROM kanban_card_events e
        JOIN kanban_cards k ON k.id = e.card_id
       WHERE k.project = ? AND e.to_status = 'done'`)
      .all(projectId) as { card_id: string; created_at: number }[]
    for (const d of done) {
      const c = cardInfo.get(d.card_id)
      const ev = blank('card_done', d.created_at)
      ev.card_id = d.card_id
      ev.card_seq = c ? c.seq : null
      ev.card_title = c ? c.title : null
      events.push(ev)
    }
  })

  // -- jovahagyasok ---------------------------------------------------------
  // A projekthez tartozik: a Munkapad sajat jegye (payload.project), vagy egy
  // jegy a projekt valamelyik kartyajara (payload.kanban_card_id).
  attempt('approvals', () => {
    if (!tableExists('approvals')) return
    const rows = db.prepare(`
      SELECT id, action_description, action_payload, status, requested_at, resolved_at
        FROM approvals WHERE action_payload LIKE ? OR action_payload LIKE ?`)
      .all(`%${projectId}%`, '%kanban_card_id%') as {
        id: string; action_description: string; action_payload: string | null
        status: string; requested_at: number; resolved_at: number | null
      }[]
    for (const a of rows) {
      let p: Record<string, unknown> = {}
      try { p = JSON.parse(a.action_payload || '{}') as Record<string, unknown> } catch { continue }
      const cardId = typeof p['kanban_card_id'] === 'string' ? p['kanban_card_id'] : null
      const own = p['project'] === projectId
      const onCard = cardId !== null && cardInfo.has(cardId)
      if (!own && !onCard) continue
      const itemId = typeof p['workItem'] === 'string' ? p['workItem'] : null
      const fill = (ev: TimelineEvent): TimelineEvent => {
        ev.approval_id = a.id
        ev.approval_description = a.action_description
        if (onCard && cardId) {
          const c = cardInfo.get(cardId)
          ev.card_id = cardId
          ev.card_seq = c ? c.seq : null
          ev.card_title = c ? c.title : null
        }
        if (itemId) {
          ev.item_id = itemId
          ev.item_title = titles.get(itemId) ?? null
        }
        return ev
      }
      events.push(fill(blank('approval_requested', a.requested_at)))
      if (a.resolved_at && (a.status === 'approved' || a.status === 'rejected')) {
        events.push(fill(blank(a.status === 'approved' ? 'approval_approved' : 'approval_rejected', a.resolved_at)))
      }
    }
  })

  // Az esemeny-ORDER: frissebb elol; azonos masodpercen belul a "kovetkezmeny"
  // (pl. elfogadva) a "kiindulas" (kerve) ELE kerul -- a TIMELINE_KINDS
  // sorrendjet forditva hasznaljuk.
  const rank = (k: TimelineKind): number => TIMELINE_KINDS.indexOf(k)
  const filtered = before === null ? events : events.filter((e) => e.at < before)
  filtered.sort((a, b) => (b.at - a.at) || (rank(b.kind) - rank(a.kind)))

  let page = filtered.slice(0, limit)
  let more = filtered.length > limit
  if (more && page.length) {
    // A lapozas masodpercre megy: egy masodpercen belul nem vagunk ketté,
    // kulonben a kovetkezo oldal (`at < before`) elveszitene a maradekot.
    const edge = page[page.length - 1].at
    const sameSecond = filtered.filter((e) => e.at === edge)
    page = page.filter((e) => e.at !== edge).concat(sameSecond)
    more = filtered.some((e) => e.at < edge)
  }
  const nextBefore = more && page.length ? page[page.length - 1].at : null
  return { events: page, more, next_before: nextBefore, errors }
}
