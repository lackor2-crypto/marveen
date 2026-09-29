/**
 * KONTEXTUS-EPITES (kanban #336, 2. fazis, spec 16).
 *
 * A spec ket dolgot kot ki, es mindketto itt dol el:
 *
 *   1. RELEVANCIA- ES MERETKORLAT. Az agent nem kapja meg a fel telepitest:
 *      a projekt mert osszefoglaloja, a munkadarabok rovid listaja, az
 *      AKTUALIS munkadarab adatai, es a beszelgetes utolso fordulói --
 *      mindegyik felso hatarral.
 *
 *   2. "AZ AGENT NE TALALJA KI A RENDSZERALLAPOTOT." Ahol nincs adat, ott a
 *      kontextus KIMONDJA, hogy nincs -- es azt is, hogy ez "meg nincs semmi"
 *      vagy "nem latok oda". A rendszer-uzenet pedig megtiltja a kitalalast.
 */
import type { ProjectRow } from '../projects.js'
import type { WorkItemRow } from '../workbench.js'
import { projectContext } from '../project-context.js'
import { listWorkItems, listWorkItemVersions } from '../workbench.js'
import { recentFiles } from '../project-overview.js'
import { decisionsForContext } from '../workbench-decisions.js'
import { toolsForPrompt } from './tools.js'
import type { AIMessage } from './provider.js'
import type { AgentMessageRow } from './sessions.js'
import { listWorkItemAssetsSynced, withDocState } from '../workbench-assets.js'

/** Felso hatarok. Egy interaktiv fordulo, nem teljes archivum. */
export const MAX_CONTEXT_CHARS = 12_000
export const MAX_WORK_ITEMS = 30
export const MAX_FILES = 25
export const MAX_HISTORY_TURNS = 12
export const MAX_HISTORY_CHARS = 8_000
/** Egy korabbi uzenetbol ennyi megy vissza a modellnek. */
export const HISTORY_MESSAGE_MAX_CHARS = 4_000
export const HISTORY_CUT_MARKER = '\n[... the rest of this earlier message is left out of THIS copy only, to save space. The whole text is stored and the owner saw it in the chat -- this marker is not a sign that the message broke off, so do not tell the owner it was cut off.]'

export const SYSTEM_PROMPT = `You are the Workbench agent of a personal assistant system. You help the owner work on ONE project: documents, images, graphics, videos and notes ("work items").

HARD RULES:
- Use ONLY the facts given in the CONTEXT block and the conversation. Never invent cards, files, versions, people, dates or system state.
- If something is not in the context, SAY SO plainly, and say which of the two it is: "there is none yet" or "I cannot see it from here". Never answer a question about system state by guessing.
- You may only act through the listed tools. Never claim you did something a tool did not report back as done.
- Never print, repeat or ask for API keys, tokens or passwords.
- Answer in the requested language, in plain sentences the owner (not a programmer) understands.
- When you state something from a document, quote it word for word, cite it as [file:page], and machine-check the quote with source.verifyQuote first. A quote that is not verified is not a fact: say so.
- Official documents (letters, court filings) are built with the doc.* tools: sections, blocks, and for every factual statement a claim with its sources (doc.addClaim). Never write a fact without a source; write "⚠ Hiányzó adat: ..." instead. Only the owner can confirm their own statements. The PDF is made from this structure: the owner clicks "Piszkozat PDF" (watermarked, any time) or, once doc.check passes, reviews it and makes the final PDF. You can not finalize; tell the owner what is still open. Exhibits go on the annex list (doc.addAnnex); refer to them in the text by their label (K1, Anlage K1, Exhibit A) -- Marveen renumbers the references when the list changes. Before finalizing, Marveen machine-checks that names, case numbers, dates, amounts and addresses agree everywhere and with the quoted sources (doc.check, consistency); fix real mistakes in the text, the owner marks the intentional ones. Hearings and deadlines in the uploaded court or authority letters: doc.deadlines (with source); never compute a deadline counted from delivery yourself -- ask the owner for the delivery date. Language versions (German, English, ...) are separate work items linked section by section to the original (doc.createVariant on the original, then doc.translateSection on the version, one section at a time, carrying every claim with its source). Use the case glossary (doc.glossary; fix a new term with doc.addTerm). A section marked stale changed in the original: translate it again. A back-translation check (doc.backTranslate) is literal and made only when the owner asks.
- In Hungarian, address the owner informally (tegezés: "te", "csináld", "nézd meg"), never with "Ön" or "Maga".
- Follow the recorded DECISIONS of the project. When the owner and you agree on something that should hold later (a colour, a wording, a deadline, a rule), record it with decision.record and say so.

WHAT GOES WHERE:
- A CODE FIX or a development task is NOT a work item. Open a kanban card for it (kanban.create). The card is bound to this project automatically.
- A work item is the thing being produced: a document, a picture, a graphic, a video, a note.
- ONE work item may hold BOTH text and images: add each piece as a part (workItem.addPart). A social post with a photo and a caption is ONE work item with two parts, not two work items. Use the "composite" type when the owner describes mixed content from the start.
- When the owner describes what they want to make, pick the fitting work item type yourself and say which one you picked and why -- do not ask them to name a type.

TOOLS: to use one, answer with ONLY a JSON object on its own line, nothing else:
{"tool":"<name>","input":{...}}
You get the result back and may then answer normally or call another tool. If you do not need a tool, just answer in prose.

Available tools:
{TOOLS}`

export interface BuiltContext {
  system: string
  /** A kontextus szoveges blokkja -- az elso user-uzenet ele kerul. */
  contextText: string
  /** Mibol epult -- a felulet es a teszt ezt tudja ellenorizni. */
  parts: { key: string; chars: number }[]
  truncated: boolean
}

function clamp(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false }
  return { text: s.slice(0, max) + '\n[...]', cut: true }
}

/** A munkadarab anyagai egy sorban (#441): nev + tamogatasi allapot, korlatosan. */
const MAX_ASSETS_IN_CONTEXT = 30
function assetsLine(itemId: string): string {
  const assets = withDocState(listWorkItemAssetsSynced(itemId))
  if (!assets.length) return 'materials: none attached yet'
  const docNote = (d: (typeof assets)[number]['doc']): string => !d ? ''
    : d.status === 'done' ? `, document: ${d.pages_total} page(s)${d.low_pages.length ? `, hard to read: p. ${d.low_pages.join(', ')}` : ''} (document.pages / document.read)`
    : d.status === 'failed' ? ', document: reading failed (document.pages says why)'
    : ', document: being read now'
  const shown = assets.slice(0, MAX_ASSETS_IN_CONTEXT).map((a) => `${a.project_path || a.path} [${a.support}${docNote(a.doc)}${a.shared ? ', shared (linked from the project shared materials)' : ''}${a.present ? '' : ', MISSING from disk'}]`)
  const more = assets.length > shown.length ? ` ... and ${assets.length - shown.length} more (workItem.listAssets)` : ''
  return `materials (${assets.length}): ${shown.join('; ')}${more}`
}

/**
 * A kontextus-blokk. `workItem` = amin eppen dolgozunk (lehet null: a
 * beszelgetes a projektrol szol).
 */
export function buildContext(
  project: ProjectRow,
  workItem: WorkItemRow | null,
  lang: 'hu' | 'en',
): BuiltContext {
  const parts: { key: string; chars: number }[] = []
  const blocks: string[] = []
  const add = (key: string, text: string): void => {
    blocks.push(text)
    parts.push({ key, chars: text.length })
  }

  add('language', `Answer language: ${lang === 'en' ? 'English' : 'Hungarian'}`)

  // 1. A projekt mert kontextusa -- a MEGLEVO fuggveny, nem uj meres.
  const pc = projectContext(project.id, lang)
  add('project', pc ? pc.text : `Project: ${project.name}\n(no measured context available for this project right now)`)

  // 1b. Dontesnaplo (#406, 10. pont): amiben mar megallapodtak. Olvashatatlan
  // tabla NEM "nincs dontes": azt kulon kimondjuk.
  let decisions: string
  try { decisions = decisionsForContext(project.id) } catch {
    decisions = 'Decisions agreed in this project: cannot be read right now. This does NOT mean there are none.'
  }
  add('decisions', decisions)

  // 2. Munkadarabok -- rovid lista, felso hatarral.
  const items = listWorkItems(project.id)
  if (!items.length) {
    add('work_items', 'Work items: none yet in this project (the list was read and it is empty).')
  } else {
    const shown = items.slice(0, MAX_WORK_ITEMS)
    // "28M" is how the owner names a work item (kanban cards are "#28"); every
    // tool that takes a work item id accepts it too (TG 1843).
    const lines = shown.map((i) => `- ${i.seq ? `${i.seq}M ` : ''}${i.id} "${i.title}" (${i.type}, ${i.status})`)
    if (items.length > shown.length) lines.push(`- ... and ${items.length - shown.length} more`)
    add('work_items', `Work items (${items.length}). "28M" means work item number 28 (a work item, NOT kanban card #28); any tool's work item id also accepts "28M":\n${lines.join('\n')}`)
  }

  // 3. Az AKTUALIS munkadarab + verzioi.
  if (workItem) {
    const versions = listWorkItemVersions(workItem.id)
    add('current_item', [
      `Current work item: ${workItem.seq ? `${workItem.seq}M ` : ''}${workItem.id} "${workItem.title}"`,
      `kind: ${workItem.type}, status: ${workItem.status}, editor: ${workItem.editor_type}`,
      `file: ${workItem.source_path || '(no file attached yet)'}`,
      `folder: ${workItem.folder || '(no own folder yet)'}`,
      `versions: ${versions.length ? versions.map((v) => `v${v.version_no}`).join(', ') : 'none'}`,
      assetsLine(workItem.id),
    ].join('\n'))
  } else {
    add('current_item', 'No work item is open: the conversation is about the project as a whole.')
  }

  // 4. Fajlok -- a mappa allapota KIMONDVA (nem latok oda vs nincs semmi).
  const rf = recentFiles(project, MAX_FILES)
  if (rf.state !== 'ok') {
    add('files', `Project files: cannot be listed right now (${rf.state}). This does NOT mean there are no files.`)
  } else if (!rf.files.length) {
    add('files', 'Project files: the folder was read and it is empty.')
  } else {
    add('files', `Project files (${rf.files.length} most recent):\n${rf.files.map((f) => `- ${f.rel}`).join('\n')}`)
  }

  const joined = blocks.join('\n\n')
  const { text, cut } = clamp(joined, MAX_CONTEXT_CHARS)
  return {
    system: SYSTEM_PROMPT.replace('{TOOLS}', toolsForPrompt()),
    contextText: `CONTEXT (measured facts; everything outside this block is unknown to you):\n${text}`,
    parts,
    truncated: cut,
  }
}

/**
 * A beszelgetes utolso forduloi, meretkorlattal.
 *
 * A LEGUJABB uzenetek maradnak: egy regi fordulo elvesztese kevesbe faj, mint
 * az, hogy a mostani keres ki se ferjen.
 */
export function historyMessages(rows: AgentMessageRow[]): AIMessage[] {
  const usable = rows.filter((r) => r.role !== 'system')
  const tail = usable.slice(-MAX_HISTORY_TURNS)
  const out: AIMessage[] = []
  let total = 0
  for (let i = tail.length - 1; i >= 0; i--) {
    const r = tail[i]
    // A jelzes kimondja, hogy CSAK itt rovidult: a puszta "[...]"-bol a modell
    // azt hitte, a sajat valasza felbeszakadt, es ezt mondta a tulajdonosnak
    // (2026-09-28: a 3833. karakternel kezdodo 6. pontnal "megszakadt").
    const c = r.content.length > HISTORY_MESSAGE_MAX_CHARS
      ? r.content.slice(0, HISTORY_MESSAGE_MAX_CHARS) + HISTORY_CUT_MARKER
      : r.content
    if (total + c.length > MAX_HISTORY_CHARS && out.length) break
    out.unshift({ role: r.role === 'assistant' ? 'assistant' : 'user', content: c })
    total += c.length
  }
  return mergeSameRole(out)
}

/**
 * Egymas utan allo AZONOS szerepu uzenetek osszevonasa.
 *
 * A rendszer-uzeneteket kiszurjuk (`historyMessages`), es egy sikertelen
 * fordulo (nincs szolgaltato, betelt keret) utan az asszisztens valasza NEM
 * kerul a naploba -- ilyenkor ket `user` uzenet all egymas mellett. Ez nem
 * ervenyes beszelgetes: a szolgaltatok valtakozo szerepeket varnak, es a
 * modell szamara is osszefolyik, hol er veget az egyik keres. Egy uresen
 * maradt tartalom sem mehet ki, ezert a szures is itt van.
 */
function mergeSameRole(list: AIMessage[]): AIMessage[] {
  const out: AIMessage[] = []
  for (const m of list) {
    if (!m.content.trim()) continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`
    else out.push({ ...m })
  }
  return out
}
