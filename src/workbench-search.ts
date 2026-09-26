/**
 * KERESES A PROJEKT EGESZEBEN (kanban #406, 8. pont).
 *
 * Egy mezobol: munkadarab-cimek, a munkadarabok szovegei es kepalairasai, a
 * korabbi Munkapad-beszelgetesek, a projekt kartyai es otletei, valamint a
 * projektmappa fajl- es mappanevei. Ekezet- es kisbetu-fuggetlenul.
 *
 * CSAK OLVAS, es CSAK EZT a projektet nezi: a masik projekt adata nem jon elo.
 *
 * NULLA != "NEM LATTAM": minden forrast KULON kerdezunk. Ha egy forras nem
 * olvashato (vagy a projektnek nincs mappaja), azt a `sources` mondja ki --
 * a felulet igy nem allitja, hogy "nincs talalat", ha oda sem nezett. A
 * fajl-kereses a mar meglevo nev-indexet hasznalja (`findProjectFiles`), es
 * ha az meg keszul, a `files.partial` jelzi, hogy nem a teljes mappabol jott.
 *
 * A fajlok TARTALMABAN nem keresunk: a projektmappa gyakran egy lassu,
 * halozati/Windows meghajto, ahol minden gepelesre minden fajl beolvasasa
 * perceket vinne el. A felulet ezt ki is mondja ("fajlnevek").
 */
import { getDb } from './db.js'
import type { ProjectRow } from './projects.js'
import { hasTable, listProjectIdeas } from './projects.js'
import { ensureWorkbenchTables, listWorkItems, listWorkItemParts } from './workbench.js'
import { findProjectFiles, foldName } from './project-files.js'

export const SEARCH_MIN_CHARS = 2
export const SEARCH_MAX_CHARS = 200
/** Forrasonkent ennyi talalat latszik; a `total` mondja meg, hany volt. */
export const SEARCH_MAX_PER_SOURCE = 20
/** A beszelgetesekbol ennyi (legfrissebb) uzenetet nezunk at. */
export const SEARCH_MESSAGE_SCAN = 5000
export const SNIPPET_RADIUS = 60

export const SEARCH_SOURCES = ['items', 'texts', 'captions', 'messages', 'cards', 'ideas', 'files'] as const
export type SearchSource = typeof SEARCH_SOURCES[number]

export interface SearchHit {
  source: SearchSource
  /** Mihez tartozik (a felulet ezzel nyitja meg). */
  item_id: string | null
  item_title: string | null
  card_id: string | null
  card_seq: number | null
  idea_id: string | null
  /** Fajlnal a projektmappan beluli ut. */
  path: string | null
  /** A megjelenitett cim (munkadarab, kartya, otlet, fajlnev). */
  title: string
  /** Kivonat a talalat korul; `mark_start`/`mark_end` a kiemelendo resz. */
  snippet: string
  mark_start: number
  mark_end: number
  /** Beszelgetesnel: ki mondta (user / assistant). */
  role: string | null
  at: number | null
}

export interface SourceState {
  source: SearchSource
  /** ok = megneztuk; error = nem tudtuk megnezni; none = nincs mit nezni
   *  (pl. a projektnek nincs mappaja) -- a harom KULON dolog. */
  state: 'ok' | 'error' | 'none'
  total: number
  detail: string | null
  /** Fajloknal: nem a teljes mappabol jott a valasz (index keszul / tul nagy). */
  partial?: boolean
}

export interface SearchResult {
  q: string
  hits: SearchHit[]
  sources: SourceState[]
}

export type SearchOutcome =
  | { ok: true; result: SearchResult }
  | { ok: false; code: 'query_short' | 'query_long' }

/** Az osszehasonlitashoz hajtott szoveg ES hogy melyik eredeti betuhoz
 *  tartozik -- igy a kivonat az EREDETI (ekezetes) szovegbol all, pontosan
 *  a talalat korul. */
function foldWithMap(s: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    const f = foldName(s[i])
    for (let k = 0; k < f.length; k++) { folded += f[k]; map.push(i) }
  }
  return { folded, map }
}

/** Ha a szovegben benne van a keresett resz: kivonat es a kiemeles helye. */
export function matchSnippet(text: string | null | undefined, needle: string): { snippet: string; mark_start: number; mark_end: number } | null {
  if (!text) return null
  const { folded, map } = foldWithMap(text)
  const at = folded.indexOf(needle)
  if (at < 0) return null
  const start = map[at]
  const end = map[at + needle.length - 1] + 1
  const from = Math.max(0, start - SNIPPET_RADIUS)
  const to = Math.min(text.length, end + SNIPPET_RADIUS)
  const pre = from > 0 ? '…' : ''
  const post = to < text.length ? '…' : ''
  const body = text.slice(from, to).replace(/\s+/g, ' ')
  // A whitespace-osszevonas eltolhatja a helyet: ujra megkeressuk a kivonatban.
  const again = foldWithMap(body)
  const k = again.folded.indexOf(needle)
  const ms = k >= 0 ? again.map[k] : 0
  const me = k >= 0 ? again.map[k + needle.length - 1] + 1 : 0
  return { snippet: pre + body + post, mark_start: ms + pre.length, mark_end: me + pre.length }
}

function hit(source: SearchSource, title: string, m: { snippet: string; mark_start: number; mark_end: number }): SearchHit {
  return {
    source, title, ...m,
    item_id: null, item_title: null, card_id: null, card_seq: null, idea_id: null, path: null, role: null, at: null,
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function searchProject(project: ProjectRow, qRaw: unknown): Promise<SearchOutcome> {
  const q = String(qRaw ?? '').replace(/\s+/g, ' ').trim()
  if (q.length < SEARCH_MIN_CHARS) return { ok: false, code: 'query_short' }
  if (q.length > SEARCH_MAX_CHARS) return { ok: false, code: 'query_long' }
  ensureWorkbenchTables()
  const needle = foldName(q)
  const hits: SearchHit[] = []
  const sources: SourceState[] = []

  const run = (source: SearchSource, fn: () => SearchHit[]): void => {
    try {
      const found = fn()
      sources.push({ source, state: 'ok', total: found.length, detail: null })
      hits.push(...found.slice(0, SEARCH_MAX_PER_SOURCE))
    } catch (e) {
      sources.push({ source, state: 'error', total: 0, detail: errText(e) })
    }
  }

  // Munkadarabok + a JELENLEGI reszeik (a regi verziok masolatai nem
  // duplazzak a talalatot).
  let items: ReturnType<typeof listWorkItems> = []
  let itemsError: string | null = null
  try { items = listWorkItems(project.id) } catch (e) { itemsError = errText(e) }
  const titleOf = new Map(items.map((w) => [w.id, w.title]))

  if (itemsError) {
    for (const s of ['items', 'texts', 'captions'] as const) sources.push({ source: s, state: 'error', total: 0, detail: itemsError })
  } else {
    run('items', () => {
      const out: SearchHit[] = []
      for (const w of items) {
        const m = matchSnippet(w.title, needle)
        if (!m) continue
        const h = hit('items', w.title, m)
        h.item_id = w.id; h.item_title = w.title; h.at = w.updated_at
        out.push(h)
      }
      return out
    })
    const texts: SearchHit[] = []
    const captions: SearchHit[] = []
    let partsError: string | null = null
    try {
      for (const w of items) {
        for (const p of listWorkItemParts(w.id)) {
          const mt = p.kind === 'text' ? matchSnippet(p.text, needle) : null
          if (mt) {
            const h = hit('texts', w.title, mt)
            h.item_id = w.id; h.item_title = w.title; h.at = p.updated_at
            texts.push(h)
          }
          const mc = matchSnippet(p.caption, needle)
          if (mc) {
            const h = hit('captions', w.title, mc)
            h.item_id = w.id; h.item_title = w.title; h.at = p.updated_at
            captions.push(h)
          }
        }
      }
    } catch (e) { partsError = errText(e) }
    if (partsError) {
      sources.push({ source: 'texts', state: 'error', total: 0, detail: partsError })
      sources.push({ source: 'captions', state: 'error', total: 0, detail: partsError })
    } else {
      run('texts', () => texts)
      run('captions', () => captions)
    }
  }

  // Korabbi beszelgetesek ebben a projektben (a legfrissebb elol).
  run('messages', () => {
    if (!hasTable('workbench_agent_messages') || !hasTable('workbench_agent_sessions')) return []
    const rows = getDb().prepare(`
      SELECT m.content, m.role, m.created_at, s.work_item_id
        FROM workbench_agent_messages m JOIN workbench_agent_sessions s ON s.id = m.session_id
       WHERE s.project_id = ? AND m.role IN ('user', 'assistant')
       ORDER BY m.created_at DESC LIMIT ?`)
      .all(project.id, SEARCH_MESSAGE_SCAN) as { content: string; role: string; created_at: number; work_item_id: string | null }[]
    const out: SearchHit[] = []
    for (const r of rows) {
      const m = matchSnippet(r.content, needle)
      if (!m) continue
      const title = r.work_item_id ? (titleOf.get(r.work_item_id) ?? '') : ''
      const h = hit('messages', title, m)
      h.role = r.role; h.at = r.created_at
      h.item_id = r.work_item_id && titleOf.has(r.work_item_id) ? r.work_item_id : null
      h.item_title = h.item_id ? title : null
      out.push(h)
    }
    return out
  })

  run('cards', () => {
    if (!hasTable('kanban_cards')) return []
    const rows = getDb().prepare(`
      SELECT rowid AS seq, id, title, description, updated_at FROM kanban_cards
       WHERE project = ? AND archived_at IS NULL ORDER BY updated_at DESC`)
      .all(project.id) as { seq: number; id: string; title: string; description: string | null; updated_at: number }[]
    const out: SearchHit[] = []
    for (const c of rows) {
      const m = matchSnippet(c.title, needle) || matchSnippet(c.description, needle)
      if (!m) continue
      const h = hit('cards', c.title, m)
      h.card_id = c.id; h.card_seq = c.seq; h.at = c.updated_at
      out.push(h)
    }
    return out
  })

  run('ideas', () => {
    const out: SearchHit[] = []
    for (const i of listProjectIdeas(project.id)) {
      const m = matchSnippet(i.title, needle) || matchSnippet(i.description, needle)
      if (!m) continue
      const h = hit('ideas', i.title, m)
      h.idea_id = i.id; h.at = i.updated_at
      out.push(h)
    }
    return out
  })

  // Fajl- es mappanevek a projektmappaban.
  if (!project.folder_path) {
    sources.push({ source: 'files', state: 'none', total: 0, detail: null })
  } else {
    try {
      const f = await findProjectFiles(project, q)
      if (!f.ok) {
        sources.push({ source: 'files', state: 'error', total: 0, detail: f.code })
      } else {
        const found: SearchHit[] = []
        for (const e of f.hits) {
          const m = matchSnippet(e.name, needle)
          if (!m) continue
          const h = hit('files', e.name, m)
          h.path = e.sub; h.at = Math.floor(e.at / 1000)
          found.push(h)
        }
        sources.push({ source: 'files', state: 'ok', total: found.length, detail: null, partial: f.truncated || f.indexing || f.more || f.capped })
        hits.push(...found.slice(0, SEARCH_MAX_PER_SOURCE))
      }
    } catch (e) {
      sources.push({ source: 'files', state: 'error', total: 0, detail: errText(e) })
    }
  }

  // A forrasok sorrendje rogzitett (a felulet csoportonkent mutatja).
  sources.sort((a, b) => SEARCH_SOURCES.indexOf(a.source) - SEARCH_SOURCES.indexOf(b.source))
  return { ok: true, result: { q, hits, sources } }
}
