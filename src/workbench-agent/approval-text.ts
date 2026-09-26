/**
 * A MUNKAPAD-JOVAHAGYAS LEIRASA EMBERI NYELVEN (kanban #404, H3 + H4).
 *
 * Eddig a jovahagyasok listajaban ennyi allt: "Munkapad: file.write (projekt
 * 9740e86c)". A tulajdonos nem tudta eldonteni, MIT engedelyez: melyik
 * projektben, melyik fajlt, milyen tartalommal. Most a leiras kimondja a
 * projekt NEVET, az eszkozt emberi szoval, a celt (fajlnev, cim, kartya #N),
 * a tartalom elejet, es azt, hogy a dashboardon KI kerte (H4: a jegy
 * `agent_id`-je a fo agens, a felhasznalo a leirasba kerul).
 *
 * Tiszta fuggveny, a kartya-sorszam feloldasa injektalhato (teszt).
 */
import type { Lang } from './messages.js'

const TOOL_LABELS: Record<string, { hu: string; en: string }> = {
  'workItem.create': { hu: 'új munkadarab létrehozása', en: 'create a new work item' },
  'workItem.update': { hu: 'munkadarab módosítása', en: 'change a work item' },
  'workItem.addPart': { hu: 'rész hozzáadása a munkadarabhoz', en: 'add a part to the work item' },
  'workItem.createVersion': { hu: 'új verzió mentése', en: 'save a new version' },
  'workItem.restoreVersion': { hu: 'korábbi verzió visszaállítása', en: 'restore an earlier version' },
  'document.toPdf': { hu: 'PDF készítése', en: 'make a PDF' },
  'file.write': { hu: 'fájl írása a projekt mappájába', en: 'write a file into the project folder' },
  'file.copy': { hu: 'fájl másolása', en: 'copy a file' },
  'file.move': { hu: 'fájl áthelyezése', en: 'move a file' },
  'file.rename': { hu: 'fájl átnevezése', en: 'rename a file' },
  'file.delete': { hu: 'fájl törlése (a Kukába)', en: 'delete a file (to the Trash)' },
  'canvas.edit': { hu: 'a vászon szerkesztése', en: 'edit the canvas' },
  'kanban.create': { hu: 'új kanban kártya nyitása', en: 'open a new kanban card' },
  'kanban.comment': { hu: 'komment egy kanban kártyára', en: 'comment on a kanban card' },
  'kanban.relate': { hu: 'kanban kártyák összekötése', en: 'link kanban cards' },
  'idea.create': { hu: 'új ötlet az Ötletládába', en: 'new idea in the Idea box' },
  'research.save': { hu: 'kutatási jegyzet mentése', en: 'save a research note' },
  'web.search': { hu: 'webkeresés', en: 'web search' },
  'decision.record': { hu: 'döntés rögzítése a döntésnaplóba', en: 'record a decision in the decision log' },
}

/** Az eszkoz emberi neve; ismeretlennel a gepi nev marad (nem talalunk ki). */
export function toolLabel(tool: string, lang: Lang): string {
  return TOOL_LABELS[tool]?.[lang] ?? tool
}

const L = {
  hu: { head: 'Munkapad', project: 'projekt', item: 'munkadarab', target: 'cél', to: 'ide', cards: 'kártya', content: 'tartalom eleje', by: 'kérte' },
  en: { head: 'Workbench', project: 'project', item: 'work item', target: 'target', to: 'to', cards: 'card', content: 'content starts', by: 'requested by' },
}

export const PREVIEW_CHARS = 200

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

export type SeqLookup = (cardId: string) => number | null

function cardRefs(input: Record<string, unknown>, seqOf: SeqLookup): string[] {
  const ids: string[] = []
  for (const k of ['card', 'card_id', 'cardId', 'related']) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) ids.push(v.trim())
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) ids.push(x.trim())
  }
  return ids.map((id) => {
    const bare = id.replace(/^#/, '')
    if (/^\d+$/.test(bare)) return `#${bare}`
    let seq: number | null = null
    try { seq = seqOf(bare) } catch { seq = null }
    // Sorszam nelkul a belso azonosito sosem all egymagaban.
    return seq ? `#${seq} (${bare})` : bare
  })
}

export function describeToolApproval(p: {
  tool: string
  lang: Lang
  projectName: string | null
  projectId: string
  workItemTitle: string | null
  actor: string | null
  input: Record<string, unknown>
  seqOf?: SeqLookup
}): string {
  const w = L[p.lang]
  const parts: string[] = []
  const proj = p.projectName ? `„${p.projectName}”` : p.projectId
  parts.push(`${w.head}: ${toolLabel(p.tool, p.lang)} — ${w.project} ${proj}${p.workItemTitle ? `, ${w.item} „${p.workItemTitle}”` : ''}`)
  const target = ['path', 'title', 'name'].map((k) => p.input[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined
  if (target) parts.push(`${w.target}: ${oneLine(target, 160)}`)
  if (typeof p.input.to === 'string' && p.input.to.trim()) parts.push(`${w.to}: ${oneLine(p.input.to, 160)}`)
  const cards = cardRefs(p.input, p.seqOf ?? (() => null))
  if (cards.length) parts.push(`${w.cards}: ${cards.join(', ')}`)
  const body = ['text', 'content', 'description'].map((k) => p.input[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined
  if (body) parts.push(`${w.content}: „${oneLine(body, PREVIEW_CHARS)}”`)
  if (p.actor) parts.push(`${w.by}: ${p.actor}`)
  return parts.join(' · ')
}
