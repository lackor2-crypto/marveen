/**
 * A MUNKAPAD PROJEKT-SZINTU ESZKOZEI (kanban #404, H5).
 *
 * A Munkapad-agens eddig csak fajlt, munkadarabot es uj kartyat tudott
 * letrehozni. A tulajdonos (TG 6478): "mindent le tud generalni, ossze tud
 * fuzni, letre tud hozni". Ez a modul a projekt tobbi, mar LETEZO feluletet
 * koti be, UGYANAZON az uton, amin a dashboard is dolgozik:
 *
 *   - Otletlada: `createIdea` + `linkObject('idea')` -- ugyanaz a ket sor,
 *     mint a projekt-oldal "uj otlet" gombja (routes/projects.ts);
 *   - Kutatas: egy .md a fo agens research/ mappajaban, a `project: <id>`
 *     jelolessel es kifejezett kotessel -- a Kutatas-oldal magatol listazza;
 *   - kanban: komment egy meglevo kartyara, es ket kartya osszekotese a
 *     leirasban, MINDKET iranyban (`withCrossLink`, a CLAUDE.md
 *     "Kapcsolodo kartya belinkelese" szabalya).
 *
 * A kartya-muvelet CSAK ennek a projektnek a kartyajan indulhat: a Munkapad
 * egy projekt felulete, nem az egesz tabla.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { addKanbanComment, createIdea, getDb, getKanbanCard, updateKanbanCard } from '../db.js'
import { linkObject, type ProjectRow } from '../projects.js'
import { ideaProjectMap, researchObjectId } from '../project-scope.js'
import { withCrossLink } from '../kanban-related.js'
import { agentConfigRoot } from '../web/agent-config.js'
import type { ToolResult } from './execute.js'

export const IDEA_LIST_MAX = 50
export const COMMENT_MAX_CHARS = 4000
export const RESEARCH_MAX_CHARS = 200_000

let researchDirOverride: string | null = null
/** Csak teszthez: a research/ mappa helye (a teszt ne irjon az elo mappaba). */
export function setResearchDirForTest(dir: string | null): void {
  researchDirOverride = dir
}
function researchDir(): string {
  return researchDirOverride ?? join(agentConfigRoot(MAIN_AGENT_ID), 'research')
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim()
}

// ---- otletlada -------------------------------------------------------------------

export function ideaList(project: ProjectRow): ToolResult {
  const map = ideaProjectMap()
  const ids = [...map.entries()].filter(([, p]) => p === project.id).map(([id]) => id)
  if (ids.length === 0) return { ok: true, data: { count: 0, ideas: [], note: 'this project has no idea in the Idea box yet' } }
  const rows = getDb().prepare(
    `SELECT id, title, description, category, status, created_at FROM idea_box
      WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`,
  ).all(...ids, IDEA_LIST_MAX) as { id: string; title: string; description: string | null; category: string; status: string }[]
  return { ok: true, data: { count: ids.length, shown: rows.length, ideas: rows.map((r) => ({ id: r.id, title: r.title, category: r.category, status: r.status, description: (r.description || '').slice(0, 300) })) } }
}

export function ideaCreate(project: ProjectRow, input: Record<string, unknown>): ToolResult {
  const title = str(input.title)
  if (!title) return { ok: false, code: 'bad_input', detail: 'title is required' }
  const id = randomUUID().slice(0, 8)
  getDb().transaction(() => {
    createIdea({
      id, title, description: str(input.description) || null, category: str(input.category) || 'Egyéb',
      status: 'new', source: 'workbench', kanban_id: null, impact: null, effort: null,
    })
    // Az otlet MINDIG ehhez a projekthez kotodik -- ugyanaz, mint a kartyanal.
    linkObject(project.id, 'idea', id, 'workbench')
  })()
  return { ok: true, data: { id, title, project: project.id, projectName: project.name } }
}

// ---- kutatas -----------------------------------------------------------------------

/** Kisbetus, szam, kotojel -- a Kutatas-oldal csak ilyen nevet listaz. */
export function researchSlug(title: string): string {
  const base = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return base || 'kutatas'
}

export function researchSave(project: ProjectRow, input: Record<string, unknown>): ToolResult {
  const title = str(input.title)
  const text = input.text === undefined || input.text === null ? '' : String(input.text)
  if (!title) return { ok: false, code: 'bad_input', detail: 'title is required' }
  if (!text.trim()) return { ok: false, code: 'bad_input', detail: 'text is required' }
  if (text.length > RESEARCH_MAX_CHARS) return { ok: false, code: 'too_large', detail: `text is longer than ${RESEARCH_MAX_CHARS} characters` }
  const dir = researchDir()
  try { mkdirSync(dir, { recursive: true }) } catch (err) {
    return { ok: false, code: 'unreachable', detail: `the research folder cannot be created: ${(err as Error).message}` }
  }
  // SOSEM ir felul: foglalt nevnel -2, -3, ...
  const slug = researchSlug(title)
  let name = `${slug}.md`
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${slug}-${i}.md`
  const body = text.replace(/^\s*#\s+.*\n?/, '')
  writeFileSync(join(dir, name), `# ${title}\n\nproject: ${project.id}\n\n${body.trimStart()}\n`, { flag: 'wx' })
  linkObject(project.id, 'research', researchObjectId(MAIN_AGENT_ID, name), 'workbench')
  return { ok: true, data: { name, agent: MAIN_AGENT_ID, project: project.id, note: 'it shows up on the Research page, filtered to this project' } }
}

// ---- kanban: komment + osszekotes ------------------------------------------------------

interface CardRow { id: string; seq: number; title: string; status: string; project: string | null; description: string | null }

/** `#N`, `N`, teljes id vagy EGYERTELMU id-eleje -> kartya. Ket talalatnal nem talalgatunk. */
export function findCard(ref: unknown): CardRow | null {
  const raw = str(ref).replace(/^#/, '')
  if (!raw) return null
  const db = getDb()
  const cols = 'rowid AS seq, id, title, status, project, description'
  if (/^\d+$/.test(raw)) {
    return (db.prepare(`SELECT ${cols} FROM kanban_cards WHERE rowid = ? AND archived_at IS NULL`).get(Number(raw)) as CardRow | undefined) ?? null
  }
  const rows = db.prepare(`SELECT ${cols} FROM kanban_cards WHERE id LIKE ? AND archived_at IS NULL LIMIT 2`).all(`${raw}%`) as CardRow[]
  return rows.length === 1 ? rows[0]! : null
}

function ownCard(project: ProjectRow, ref: unknown): { ok: true; card: CardRow } | { ok: false; code: string; detail: string } {
  if (!str(ref)) return { ok: false, code: 'bad_input', detail: 'card is required (#number or id)' }
  const card = findCard(ref)
  if (!card) return { ok: false, code: 'card_not_found', detail: `no open card matches ${str(ref)} (use project.listKanban to see the cards)` }
  if (card.project !== project.id) {
    return { ok: false, code: 'card_other_project', detail: `card #${card.seq} does not belong to this project, so it cannot be changed from here` }
  }
  return { ok: true, card }
}

export function kanbanComment(project: ProjectRow, input: Record<string, unknown>, author: string): ToolResult {
  const own = ownCard(project, input.card)
  if (!own.ok) return own
  const text = str(input.text)
  if (!text) return { ok: false, code: 'bad_input', detail: 'text is required' }
  if (text.length > COMMENT_MAX_CHARS) return { ok: false, code: 'too_large', detail: `the comment is longer than ${COMMENT_MAX_CHARS} characters` }
  const c = addKanbanComment(own.card.id, author, text)
  return { ok: true, data: { card: own.card.id, seq: own.card.seq, comment: c.id } }
}

export function kanbanRelate(project: ProjectRow, input: Record<string, unknown>): ToolResult {
  const own = ownCard(project, input.card)
  if (!own.ok) return own
  const refs = Array.isArray(input.related) ? input.related : str(input.related) ? String(input.related).split(',') : []
  if (refs.length === 0) return { ok: false, code: 'bad_input', detail: 'related is required: the cards to link (#number or id)' }
  const others: CardRow[] = []
  const missing: string[] = []
  for (const r of refs) {
    const c = findCard(r)
    if (!c) missing.push(str(r))
    else if (c.id !== own.card.id && !others.some((o) => o.id === c.id)) others.push(c)
  }
  if (missing.length) return { ok: false, code: 'card_not_found', detail: `no open card matches: ${missing.join(', ')}` }
  if (others.length === 0) return { ok: false, code: 'bad_input', detail: 'a card cannot be linked to itself' }
  // A kapcsolat a LEIRASBA kerul, mindket iranyban -- a dashboard onnan olvassa.
  const self = getKanbanCard(own.card.id)
  const next = withCrossLink(self?.description ?? '', others.map((o) => ({ id: o.id, seq: o.seq, title: o.title, status: o.status })))
  if (next !== (self?.description ?? '')) updateKanbanCard(own.card.id, { description: next })
  for (const o of others) {
    const cur = getKanbanCard(o.id)
    const upd = withCrossLink(cur?.description ?? '', [{ id: own.card.id, seq: own.card.seq, title: own.card.title, status: own.card.status }])
    if (upd !== (cur?.description ?? '')) updateKanbanCard(o.id, { description: upd })
  }
  return { ok: true, data: { card: own.card.id, seq: own.card.seq, linked: others.map((o) => `#${o.seq}`) } }
}
