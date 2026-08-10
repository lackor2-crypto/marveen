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
