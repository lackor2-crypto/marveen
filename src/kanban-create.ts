/**
 * KARTYA-LETREHOZAS EGY KAPUN (kanban #336, 3. fazis).
 *
 * Eddig a kartya-letrehozas OSSZES szabalya a `POST /api/kanban` utvonalon
 * belul allt: a kotelezo cimke, a kapcsolodo kartyak ketiranyu belinkelese es
 * a projekt-kotes. A Munkapad agense (Boss, 2026-09-21: "KOD-JAVITAS nem
 * munkadarab, hanem KANBAN KARTYA") ugyanezt a kaput kell hogy hasznalja --
 * kulonben ket helyen allna ugyanaz a szabaly, es az egyik elobb-utobb
 * lemaradna. Pontosan ez az az indok, amit a `kanban-labels.ts` mar egyszer
 * kimondott: a szabaly a LETREHOZAS PONTJAN el, nem a hivo utasitasaiban.
 *
 * Amit ez a modul kikenyszerit:
 *   1. CIMKE -- `resolveCardLabels()`, tehat cimke nelkul nem szuletik kartya
 *      (ures telepitesen, ahol meg egy cimke sincs, nem kovetelheto).
 *   2. KAPCSOLODO KARTYA -- ha a cim hasonlit meglevokre es a hivo nem mondta
 *      meg, hogy mi a viszony, a kartya NEM jon letre: a hivo megkapja a
 *      jelolteket, es ujra kell kuldenie `related`-del (akar ures listaval).
 *   3. PROJEKT-KOTES -- a `project` mezo mindig valodi projekt-azonositova
 *      oldodik.
 */
import { randomUUID } from 'node:crypto'
import { createKanbanCard, getKanbanCard, listKanbanCards, updateKanbanCard, type KanbanCard } from './db.js'
import { findSimilarCards, referencedCardIds, withCrossLink } from './kanban-related.js'
import { resolveCardLabels, applyCardLabels } from './web/kanban-labels.js'
import { projectDefaultLabel, resolveProjectRef } from './projects.js'

export interface CardCandidate { id: string; seq: number | null; title: string; status: string }

export type CreateCardOutcome =
  | { ok: true; id: string; labels: string[]; linked: string[] }
  | { ok: false; code: 'label_error'; error: string }
  | { ok: false; code: 'related_required'; error: string; similar: CardCandidate[] }

export interface CreateCardRequest {
  title?: unknown
  description?: unknown
  status?: unknown
  assignee?: unknown
  priority?: unknown
  project?: unknown
  parent_id?: unknown
  due_date?: unknown
  labels?: unknown
  labelId?: unknown
  /** A kapcsolodo kartyak (id vagy #sorszam). Ures tomb = "megneztem, nincs". */
  related?: unknown
}

export const RELATED_REQUIRED_MESSAGE =
  'Kapcsolodo kartyak lehetnek -- linkeld be oket, vagy jelezd hogy nincs kapcsolat. '
  + 'Kuldd ujra a "related" mezovel: related: ["<id>", ...] a kapcsolodokkal, vagy related: [] ha tenyleg nincs kapcsolat. '
  + 'A szerver mindket iranyba beirja a hivatkozast.'

/**
 * Egy uj kanban kartya, a fenti harom szabállyal. A visszateres SOSE dob: a
 * hivo (HTTP utvonal vagy agent-tool) donti el, hogyan mondja el a hibat.
 */
export function createCardWithRules(data: CreateCardRequest): CreateCardOutcome {
  const id = randomUUID().slice(0, 8)
  const parentId = data.parent_id === undefined || data.parent_id === null ? null : String(data.parent_id)

  // Cimke nelkul kert kartya egy projektben: a projekt alapertelmezett cimkeje.
  // Alfeladatnal a szulo nyer.
  const labelInput = data.labels ?? data.labelId
  const projectLabel = !parentId && !(Array.isArray(labelInput) ? labelInput.length : labelInput)
    ? projectDefaultLabel(data.project) : undefined
  const labels = resolveCardLabels(projectLabel ?? labelInput, { parentId })
  if (!labels.ok) return { ok: false, code: 'label_error', error: labels.error }

  const existing: CardCandidate[] = listKanbanCards().map((c: KanbanCard) => ({
    id: c.id, seq: c.seq ?? null, title: c.title, status: c.status,
  }))
  const alreadyLinked = referencedCardIds(`${data.title ?? ''} ${data.description ?? ''}`, existing)
  const relatedRaw: unknown = data.related
  const declared = Array.isArray(relatedRaw)
  if (!parentId && !declared && alreadyLinked.length === 0) {
    const similar = findSimilarCards(String(data.title ?? ''), existing)
    if (similar.length > 0) {
      return { ok: false, code: 'related_required', error: RELATED_REQUIRED_MESSAGE, similar }
    }
  }

  const relatedCards = declared
    ? existing.filter((c) => (relatedRaw as unknown[]).some((r) => {
      const v = String(r).replace(/^#/, '').toLowerCase()
      return c.id.toLowerCase() === v || String(c.seq ?? '') === v
    }))
    : existing.filter((c) => alreadyLinked.includes(c.id))

  const { labels: _labels, labelId: _labelId, related: _related, ...rest } = data
  const cardFields = rest as Record<string, unknown>
  if (cardFields.project !== undefined) cardFields.project = resolveProjectRef(cardFields.project)
  cardFields.description = withCrossLink(String(cardFields.description ?? ''), relatedCards)

  createKanbanCard({ id, ...(cardFields as unknown as { title: string }) })
  applyCardLabels(id, labels.labelIds)

  // A masik irany: a hivatkozas a MASIK kartyaba is bekerul -- az egyiranyu
  // emlekezes pontosan az, ami a gyakorlatban elromlott.
  const selfRef: CardCandidate[] = [{
    id, seq: null, title: String(data.title ?? ''), status: String(data.status ?? 'planned'),
  }]
  for (const other of relatedCards) {
    const card = getKanbanCard(other.id)
    if (!card) continue
    const updated = withCrossLink(card.description ?? '', selfRef)
    if (updated !== (card.description ?? '')) updateKanbanCard(other.id, { description: updated })
  }

  return { ok: true, id, labels: labels.labelIds, linked: relatedCards.map((c) => c.id) }
}
