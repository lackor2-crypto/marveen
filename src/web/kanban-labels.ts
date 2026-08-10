// Every kanban card carries at least one label. This is Boss's standing rule,
// and it kept being broken the same way: the label went on in a SECOND step
// after the card was written, so anything that dropped that step (a forgotten
// call, an error, an agent moving on) left a bare card on the board -- four at
// once at one point, and again on 2026-08-10 ("ne tortenjen ilyen tobbet").
//
// So the rule lives here, at the point where cards are created, instead of in
// the instructions of whoever calls the API. Every route that creates a card
// resolves its labels through resolveCardLabels() first and refuses to write
// the card if that fails.
import { listLabels, addLabelToCard, getLabelsForCard } from '../db.js'

export type LabelResolution =
  | { ok: true; labelIds: string[] }
  | { ok: false; error: string }

function labelMenu(): string {
  return listLabels().map(l => `${l.name} (${l.id})`).join(', ')
}

/**
 * Resolves the labels for a card about to be created.
 *
 * `input` accepts label ids OR names (GET /api/kanban/labels returns both and
 * callers reasonably reach for the readable one). A card created under a
 * parent inherits the parent's labels when none are given -- a subtask lives in
 * its parent's world, so asking twice would be noise. An install with no labels
 * defined yet cannot require one.
 */
export function resolveCardLabels(input: unknown, opts: { parentId?: string | null } = {}): LabelResolution {
  const known = listLabels()
  const requested: unknown[] = Array.isArray(input) ? input : (typeof input === 'string' && input ? [input] : [])
  const labelIds: string[] = []
  for (const raw of requested) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const hit = known.find(l => l.id === raw) ?? known.find(l => l.name === raw)
    if (!hit) {
      return { ok: false, error: `Ismeretlen címke: "${raw}". Az érvényes címkék: ${labelMenu()}` }
    }
    if (!labelIds.includes(hit.id)) labelIds.push(hit.id)
  }
  if (labelIds.length === 0 && opts.parentId) {
    for (const l of getLabelsForCard(opts.parentId)) {
      if (!labelIds.includes(l.id)) labelIds.push(l.id)
    }
  }
  if (labelIds.length === 0 && known.length > 0) {
    return {
      ok: false,
      error: 'Címke kötelező: minden kártyához legalább egy címke kell (labels: ["<id vagy név>"]). ' +
        `Választható: ${labelMenu()}. ` +
        'Ha nem egyértelmű melyik illik rá, kérdezd meg Bosst, és NE hozd létre addig a kártyát.',
    }
  }
  return { ok: true, labelIds }
}

/** Attaches resolved labels to a freshly created card. */
export function applyCardLabels(cardId: string, labelIds: string[]): void {
  for (const labelId of labelIds) addLabelToCard(cardId, labelId)
}
