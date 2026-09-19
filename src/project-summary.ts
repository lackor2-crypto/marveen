/**
 * A PROJEKT OSSZEFOGLALOJA -- CSAK KEZI KERESRE (kanban #321, spec 9. pont).
 *
 * Nem generalodik megnyitaskor: a felhasznalo megnyomja a gombot, a valasz a
 * projekthez mentodik, a keszites idejevel es azzal, hogy MI keszitette. Egy
 * elavult osszefoglalo rosszabb a hianyzonal -- ezert a felulet mindig kiirja,
 * mikor keszult.
 *
 * A modell CSAK a projekt mert adatait kapja (a kartyak, allapotok, fuggo
 * jovahagyasok, legutobbi esemenyek -- ugyanaz, amit az Attekintes mutat), es
 * a rendszer-uzenet tiltja a kitalalast. A lanc ugyanaz, mint a Beerkezonel:
 * a sajat Claude-elofizetes, aztan a gepen futo helyi modell, fizetos API soha.
 */
import { askAiJson } from './life-inbox-ai.js'
import { buildProjectOverview, type ProjectOverview } from './project-overview.js'
import { getProject, setProjectSummary, type ProjectRow } from './projects.js'

const MAX_SUMMARY_CHARS = 2000

const SYSTEM = `You write a short status summary of ONE work project for its owner.
Use ONLY the facts given in the prompt. Never invent tasks, people, dates, risks or progress that are not in the facts.
Say what is in progress now, what waits for the owner's approval, what comes next, and -- only if the facts show it -- what is overdue or has not moved for a long time.
4 to 7 short sentences, plain text, no lists, no headings, in the requested language.
Answer with ONLY a JSON object: {"summary":"..."}. No prose around it, no code fence.`

function line(label: string, value: string | null | undefined): string {
  return value ? `${label}: ${value}` : ''
}

/** A nap a GEP helyi idejeben (a tulajdonos ideje), nem UTC-ben: ejfel utan
 *  a "ma" kulonben meg a tegnapi datum volna. */
function isoDay(ms: number | null | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** A modellnek atadott tenyek -- a mert Attekintesbol, szovegkent. Exportalva
 *  a teszt miatt: itt latszik, hogy semmi nem kerul bele, ami nincs meg. */
export function summaryFacts(p: ProjectRow, ov: ProjectOverview, lang: 'hu' | 'en', now = Date.now()): string {
  const L: string[] = []
  L.push(`Answer language: ${lang === 'en' ? 'English' : 'Hungarian'}`)
  L.push(`Today: ${isoDay(now)}`)
  L.push(`Project: ${p.name}`)
  L.push(line('Description', p.description))
  L.push(line('For (client)', p.client))
  L.push(`Project status: ${p.status}${p.archived_at ? ' (archived)' : ''}`)
  const f = ov.facts
  L.push(`Counts: open cards ${f.openCards}, in progress ${f.inProgress}, waiting ${f.waiting}, pending approvals ${f.pendingApprovals}, overdue ${f.overdue}, untouched for 14+ days ${f.staleOpenCards}`)
  L.push('')
  L.push('Open cards (ordered by priority, due date, status):')
  if (!ov.nextSteps.length) L.push('- none')
  for (const c of ov.nextSteps) {
    const bits = [`status ${c.status}`, `priority ${c.priority}`]
    if (c.dueAt) bits.push(`due ${isoDay(c.dueAt)}${c.dueAt < now ? ' (OVERDUE)' : ''}`)
    if (c.assignee) bits.push(`owner ${c.assignee}`)
    bits.push(`last change ${isoDay(c.updatedAt)}`)
    L.push(`- "${c.title}" (${bits.join(', ')})`)
  }
  if (ov.nextStepsTotal > ov.nextSteps.length) L.push(`- ... and ${ov.nextStepsTotal - ov.nextSteps.length} more open cards`)
  L.push('')
  L.push('Work measured as running right now:')
  const running = ov.currentWork.filter((w) => w.claims.length || w.codeTasks.length)
  if (!running.length) L.push('- none (no agent claim, no running code task)')
  for (const w of running) {
    const who = w.claims.map((c) => c.holder).join(', ')
    const code = w.codeTasks.map((t) => `code task ${t.status}`).join(', ')
    L.push(`- ${w.card ? `"${w.card.title}"` : 'code task without a card'}: ${[who && `worked on by ${who}`, code].filter(Boolean).join('; ')}`)
  }
  L.push('')
  L.push('Waiting for the owner\'s approval:')
  if (!ov.approvals.length) L.push('- none')
  for (const a of ov.approvals) L.push(`- "${a.cardTitle}" (requested ${isoDay(a.requestedAt)})`)
  L.push('')
  L.push('Recent events (newest first):')
  if (!ov.activity.length) L.push('- none')
  for (const a of ov.activity.slice(0, 15)) {
    const what = a.kind === 'status' ? `card "${a.cardTitle ?? ''}" moved ${a.from ?? 'new'} -> ${a.to}`
      : a.kind === 'comment' ? `comment on "${a.cardTitle ?? ''}"${a.text ? `: ${a.text.slice(0, 120)}` : ''}`
      : a.kind === 'approval' ? `approval for "${a.cardTitle ?? ''}": ${a.to}`
      : a.kind === 'idea' ? `idea "${a.name ?? ''}": ${a.to}`
      : a.kind === 'code' ? `code task ${a.to}${a.cardTitle ? ` for "${a.cardTitle}"` : ''}`
      : a.kind === 'card_created' ? `new card "${a.cardTitle ?? ''}"`
      : a.kind === 'idea_created' ? `new idea "${a.name ?? ''}"`
      : `file changed: ${a.name ?? ''}`
    L.push(`- ${isoDay(a.at)} ${what}`)
  }
  return L.filter((x, i, arr) => x !== '' || arr[i - 1] !== '').join('\n')
}

export type SummaryOutcome =
  | { ok: true; project: ProjectRow; engine: 'claude' | 'ollama'; model: string }
  | { ok: false; code: 'not_found' | 'no_ai' | 'no_answer' | 'busy' }

/** Egy projektre egyszerre egy keszites fut: egy dupla kattintas ne inditson
 *  ket (percekig tarto, keretet fogyaszto) AI-hivast. */
const running = new Set<string>()

export function isSummaryRunning(id: string): boolean {
  return running.has(id)
}

export async function summarizeProject(id: string, lang: 'hu' | 'en'): Promise<SummaryOutcome> {
  const p = getProject(id)
  if (!p || p.id !== id) return { ok: false, code: 'not_found' }
  if (running.has(id)) return { ok: false, code: 'busy' }
  const ov = buildProjectOverview(id)
  if (!ov) return { ok: false, code: 'not_found' }
  running.add(id)
  try {
    const ask = await askAiJson(SYSTEM, summaryFacts(p, ov, lang), (j) => {
      const s = j && typeof j.summary === 'string' ? j.summary.replace(/\s+/g, ' ').trim() : ''
      return s ? s.slice(0, MAX_SUMMARY_CHARS) : null
    })
    if (ask.engine === 'none' || !ask.value) return { ok: false, code: ask.reason === 'no_ai' ? 'no_ai' : 'no_answer' }
    // A projektet kozben torolhettek: akkor nincs hova menteni.
    if (!setProjectSummary(id, ask.value, `${ask.engine}:${ask.model}`)) return { ok: false, code: 'not_found' }
    return { ok: true, project: getProject(id)!, engine: ask.engine, model: ask.model }
  } finally {
    running.delete(id)
  }
}
