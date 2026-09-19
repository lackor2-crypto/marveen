/**
 * A PROJEKT MINDENHOL -- otlet, vitaztatas, hatteranyag, kanban (kanban #321,
 * c17e3a2d; Boss 2026-09-19).
 *
 * A tulajdonos kerese: ha egy projekten BELUL hoz letre valamit (otletet,
 * vitaztatast, hatteranyag-gyujtest, kartyat), az magatol a projekthez
 * tartozzon -- semmit ne kelljen beirnia. Es a Marvin-oldali oldalakon
 * (Otletlada, Vitaztatas, Kutatas, Kanban) projektre lehessen szurni.
 *
 * Ez a modul adja minden objektum projektjet EGY helyen, hogy a harom oldal
 * ugyanugy dontson:
 *
 *   - otlet:      kifejezett kotes (`project_links`) > a hozza tartozo kartya
 *                 projektje (levezetett, lasd `projectIdeaIds`).
 *   - vitaztatas: kifejezett kotes > a naplo 1. koreben rogzitett `project`
 *                 mezo (`scripts/debate.mjs ask --project <id>`).
 *   - hatteranyag (research/*.md): kifejezett kotes > a fajl elejen allo
 *                 `project: <id vagy nev>` / `Projekt: ...` sor.
 *
 * A "projektbol inditott" vitaztatas es hatteranyag-gyujtes a fo agensnek
 * szolo uzenet (ezeket az agens vegzi, nem a dashboard): az uzenet megmondja,
 * hogyan jelolje meg az eredmenyt, es a fenti szabaly ettol kezdve magatol a
 * projekthez sorolja.
 */
import { randomUUID } from 'node:crypto'
import { BOT_NAME } from './config.js'
import { createKanbanCard, getDb } from './db.js'
import {
  ensureProjectTables, getProject, hasTable, projectForObject, isDetached, resolveProjectRef, type ProjectRow,
} from './projects.js'

/** Csak letezo projekt-id jon vissza; ismeretlen szoveg -> null. */
export function knownProjectId(value: unknown): string | null {
  const ref = resolveProjectRef(value)
  if (!ref) return null
  const p = getProject(ref)
  return p && p.id === ref ? ref : null
}

/** Minden otlet projektje egy lepesben (id -> projekt-id). Projekt nelkuli otlet nincs benne. */
export function ideaProjectMap(): Map<string, string> {
  ensureProjectTables()
  const out = new Map<string, string>()
  if (!hasTable('idea_box')) return out
  const db = getDb()
  if (hasTable('kanban_cards')) {
    const viaCard = db.prepare(
      `SELECT i.id AS id, k.project AS project FROM idea_box i
         JOIN kanban_cards k ON k.id = i.kanban_id
         JOIN projects p ON p.id = k.project`,
    ).all() as { id: string; project: string }[]
    for (const r of viaCard) out.set(r.id, r.project)
  }
  // A kifejezett kotes nyer a levezetett felett.
  const links = db.prepare(
    `SELECT l.object_id AS id, l.project_id AS project FROM project_links l
       JOIN projects p ON p.id = l.project_id WHERE l.object_type = 'idea'`,
  ).all() as { id: string; project: string }[]
  for (const r of links) out.set(r.id, r.project)
  return out
}

/** A vitaztatas projektje: kifejezett kotes, kulonben a naplo `project` mezoje. */
export function debateProject(sessionId: string, logged: unknown): string | null {
  ensureProjectTables()
  const linked = projectForObject('debate', sessionId)
  if (linked && getProject(linked)) return linked
  if (isDetached('debate', sessionId)) return null
  return logged ? knownProjectId(logged) : null
}

/** A hatteranyag-fajl elejen allo projekt-jeloles (az elso 15 sorban). */
export function researchProjectMark(content: string): string | null {
  const lines = content.split('\n').slice(0, 15)
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*>]\s*)?\**\s*(?:project|projekt)\s*\**\s*:\s*\**\s*(.+?)\s*\**\s*$/i)
    if (m) return m[1].replace(/^["'`]|["'`]$/g, '').trim() || null
  }
  return null
}

/** A hatteranyag azonositoja a kotesben: `<agens>/<fajlnev>`. */
export function researchObjectId(agent: string, name: string): string {
  return `${agent}/${name}`
}

export function researchProject(agent: string, name: string, content: string): string | null {
  ensureProjectTables()
  const linked = projectForObject('research', researchObjectId(agent, name))
  if (linked && getProject(linked)) return linked
  if (isDetached('research', researchObjectId(agent, name))) return null
  const mark = researchProjectMark(content)
  return mark ? knownProjectId(mark) : null
}

// ---- kezdo kartya uj projekthez -------------------------------------------------

const STARTER: Record<'hu' | 'en', { title: (n: string) => string; body: string }> = {
  hu: {
    title: (n) => `Indulás: ${n}`,
    body: [
      'Ez a projekt kezdő kártyája -- a projekt létrehozásakor magától jött létre.',
      '',
      'Írd ide (vagy kommentben), amit a projektről már tudsz:',
      '- Mi a cél? Mikor lesz kész, és miből látszik, hogy kész?',
      '- Kinek készül, ki dönt?',
      '- Mi az első három lépés?',
      '',
      'Ha már nincs rá szükség, archiválhatod vagy törölheted.',
    ].join('\n'),
  },
  en: {
    title: (n) => `Kickoff: ${n}`,
    body: [
      'This is the starter card of the project -- it was made automatically when the project was created.',
      '',
      'Write here (or in a comment) what you already know about the project:',
      '- What is the goal? When is it done, and how can you tell?',
      '- Who is it for, who decides?',
      '- What are the first three steps?',
      '',
      'When you no longer need it, archive or delete it.',
    ].join('\n'),
  },
}

/** A projekt kezdo kartyaja. A cimket a hivo teszi ra (a projekt alapertelmezett
 *  cimkeje -- a hivo elore ellenorzi, hogy van-e, ha a tablan kotelezo). */
export function createStarterCard(p: ProjectRow, lang: 'hu' | 'en'): string {
  const t = STARTER[lang]
  const id = randomUUID().slice(0, 8)
  const desc = p.description ? `${p.description}\n\n${t.body}` : t.body
  createKanbanCard({
    id, title: t.title(p.name), description: desc, status: 'planned', priority: 'normal', assignee: BOT_NAME, project: p.id,
  })
  return id
}

// ---- projektbol inditott keres a fo agensnek ------------------------------------

export type ProjectRequestKind = 'debate' | 'research'

export function isRequestKind(v: unknown): v is ProjectRequestKind {
  return v === 'debate' || v === 'research'
}

/**
 * A fo agensnek szolo uzenet. Angolul: az agens utasitasa, nem a tulajdonosnak
 * szolo szoveg (a valaszt a tulajdonos nyelven adja). A jeloles modjat PONTOSAN
 * megmondja -- ettol lesz az eredmeny magatol a projekte.
 */
export function projectRequestMessage(p: ProjectRow, kind: ProjectRequestKind, text: string, lang: 'hu' | 'en'): string {
  const head = `[PROJECT REQUEST from the dashboard] Project "${p.name}" (id ${p.id}).`
  const langLine = `Answer the owner in ${lang === 'en' ? 'English' : 'Hungarian'}.`
  if (kind === 'debate') {
    return [
      head,
      'The owner started a multi-model debate (vitaztatas) from the project page. Question:',
      '',
      text,
      '',
      `Run it with scripts/debate.mjs as usual, and pass \`--project ${p.id}\` on EVERY \`ask\` call`
        + ' (at least on round 1) -- that is what files the debate under this project on the dashboard.'
        + ' Conclude it with `conclude` when done.',
      langLine,
    ].join('\n')
  }
  return [
    head,
    'The owner asked for background research (hatteranyag-gyujtes) from the project page. Topic:',
    '',
    text,
    '',
    'Collect the material and save it as ONE markdown file in your research/ folder'
      + ' (name: lowercase letters, digits, dash, ending in .md). Start the file with a `# Title` line,'
      + ` and put this exact line right under it: \`project: ${p.id}\` -- that is what files it under this project on the dashboard.`,
    langLine,
  ].join('\n')
}

// ---- projekt-szures a bal menu tobbi oldalan ----------------------------------------
// Memoria / Utemezes / Skill: kifejezett kotes (`project_links`), a lista soraban
// valaszthato. Jovahagyas: a kartyaja projektje (`action_payload.kanban_card_id`).
// Uzenet: a benne hivatkozott kartyak projektjei (egy uzenet tobb projekte is lehet).

export const SCOPE_TYPES = ['memory', 'schedule', 'skill', 'approval', 'message'] as const
export type ScopeType = typeof SCOPE_TYPES[number]

export function isScopeType(v: unknown): v is ScopeType {
  return typeof v === 'string' && (SCOPE_TYPES as readonly string[]).includes(v)
}

/** objektum-azonosito -> a projektjei (csak letezo projektek). `ids`: csak ezekre
 *  (a jovahagyasnal es az uzenetnel kotelezo -- azokat a felulet adja at). */
export function projectScopeMap(type: ScopeType, ids: string[] | null, resolveRefs: (text: string) => { cardId: string }[]): Record<string, string[]> {
  ensureProjectTables()
  const db = getDb()
  const out: Record<string, string[]> = {}
  if (type === 'memory' || type === 'schedule' || type === 'skill') {
    const rows = db.prepare(
      `SELECT l.object_id AS id, l.project_id AS project FROM project_links l
         JOIN projects p ON p.id = l.project_id WHERE l.object_type = ?`,
    ).all(type) as { id: string; project: string }[]
    const want = ids ? new Set(ids) : null
    for (const r of rows) if (!want || want.has(r.id)) out[r.id] = [r.project]
    return out
  }
  if (!ids || !ids.length || !hasTable('kanban_cards')) return out
  const cardProject = db.prepare('SELECT k.project AS project FROM kanban_cards k JOIN projects p ON p.id = k.project WHERE k.id = ?')
  if (type === 'approval') {
    if (!hasTable('approvals')) return out
    const q = db.prepare(
      `SELECT CASE WHEN json_valid(action_payload) THEN json_extract(action_payload, '$.kanban_card_id') END AS card_id
         FROM approvals WHERE id = ?`,
    )
    for (const id of ids) {
      const r = q.get(id) as { card_id: string | null } | undefined
      const pr = r?.card_id ? (cardProject.get(r.card_id) as { project: string } | undefined) : undefined
      if (pr) out[id] = [pr.project]
    }
    return out
  }
  if (!hasTable('agent_messages')) return out
  const q = db.prepare('SELECT content FROM agent_messages WHERE id = ?')
  for (const id of ids) {
    const r = q.get(Number(id)) as { content: string } | undefined
    if (!r) continue
    const projects = new Set<string>()
    for (const ref of resolveRefs(r.content || '')) {
      const pr = cardProject.get(ref.cardId) as { project: string } | undefined
      if (pr) projects.add(pr.project)
    }
    if (projects.size) out[id] = [...projects]
  }
  return out
}
