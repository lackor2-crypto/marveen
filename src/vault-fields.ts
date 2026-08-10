// Structured fields on a vault entry.
//
// The vault started as one encrypted value per id, which is right for an API
// key the fleet reads through getSecret() and wrong for everything a person
// keeps in a password manager. Boss, 2026-08-10: "egy olyan tarolora [gondoltam]
// amiben ha akarom irok: linket, api kulcsot, tokent, felhasznaloi nevet es
// jelszot, esetleg egy egyeb beviteli mezo masnak. es mindegyikhez ugye
// megjegyzest lehessen irni magyarazatokat."
//
// So an entry keeps its single primary value -- getSecret(id) must go on
// returning byte-identically what it always did, the whole fleet reads keys
// through it -- and gains an ordered list of additional named fields beside
// it. Field VALUES are encrypted with the same master key as the primary
// value; only labels, kinds and notes are ever handed out unencrypted, so a
// card can show its structure without exposing anything.
//
// This module is the pure half: validation and normalization, no crypto, no
// I/O. src/web/vault.ts owns those.

/** How a field is presented and protected. */
export type VaultFieldKind = 'text' | 'secret' | 'url' | 'date'

export const VAULT_FIELD_KINDS: readonly VaultFieldKind[] = ['text', 'secret', 'url', 'date']

export interface VaultField {
  /** Human name, chosen from a preset ("Jelszó") or typed freely. */
  label: string
  kind: VaultFieldKind
  value: string
  /** Why this field is here / where it is used. The point of the whole card. */
  note?: string
  /**
   * Technical id the fleet reads this value by, e.g. "openrouter-fleet-key".
   *
   * A card is one PLACE ("OpenRouter"), but code asks for one KEY. Without
   * this, merging the three openrouter-* entries into a single card would
   * take getSecret('openrouter-fleet-key') -- and with it every agent spawn
   * and every billing call -- straight to null. Binding the field to that id
   * lets the card be human-shaped while the lookup keeps working unchanged.
   */
  bindingId?: string
}

/** What a field looks like with its value withheld. */
export interface VaultFieldMeta {
  label: string
  kind: VaultFieldKind
  note?: string
  /** Shown as a badge so it is obvious which field the fleet reads. */
  bindingId?: string
  /** Whether a value exists at all, so the UI can show an empty field as empty. */
  hasValue: boolean
}

// Caps exist so a malformed or hostile payload cannot bloat the vault file,
// which is rewritten in full on every save. Generous enough that no real
// entry hits them: recovery-code blocks and long notes both fit.
export const MAX_FIELDS_PER_ENTRY = 50
export const MAX_FIELD_LABEL_LEN = 200
export const MAX_FIELD_VALUE_LEN = 8000
export const MAX_FIELD_NOTE_LEN = 2000

function clampStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v.length > max ? v.slice(0, max) : v
}

/**
 * Coerce untrusted input into a storable field list.
 *
 * Anything unusable is dropped rather than rejected: a half-filled row in the
 * editor is a normal intermediate state, not an error to throw in the user's
 * face. A row with neither a label nor a value carries no information and is
 * discarded; a row with only a label is kept, because naming a field before
 * filling it in is exactly how people build one of these cards.
 */
export function normalizeVaultFields(input: unknown): VaultField[] {
  if (!Array.isArray(input)) return []
  const out: VaultField[] = []
  for (const raw of input) {
    if (out.length >= MAX_FIELDS_PER_ENTRY) break
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const label = clampStr(r.label, MAX_FIELD_LABEL_LEN).trim()
    const value = clampStr(r.value, MAX_FIELD_VALUE_LEN)
    const note = clampStr(r.note, MAX_FIELD_NOTE_LEN).trim()
    if (!label && !value && !note) continue
    const kindRaw = typeof r.kind === 'string' ? r.kind : ''
    const kind = (VAULT_FIELD_KINDS as readonly string[]).includes(kindRaw)
      ? kindRaw as VaultFieldKind
      : 'text'
    const field: VaultField = { label, kind, value }
    if (note) field.note = note
    // Same charset the vault ids already use; anything else is a typo, and a
    // bogus binding is worse than none (it would shadow nothing but look real).
    const binding = clampStr(r.bindingId, MAX_FIELD_LABEL_LEN).trim()
    if (binding && /^[A-Za-z0-9._-]+$/.test(binding)) field.bindingId = binding
    out.push(field)
  }
  return out
}

/** Strip every value, keeping only what is safe to list. */
export function fieldsToMeta(fields: VaultField[]): VaultFieldMeta[] {
  return fields.map(f => {
    const meta: VaultFieldMeta = { label: f.label, kind: f.kind, hasValue: f.value.length > 0 }
    if (f.note) meta.note = f.note
    if (f.bindingId) meta.bindingId = f.bindingId
    return meta
  })
}

/** True when the field holds something that must never be shown unmasked. */
export function isSecretField(field: { kind: VaultFieldKind }): boolean {
  return field.kind === 'secret'
}

// ---- tags -------------------------------------------------------------------
//
// One category forces a card into a single drawer, and Boss agreed with the
// professional practice after seeing why: "igazadban cimkezni jobb, mert egy
// valami tobb helyhez is tartozhat" -- an Erste Bank card is both "bank" and
// "personal". The old single `category` is migrated in as the first tag, so no
// existing entry loses its grouping.

export const MAX_TAGS_PER_ENTRY = 20
export const MAX_TAG_LEN = 60

/** Trim, drop blanks, de-duplicate case-insensitively, keep the typed order. */
export function normalizeTags(input: unknown): string[] {
  const raw: unknown[] = Array.isArray(input)
    ? input
    // A comma-separated string is what a plain text input gives back, and it is
    // the shape the UI sends before any chip editor exists.
    : (typeof input === 'string' ? input.split(',') : [])
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = (item.length > MAX_TAG_LEN ? item.slice(0, MAX_TAG_LEN) : item).trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS_PER_ENTRY) break
  }
  return out
}

// ---- password history -------------------------------------------------------
//
// Standard in every serious password manager, and for a concrete reason: a site
// rejects the change, or an integration keeps failing, and the previous value is
// the only way back. Only SECRET values are kept -- a username is not worth the
// extra copy of sensitive data lying around.

export const MAX_HISTORY_ENTRIES = 10

export interface VaultHistoryEntry {
  /** Which field this used to be the value of. */
  label: string
  value: string
  /** ISO timestamp of when it was REPLACED. */
  at: string
}

/**
 * Record superseded values, newest first, capped.
 *
 * An empty previous value is not history -- filling in a blank field for the
 * first time has replaced nothing.
 */
export function pushHistory(
  existing: VaultHistoryEntry[],
  replaced: Array<{ label: string; value: string }>,
  atIso: string,
  cap: number = MAX_HISTORY_ENTRIES,
): VaultHistoryEntry[] {
  const additions = replaced
    .filter(r => r.value.length > 0)
    .map(r => ({ label: r.label, value: r.value, at: atIso }))
  if (additions.length === 0) return existing.slice(0, cap)
  return [...additions, ...existing].slice(0, cap)
}

/**
 * Which secret values are being replaced by this save.
 *
 * Fields are matched by label, because that is the only stable identity a
 * user-editable row has -- renaming a field is therefore treated as a new
 * field rather than a value change, which is the safe direction: it records
 * nothing rather than attributing an old password to the wrong name.
 */
export function secretValuesReplaced(before: VaultField[], after: VaultField[]): Array<{ label: string; value: string }> {
  const nextByLabel = new Map(after.filter(f => f.label).map(f => [f.label, f]))
  const out: Array<{ label: string; value: string }> = []
  for (const prev of before) {
    if (prev.kind !== 'secret' || !prev.value || !prev.label) continue
    const next = nextByLabel.get(prev.label)
    if (!next) continue
    if (next.value !== prev.value) out.push({ label: prev.label, value: prev.value })
  }
  return out
}
