/**
 * "FOLYTASSUK A PROJEKTET" -- a projekt teljes, agensnek szolo kontextusa
 * (kanban #321, spec 24. pont; 3. fazis).
 *
 * Amikor a tulajdonos Telegramon azt irja, hogy "Folytassuk a Kovacs weboldal
 * projektet", az agens EGY hivassal megkapja, amit a folytatashoz tudnia kell:
 * a mentett osszefoglalot (a keszitesi idejevel), a nyitott kartyakat, a fuggo
 * jovahagyasokat, az eppen futo munkat, a legutobbi esemenyeket, es a projekthez
 * KIFEJEZETTEN kotott otleteket, memoriakat, vitaztatasokat. Minden sor mert
 * adatbol jon (ugyanabbol, amit az Attekintes mutat) -- semmi nem generalodik.
 *
 * A projekt megtalalasa a tulajdonos szavaibol: azonosito, rovid nev, pontos
 * nev, vagy (ha EGYERTELMU) egy nev-reszlet ekezettol es kis-/nagybetutol
 * fuggetlenul. Tobb talalatnal NEM valasztunk: a hivo visszakerdez.
 *
 * A vitaztatasok nem adatbazisban, hanem a `store/debate-log.jsonl`-ben elnek
 * (lasd `web/routes/debate.ts`); itt csak olvassuk, soronkent turelmesen.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { getDb } from './db.js'
import { buildProjectOverview, type ProjectOverview } from './project-overview.js'
import { summaryFacts } from './project-summary.js'
import { debateProject } from './project-scope.js'
import {
  ensureProjectTables, getProject, hasTable, listProjectIdeas, listProjectLinks, nameKey, type ProjectRow,
} from './projects.js'

// ---- projekt keresese a tulajdonos szavaibol ----------------------------------

/** Osszehasonlitasi kulcs: ekezet, kis-/nagybetu, irasjelek nelkul. */
export function looseKey(v: unknown): string {
  return nameKey(v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

export type ProjectLookup =
  | { kind: 'found'; project: ProjectRow }
  | { kind: 'ambiguous'; matches: ProjectRow[] }
  | { kind: 'none'; projects: ProjectRow[] }

/**
 * A projekt a megadott szovegbol. Sorrend: azonosito / rovid nev / pontos nev
 * (ekezettol fuggetlenul is), aztan a nev-reszlet. Az archivalt projekt csak
 * pontos egyezesre jon -- egy reszlet ne egy regi, lezart munkat hozzon elo.
 */
export function findProject(query: unknown): ProjectLookup {
  ensureProjectTables()
  const all = getDb().prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as ProjectRow[]
  const q = String(query ?? '').trim()
  const live = all.filter((p) => !p.archived_at)
  if (!q) return { kind: 'none', projects: live }
  const direct = getProject(q)
  if (direct) return { kind: 'found', project: direct }
  const k = looseKey(q)
  if (!k) return { kind: 'none', projects: live }
  const exact = all.filter((p) => looseKey(p.name) === k || looseKey(p.slug) === k)
  if (exact.length === 1) return { kind: 'found', project: exact[0] }
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact }
  const partial = live.filter((p) => {
    const n = looseKey(p.name)
    return n.includes(k) || (k.length >= 4 && k.includes(n))
  })
  if (partial.length === 1) return { kind: 'found', project: partial[0] }
  if (partial.length > 1) return { kind: 'ambiguous', matches: partial }
  return { kind: 'none', projects: live }
}

// ---- a projekthez kotott memoriak es vitaztatasok --------------------------------

export interface LinkedMemory { id: string; content: string; category: string | null; createdAt: number; exists: boolean }

/** A projekthez kotott memoriak. Egy kozben torolt memoria is latszik
 *  (`exists: false`), hogy a kotes bonthato legyen -- nem tunik el szo nelkul. */
export function linkedMemories(projectId: string): LinkedMemory[] {
  const links = listProjectLinks(projectId, 'memory')
  if (!links.length) return []
  const rows = new Map<string, { content: string; category: string | null; created_at: number }>()
  if (hasTable('memories')) {
    const ids = links.map((l) => Number(l.object_id)).filter((n) => Number.isFinite(n))
    if (ids.length) {
      for (const r of getDb().prepare(
        `SELECT id, content, category, created_at FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).all(...ids) as { id: number; content: string; category: string | null; created_at: number }[]) {
        rows.set(String(r.id), r)
      }
    }
  }
  return links.map((l) => {
    const r = rows.get(l.object_id)
    return r
      ? { id: l.object_id, content: r.content, category: r.category, createdAt: r.created_at * 1000, exists: true }
      : { id: l.object_id, content: '', category: null, createdAt: l.created_at * 1000, exists: false }
  })
}

export interface DebateSummary { id: string; question: string; startedAt: number; lastAt: number; concluded: boolean; consensus: boolean | null; summary: string | null; exists: boolean; loggedProject?: string | null }

let debateLogPath: string | null = null
/** Csak teszthez: a vitaztatas-naplo helye. `null` = a valodi. */
export function setDebateLogPathForTests(p: string | null): void { debateLogPath = p }

/** A vitaztatas-naplo munkamenetei (a legfrissebb elol). Hibas sor nem akaszt meg. */
export function listDebateSessions(): DebateSummary[] {
  const path = debateLogPath ?? join(STORE_DIR, 'debate-log.jsonl')
  if (!existsSync(path)) return []
  const by = new Map<string, DebateSummary>()
  let raw = ''
  try { raw = readFileSync(path, 'utf-8') } catch { return [] }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e.session !== 'string') continue
    const s: DebateSummary = by.get(e.session) ?? { id: e.session, question: '', startedAt: e.ts || 0, lastAt: 0, concluded: false, consensus: null, summary: null, exists: true }
    const ts = Number(e.ts) || 0
    if (ts && (!s.startedAt || ts < s.startedAt)) s.startedAt = ts
    if (ts > s.lastAt) s.lastAt = ts
    if (e.type === 'round' && e.round === 1 && !s.question && typeof e.prompt === 'string') s.question = e.prompt.slice(0, 300)
    if (e.type === 'round' && !s.loggedProject && typeof e.project === 'string') s.loggedProject = e.project
    if (e.type === 'conclude') { s.concluded = true; s.consensus = !!e.consensus; s.summary = typeof e.summary === 'string' ? e.summary : null }
    by.set(e.session, s)
  }
  return [...by.values()].sort((a, b) => b.lastAt - a.lastAt)
}

/** A projekt vitaztatasai: a kifejezetten kotottek, es amiket a projektbol
 *  inditottak (`debate.mjs ask --project`) -- lasd `debateProject`. */
export function linkedDebates(projectId: string): DebateSummary[] {
  const links = listProjectLinks(projectId, 'debate')
  const sessions = listDebateSessions()
  const all = new Map(sessions.map((d) => [d.id, d]))
  const out = links.map((l) => all.get(l.object_id)
    ?? { id: l.object_id, question: '', startedAt: 0, lastAt: 0, concluded: false, consensus: null, summary: null, exists: false })
  const seen = new Set(out.map((d) => d.id))
  for (const d of sessions) {
    if (!seen.has(d.id) && d.loggedProject && debateProject(d.id, d.loggedProject) === projectId) out.push(d)
  }
  return out
}

// ---- az agensnek szolo szoveg ----------------------------------------------------

function day(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * A projekt kontextusa egy agensnek, egyszeru szovegkent. A tenyek resze
 * ugyanaz, amit az osszefoglalo-keszito modell is kap (`summaryFacts`) -- igy a
 * ket hely nem csuszhat el egymastol.
 */
export function projectContextText(p: ProjectRow, ov: ProjectOverview, lang: 'hu' | 'en', now = Date.now()): string {
  const L: string[] = []
  L.push(`# Project "${p.name}" (id ${p.id}, short name ${p.slug})`)
  L.push(`Folder in the Depot: ${p.folder_path ?? '(none set)'}${ov.folder.state !== 'ok' && p.folder_path ? ` -- state: ${ov.folder.state}` : ''}`)
  if (p.summary) {
    const latest = ov.activity[0]?.at ?? 0
    const stale = p.summary_at && latest > p.summary_at * 1000 ? ' -- things happened since, it may be out of date' : ''
    L.push('')
    L.push(`Saved summary (made ${day((p.summary_at ?? 0) * 1000)} by ${p.summary_by ?? '?'}${stale}):`)
    L.push(p.summary)
  } else {
    L.push('Saved summary: none yet (it is made only on request, on the project page).')
  }
  L.push('')
  L.push(summaryFacts(p, ov, lang, now).split('\n').filter((x) => !x.startsWith('Answer language:')).join('\n'))
  const ideas = listProjectIdeas(p.id).filter((i) => i.status !== 'rejected')
  L.push('')
  L.push('Ideas of the project:')
  if (!ideas.length) L.push('- none')
  for (const i of ideas.slice(0, 20)) L.push(`- "${i.title}" (${i.status}${i.kanban_id ? `, card ${i.kanban_id}` : ''})`)
  const mems = linkedMemories(p.id).filter((m) => m.exists)
  L.push('')
  L.push('Memories linked to the project:')
  if (!mems.length) L.push('- none')
  for (const m of mems.slice(0, 20)) L.push(`- #${m.id}: ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`)
  const debates = linkedDebates(p.id).filter((d) => d.exists)
  L.push('')
  L.push('Debates linked to the project:')
  if (!debates.length) L.push('- none')
  for (const d of debates.slice(0, 10)) {
    const verdict = d.concluded ? (d.consensus ? 'consensus' : 'no consensus') : 'not concluded'
    L.push(`- ${d.id}: "${d.question.replace(/\s+/g, ' ').slice(0, 200)}" (${verdict})${d.summary ? ` -- ${d.summary.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`)
  }
  if (ov.codeAliases.length) {
    L.push('')
    L.push(`Code bridge (VS Code) sessions of the project: ${ov.codeAliases.join(', ')}`)
  }
  return L.join('\n')
}

export function projectContext(id: string, lang: 'hu' | 'en'): { project: ProjectRow; text: string } | null {
  const p = getProject(id)
  if (!p || p.id !== id) return null
  const ov = buildProjectOverview(id)
  if (!ov) return null
  return { project: p, text: projectContextText(p, ov, lang) }
}
