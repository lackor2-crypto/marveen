/**
 * #751 (Boss, TG 4201): what the text of a document asks for is NOT a gate on finalizing. "az ilyet bele kell tenni a
 * todo listaba ... es akkor ott majd en vagy megcsinalom, vagy kipipalom hogy nem kell. de ezzel ne akassza meg a rendszer
 * a veglegesitest". Every open point of the check that comes from the CONTENT (a missing datum, an unverified reference,
 * a chapter still in progress, an untranslated chapter, ...) becomes a to-do of the work item. Only the signature and
 * the annexes are asked about at finalizing, and even those can be overridden with a tick (see `needsOverride`).
 *
 * The to-dos are the program's own (created_by = CHECK_TODO_BY): one is made once per text; when the owner ticks it
 * off, it is never made again (the ticked row stays); when the point goes away by itself (the datum was filled in),
 * the still-open row is removed, so the list does not fill with stale points.
 */
import { addTodo, deleteTodo, listItemTodos, TODO_TEXT_MAX } from './workbench-todos.js'
import type { CheckItem } from './workbench-docmodel.js'

export const CHECK_TODO_BY = 'doc-check'

/** The check rows the owner is asked about at finalizing (a tick lets the owner go on anyway). */
const OVERRIDE_KEYS = new Set(['annexes', 'annex_dangling', 'annex_missing_file', 'annex_unsupported'])

/** True when the signature picture is missing or an annex is not in order: the finalize box asks for a tick. */
export function needsOverride(items: CheckItem[]): boolean {
  return items.some((i) => (i.key === 'signature_missing' && i.count > 0) || (OVERRIDE_KEYS.has(i.key) && !i.ok))
}

const PREFIX: Record<string, { hu: string; en: string }> = {
  sections_done: { hu: 'Fejezet befejezése', en: 'Finish the chapter' },
  missing_data: { hu: 'Hiányzó adat', en: 'Missing information' },
  unverified_references: { hu: 'Hivatkozás ellenőrzése', en: 'Check the reference' },
  quotes_verified: { hu: 'Idézet ellenőrzése', en: 'Check the quote' },
  unsupported_claims: { hu: 'Állítás forrása', en: 'Source for the statement' },
  consistency: { hu: 'Eltérés a szövegben', en: 'Mismatch in the text' },
  variant_current: { hu: 'Nyelvi változat: fejezet fordítása', en: 'Language version: translate the chapter' },
  image_missing_file: { hu: 'Kép, amelynek a fájlja eltűnt', en: 'Picture whose file is gone' },
}

const SELF_LABELLED = /^(Hiányzó adat|Forrás nem található|Missing data|Source not found)(?=[\s:]|$)/

/** The to-do text of ONE detail line of a check row (`''` = the row has no detail line), in the given language. */
function todoTextFor(key: string, d: string, lang: 'hu' | 'en'): string {
  const p = PREFIX[key]!
  // A missing-data mark in the text already says what it is ("Hiányzó adat: a kézbesítés dátuma"): no second prefix.
  const text = !d ? p[lang] : key === 'missing_data' && SELF_LABELLED.test(d) ? d : `${p[lang]}: ${d}`
  return text.length > TODO_TEXT_MAX ? text.slice(0, TODO_TEXT_MAX - 1) + '…' : text
}

function detailLines(i: CheckItem): string[] {
  return (i.detail || []).map((d) => String(d).replace(/^⚠\s*/, '').trim()).filter(Boolean)
}

/** The to-do texts the current check asks for (one per detail line), in the install's language. */
export function checkTodoTexts(items: CheckItem[], lang: 'hu' | 'en'): string[] {
  const out: string[] = []
  for (const i of items) {
    if (!PREFIX[i.key] || i.ok) continue
    const details = detailLines(i)
    for (const d of details.length ? details : ['']) out.push(todoTextFor(i.key, d, lang))
  }
  return [...new Set(out)]
}

/**
 * #807 (Boss, Munkapad chat): a point the owner TICKED OFF in the to-do list is handled; it must not stay in the check
 * before finalizing as a warning, and with every point ticked the "open point" line goes too. Works on the check rows
 * only (the to-do rows stay the owner's): a detail line whose program to-do is ticked is dropped, a row left without any
 * open line becomes ok. Both languages are matched, so a to-do made before a language switch still counts.
 */
export function withoutTickedPoints(itemId: string, items: CheckItem[]): CheckItem[] {
  let ticked: Set<string>
  try {
    ticked = new Set(listItemTodos(itemId).filter((t) => t.created_by === CHECK_TODO_BY && t.done_at != null).map((t) => t.text))
  } catch {
    return items
  }
  if (!ticked.size) return items
  const isTicked = (key: string, d: string) => ticked.has(todoTextFor(key, d, 'hu')) || ticked.has(todoTextFor(key, d, 'en'))
  return items.map((i) => {
    if (!PREFIX[i.key] || i.ok) return i
    const details = detailLines(i)
    if (!details.length) return isTicked(i.key, '') ? { ...i, ok: true, count: 0 } : i
    const left = (i.detail || []).filter((d) => !isTicked(i.key, String(d).replace(/^⚠\s*/, '').trim()))
    if (left.length === (i.detail || []).length) return i
    const dropped = (i.detail || []).length - left.length
    // quotes_verified counts the verified quotes, every other row counts its open lines.
    const count = i.key === 'quotes_verified' ? i.count + dropped : left.length
    return { ...i, ok: left.length === 0, count, detail: left }
  })
}

/** Brings the work item's check to-dos in line with the check; returns how many rows changed. Never throws. */
export function syncCheckTodos(itemId: string, items: CheckItem[], lang: 'hu' | 'en'): number {
  try {
    const want = new Set(checkTodoTexts(items, lang))
    const have = listItemTodos(itemId)
    let changed = 0
    // A point that went away by itself: its still-open program row goes too (a ticked one stays, it is the owner's).
    for (const t of have) {
      if (t.created_by === CHECK_TODO_BY && t.done_at == null && !want.has(t.text)) { if (deleteTodo(t.id)) changed++ }
    }
    const known = new Set(have.map((t) => t.text))
    for (const text of want) {
      if (known.has(text)) continue
      const r = addTodo({ work_item_id: itemId, text, by: CHECK_TODO_BY, source: 'agent' })
      if (r.ok) changed++
      else if (r.code === 'too_many') break
    }
    return changed
  } catch {
    return 0
  }
}
