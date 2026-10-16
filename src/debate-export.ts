// The debate as a report (#597, phase 6): the question, the settings, the result and the objection board in one
// readable document, so the trace of a decision stays after the panel is closed.
//
// Pure (no I/O): the same report becomes a Markdown download and the sections of a document work item
// (debate-export-doc.ts). A debate that is not closed yet still exports -- it says so instead of showing a result.

import type { DebateSessionState } from './debate-run.js'
import type { BoardItem } from './debate-board.js'

export type ReportLang = 'hu' | 'en'

export interface ReportSection { title: string; paragraphs: string[] }
export interface DebateReport { title: string; sections: ReportSection[] }

const tr = (l: ReportLang, hu: string, en: string): string => (l === 'en' ? en : hu)

const MODE_NAMES: Record<string, [string, string]> = {
  peer: ['Egyenrangú', 'Equal peers'],
  critic: ['Kötekedő és védő', 'Critic and defender'],
  assumptions: ['Feltevés-ellenőrzés', 'Assumption check'],
  premortem: ['Pre-mortem (mi mehet félre)', 'Pre-mortem (what could go wrong)'],
  triad: ['Háromoldalú (két kötekedő, egy védő)', 'Three-sided (two critics, one defender)'],
}
const KINDS: Record<string, [string, string]> = {
  accuracy: ['pontosság', 'accuracy'], wording: ['szóhasználat', 'wording'], missing: ['hiányzó rész', 'missing part'],
  legal: ['jogi kockázat', 'legal risk'], assumption: ['feltevés', 'assumption'], risk: ['kockázat', 'risk'],
}
const STATUSES: Record<string, [string, string]> = {
  accepted: ['elfogadva', 'accepted'], partial: ['részben elfogadva', 'partly accepted'], rejected: ['elutasítva (vita tárgya)', 'rejected (disputed)'],
  withdrawn: ['visszavonva (a kötekedő elengedte)', 'withdrawn (the critic let go)'], open: ['nyitott', 'open'],
}
const VERDICTS: Record<string, [string, string]> = {
  accept: ['elfogadja', 'accepts'], partial: ['részben elfogadja', 'partly accepts'], reject: ['elutasítja', 'rejects'],
}
const STRENGTH_NAMES: Record<string, [string, string]> = { mild: ['Enyhe', 'Mild'], medium: ['Közepes', 'Medium'], hard: ['Kemény', 'Hard'] }

function pick(map: Record<string, [string, string]>, key: string | null | undefined, l: ReportLang): string {
  if (!key) return ''
  const v = map[key]
  return v ? (l === 'en' ? v[1] : v[0]) : key
}

function modelShort(id: string): string {
  return String(id || '').replace(/^[^/]+\//, '')
}

/** Text -> paragraphs: blank lines separate them, single line breaks inside one stay. Empty text gives none. */
export function paragraphsOf(text: string | null | undefined): string[] {
  return String(text ?? '').replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
}

function modeName(s: DebateSessionState, l: ReportLang): string {
  return s.modeName ?? pick(MODE_NAMES, s.mode, l) ?? s.mode
}

function boardParagraphs(item: BoardItem, l: ReportLang): string[] {
  const kind = pick(KINDS, item.kind, l)
  const by = item.by === 'critic2' ? tr(l, ' – a 2. kötekedő (ellenfél szemszöge) szerint', ' – by critic 2 (opposing side’s view)') : ''
  const out = [`${item.id}${kind ? ` [${kind}]` : ''} – ${pick(STATUSES, item.status, l)}${by}`]
  if (item.quote) out.push(`${tr(l, 'Idézet', 'Quote')}: „${item.quote}”`)
  if (item.text) out.push(`${tr(l, 'Kifogás', 'Objection')}: ${item.text}`)
  const last = item.steps[item.steps.length - 1]
  if (last) {
    const v = pick(VERDICTS, last.verdict, l) || tr(l, 'nem egyértelmű', 'unclear')
    out.push(`${tr(l, 'A védő válasza', 'The defender’s answer')} (${tr(l, `${last.round}. kör`, `round ${last.round}`)}): ${v}${last.reason ? ` – ${last.reason}` : ''}`)
  }
  if (item.rewrite) out.push(`${tr(l, 'Javasolt új szöveg', 'Proposed new wording')}: ${item.rewrite}`)
  return out
}

/** The title of a debate's report document; the legacy relocation (debate-export-doc.ts) rebuilds it to match old reports. */
export function reportTitle(question: string, l: ReportLang): string {
  const q = question.replace(/\s+/g, ' ').trim()
  return `${tr(l, 'Vitáztatás jelentés', 'Debate report')}: ${q.length > 70 ? q.slice(0, 67).trimEnd() + '…' : q}`
}

/**
 * The report of one debate. `full` adds the whole course of it (every answer of every round) after the result:
 * long, so it is opt-in; the default is the decision trace -- question, settings, result, objection board.
 */
export function buildReport(s: DebateSessionState, l: ReportLang, opts: { full?: boolean } = {}): DebateReport {
  const title = reportTitle(s.question, l)
  const sections: ReportSection[] = []

  sections.push({ title: tr(l, 'Kérdés vagy feladat', 'Question or task'), paragraphs: [...paragraphsOf(s.question), ...(s.attachments.length ? [`${tr(l, 'Segédanyag', 'Material')}: ${s.attachments.map(a => a.name).join(', ')}`] : [])] })

  const settings = [`${tr(l, 'Mód', 'Mode')}: ${modeName(s, l)}`]
  // A critic / defender debate: its answers carry roles (a peer debate's do not).
  const roleMode = s.rounds.some(r => r.responses.some(x => !!x.role))
  const triad = roleMode && s.models.length === 3
  s.models.forEach((m, i) => {
    const role = !roleMode ? ''
      : triad ? [tr(l, ' (1. kötekedő: szerkesztői szemszög)', ' (critic 1: editor’s view)'), tr(l, ' (2. kötekedő: ellenfél szemszöge)', ' (critic 2: opposing side’s view)'), tr(l, ' (védő)', ' (defender)')][i] ?? ''
      : (i === 0 ? tr(l, ' (kötekedő)', ' (critic)') : tr(l, ' (védő)', ' (defender)'))
    settings.push(`${tr(l, `${i + 1}. modell`, `Model ${i + 1}`)}: ${m}${role}`)
  })
  if (roleMode) {
    settings.push(`${tr(l, 'Kötekedés erőssége', 'Critic strength')}: ${pick(STRENGTH_NAMES, s.strength, l)}`)
    if (!triad) settings.push(`${tr(l, 'Szerepcsere a 2. körben', 'Role swap in round 2')}: ${s.swapRoles ? tr(l, 'igen', 'yes') : tr(l, 'nem', 'no')}`)
  }
  if (s.judge) settings.push(`${tr(l, 'Bíró modell', 'Judge model')}: ${s.judge}`)
  settings.push(`${tr(l, 'Körök száma', 'Rounds')}: ${s.rounds.length}`)
  sections.push({ title: tr(l, 'A vita beállításai', 'Debate settings'), paragraphs: settings })

  if (s.concluded) {
    const head = s.consensus ? tr(l, 'Egyetértésre jutottak.', 'They reached agreement.') : tr(l, 'Nem jutottak teljes egyetértésre.', 'They did not fully agree.')
    const result = [head]
    if (s.summaryBy) result.push(tr(l, `Az összefoglalót ez a modell írta: ${modelShort(s.summaryBy)}.`, `The summary was written by: ${modelShort(s.summaryBy)}.`))
    const o = s.orderCheck
    if (o) {
      if (o.agree) result.push(tr(l, 'Ellenőrzés: a modell a vitát két sorrendben is megkapta, és mindkétszer ugyanarra jutott.', 'Check: the model was given the debate in two orders and reached the same result both times.'))
      else {
        const only = [...o.onlyFirst, ...o.onlySecond]
        result.push(tr(l, 'Figyelem: a két olvasat nem egyezik, ezért a teljes egyetértést nem jelöltük meg.', 'Note: the two readings do not match, so full agreement was not marked.')
          + (only.length ? ` ${tr(l, 'Csak az egyik olvasat szerint áll meg', 'Stands in only one of the readings')}: ${only.join(', ')}.` : ''))
      }
    }
    sections.push({ title: tr(l, 'Eredmény', 'Result'), paragraphs: [...result, ...paragraphsOf(s.summary)] })
  } else {
    sections.push({ title: tr(l, 'Eredmény', 'Result'), paragraphs: [tr(l, 'A vita még nincs lezárva, ezért nincs végeredmény.', 'The debate is not closed yet, so there is no final result.')] })
  }

  if (s.board.length) {
    const sum = s.boardSummary
    const lead = sum
      ? tr(l, `Összesen ${sum.total} kifogás: ${sum.accepted} elfogadva, ${sum.partial} részben, ${sum.rejected} elutasítva, ${sum.withdrawn} visszavonva, ${sum.open} nyitott.`,
        `${sum.total} objections in all: ${sum.accepted} accepted, ${sum.partial} partly, ${sum.rejected} rejected, ${sum.withdrawn} withdrawn, ${sum.open} open.`)
      : ''
    sections.push({ title: tr(l, 'Kifogás-tábla', 'Objection board'), paragraphs: [...(lead ? [lead] : []), ...s.board.flatMap(it => boardParagraphs(it, l))] })
  }

  if (opts.full) {
    for (const r of s.rounds) {
      const paras: string[] = []
      if (r.round > 1 && r.prompt.trim()) paras.push(`${tr(l, 'Megjegyzésed a körhöz', 'Your note for the round')}: ${r.prompt.trim()}`)
      for (const x of r.responses) {
        const role = x.role === 'critic' ? tr(l, ' (kötekedő)', ' (critic)') : x.role === 'critic2' ? tr(l, ' (2. kötekedő)', ' (critic 2)') : x.role === 'defender' ? tr(l, ' (védő)', ' (defender)') : ''
        paras.push(`${modelShort(x.model)}${role}`)
        if (x.ok) paras.push(...paragraphsOf(x.text))
        else paras.push(tr(l, `Ez a modell nem válaszolt: ${x.error ?? ''}`, `This model did not answer: ${x.error ?? ''}`))
      }
      sections.push({ title: tr(l, `${r.round}. kör`, `Round ${r.round}`), paragraphs: paras })
    }
  }
  return { title, sections }
}

/** The report as Markdown (the download). */
export function reportMarkdown(r: DebateReport): string {
  const out = [`# ${r.title}`, '']
  for (const s of r.sections) {
    out.push(`## ${s.title}`, '')
    for (const p of s.paragraphs) out.push(p, '')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** A file name for the download: the question's first words, no characters a file system or a header dislikes. */
export function reportFileName(s: Pick<DebateSessionState, 'question'>, ext: string): string {
  const slug = s.question.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  // Cut at a word end when there is one in the second half of the allowed length, so the name does not stop mid-word.
  const cut = slug.slice(0, 40)
  const at = slug.length > 40 ? cut.lastIndexOf('-') : -1
  const base = (at > 20 ? cut.slice(0, at) : cut).replace(/-+$/g, '')
  return `${base || 'vita'}-vita.${ext}`
}
