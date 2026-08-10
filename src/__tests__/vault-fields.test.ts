import { describe, it, expect } from 'vitest'
import {
  normalizeVaultFields,
  fieldsToMeta,
  isSecretField,
  MAX_FIELDS_PER_ENTRY,
  MAX_FIELD_VALUE_LEN,
  MAX_FIELD_LABEL_LEN,
  normalizeTags,
  pushHistory,
  secretValuesReplaced,
  MAX_TAGS_PER_ENTRY,
  MAX_TAG_LEN,
  MAX_HISTORY_ENTRIES,
  groupFieldsBySection,
  uniqueSectionName,
  canonicalTagKey,
  canonicalizeTags,
  similarTags,
} from '../vault-fields.js'

describe('normalizeVaultFields', () => {
  it('keeps a full field as given', () => {
    const out = normalizeVaultFields([
      { label: 'Jelszó', kind: 'secret', value: 'hunter2', note: 'a céges fiókhoz' },
    ])
    expect(out).toEqual([{ label: 'Jelszó', kind: 'secret', value: 'hunter2', note: 'a céges fiókhoz' }])
  })

  it('keeps a named-but-empty field: naming a slot before filling it is normal', () => {
    expect(normalizeVaultFields([{ label: 'TOTP', kind: 'secret' }]))
      .toEqual([{ label: 'TOTP', kind: 'secret', value: '' }])
  })

  it('drops a row that carries no information at all', () => {
    expect(normalizeVaultFields([{ label: '  ', value: '', note: '' }, {}, null, 'nope'])).toEqual([])
  })

  it('keeps a value that has no label yet rather than losing what was typed', () => {
    const out = normalizeVaultFields([{ value: 'sk-live-123' }])
    expect(out).toHaveLength(1)
    expect(out[0].value).toBe('sk-live-123')
    expect(out[0].label).toBe('')
  })

  it('falls back to text for an unknown or missing kind', () => {
    expect(normalizeVaultFields([{ label: 'a', value: 'b', kind: 'nuclear' }])[0].kind).toBe('text')
    expect(normalizeVaultFields([{ label: 'a', value: 'b' }])[0].kind).toBe('text')
  })

  it('accepts every supported kind', () => {
    const out = normalizeVaultFields([
      { label: 'u', kind: 'text', value: 'x' },
      { label: 'p', kind: 'secret', value: 'x' },
      { label: 'l', kind: 'url', value: 'x' },
      { label: 'd', kind: 'date', value: 'x' },
    ])
    expect(out.map(f => f.kind)).toEqual(['text', 'secret', 'url', 'date'])
  })

  it('is not a field list at all when given a non-array', () => {
    expect(normalizeVaultFields(undefined)).toEqual([])
    expect(normalizeVaultFields({ label: 'x' })).toEqual([])
    expect(normalizeVaultFields('x')).toEqual([])
  })

  it('caps the number of fields so one entry cannot bloat the vault file', () => {
    const many = Array.from({ length: MAX_FIELDS_PER_ENTRY + 20 }, (_, i) => ({ label: 'f' + i, value: 'v' }))
    expect(normalizeVaultFields(many)).toHaveLength(MAX_FIELDS_PER_ENTRY)
  })

  it('truncates oversized values and labels instead of rejecting the save', () => {
    const out = normalizeVaultFields([{ label: 'x'.repeat(500), value: 'y'.repeat(20_000) }])
    expect(out[0].label).toHaveLength(MAX_FIELD_LABEL_LEN)
    expect(out[0].value).toHaveLength(MAX_FIELD_VALUE_LEN)
  })

  it('omits an empty note rather than storing an empty string', () => {
    expect(normalizeVaultFields([{ label: 'a', value: 'b', note: '   ' }])[0]).not.toHaveProperty('note')
  })

  it('preserves order, which is the order the user arranged the card in', () => {
    const out = normalizeVaultFields([
      { label: 'Felhasználónév', value: 'boss' },
      { label: 'Jelszó', kind: 'secret', value: 'x' },
      { label: 'Link', kind: 'url', value: 'https://example.com' },
    ])
    expect(out.map(f => f.label)).toEqual(['Felhasználónév', 'Jelszó', 'Link'])
  })
})

describe('fieldsToMeta', () => {
  it('never leaks a value, but still says whether one exists', () => {
    const meta = fieldsToMeta(normalizeVaultFields([
      { label: 'Jelszó', kind: 'secret', value: 'hunter2', note: 'céges' },
      { label: 'TOTP', kind: 'secret', value: '' },
    ]))
    expect(JSON.stringify(meta)).not.toContain('hunter2')
    expect(meta[0]).toEqual({ label: 'Jelszó', kind: 'secret', hasValue: true, note: 'céges' })
    expect(meta[1].hasValue).toBe(false)
  })
})

describe('isSecretField', () => {
  it('masks only the secret kind', () => {
    expect(isSecretField({ kind: 'secret' })).toBe(true)
    expect(isSecretField({ kind: 'text' })).toBe(false)
    expect(isSecretField({ kind: 'url' })).toBe(false)
    expect(isSecretField({ kind: 'date' })).toBe(false)
  })
})

// A card is one PLACE ("OpenRouter"), but the fleet asks for one KEY
// (getSecret('openrouter-fleet-key')). Merging the three openrouter-* entries
// into a single card only works because a field can carry the technical id the
// lookup uses -- without it the merge would silently return null for every
// agent spawn and every billing call (Boss 2026-08-10).
describe('field binding ids', () => {
  it('keeps a well-formed binding id', () => {
    const out = normalizeVaultFields([{ label: 'Fleet kulcs', kind: 'secret', value: 'sk', bindingId: 'openrouter-fleet-key' }])
    expect(out[0].bindingId).toBe('openrouter-fleet-key')
  })

  it('drops a malformed binding rather than storing one that binds to nothing', () => {
    for (const bad of ['has space', 'sla/sh', 'quote"', '']) {
      expect(normalizeVaultFields([{ label: 'x', value: 'y', bindingId: bad }])[0]).not.toHaveProperty('bindingId')
    }
  })

  it('exposes the binding in meta -- it says which field the fleet reads', () => {
    const meta = fieldsToMeta(normalizeVaultFields([
      { label: 'Fleet kulcs', kind: 'secret', value: 'sk-secret', bindingId: 'openrouter-fleet-key' },
    ]))
    expect(meta[0].bindingId).toBe('openrouter-fleet-key')
    expect(JSON.stringify(meta)).not.toContain('sk-secret')
  })
})

describe('normalizeTags', () => {
  it('accepts an array and keeps the typed order', () => {
    expect(normalizeTags(['Bank', 'Személyes'])).toEqual(['Bank', 'Személyes'])
  })

  it('accepts a comma-separated string, which is what a plain input gives back', () => {
    expect(normalizeTags(' bank , személyes ,, ')).toEqual(['bank', 'személyes'])
  })

  it('de-duplicates case-insensitively but keeps the first spelling', () => {
    expect(normalizeTags(['Bank', 'bank', 'BANK'])).toEqual(['Bank'])
  })

  it('is empty for anything that is not tags', () => {
    expect(normalizeTags(undefined)).toEqual([])
    expect(normalizeTags(42)).toEqual([])
    expect(normalizeTags([1, null, {}])).toEqual([])
  })

  it('caps the count and the length', () => {
    expect(normalizeTags(Array.from({ length: 50 }, (_, i) => 't' + i))).toHaveLength(MAX_TAGS_PER_ENTRY)
    expect(normalizeTags(['x'.repeat(200)])[0]).toHaveLength(MAX_TAG_LEN)
  })
})

describe('password history', () => {
  const T1 = '2026-08-10T10:00:00.000Z'
  const T2 = '2026-08-10T11:00:00.000Z'

  it('records a replaced secret, newest first', () => {
    const h1 = pushHistory([], [{ label: 'Jelszó', value: 'regi' }], T1)
    const h2 = pushHistory(h1, [{ label: 'Jelszó', value: 'kozepso' }], T2)
    expect(h2.map(e => e.value)).toEqual(['kozepso', 'regi'])
    expect(h2[0].at).toBe(T2)
  })

  it('does not record filling in a blank for the first time', () => {
    expect(pushHistory([], [{ label: 'Jelszó', value: '' }], T1)).toEqual([])
  })

  it('caps the list so a chatty integration cannot grow it forever', () => {
    let h: ReturnType<typeof pushHistory> = []
    for (let i = 0; i < 40; i++) h = pushHistory(h, [{ label: 'p', value: 'v' + i }], T1)
    expect(h).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(h[0].value).toBe('v39')
  })

  it('spots exactly the secret values a save replaces', () => {
    const before = normalizeVaultFields([
      { label: 'Jelszó', kind: 'secret', value: 'regi' },
      { label: 'Felhasználónév', kind: 'text', value: 'boss' },
      { label: 'Token', kind: 'secret', value: 'valtozatlan' },
    ])
    const after = normalizeVaultFields([
      { label: 'Jelszó', kind: 'secret', value: 'uj' },
      { label: 'Felhasználónév', kind: 'text', value: 'masik' },
      { label: 'Token', kind: 'secret', value: 'valtozatlan' },
    ])
    // Only the changed SECRET counts: a username is not worth a second copy.
    expect(secretValuesReplaced(before, after)).toEqual([{ label: 'Jelszó', value: 'regi' }])
  })

  it('records nothing when a field is renamed, rather than misattributing it', () => {
    const before = normalizeVaultFields([{ label: 'Jelszó', kind: 'secret', value: 'regi' }])
    const after = normalizeVaultFields([{ label: 'Belépési jelszó', kind: 'secret', value: 'uj' }])
    expect(secretValuesReplaced(before, after)).toEqual([])
  })
})

// A flat list cannot say what a password belongs to. Boss, looking at a card
// with a "Fiók email" and a bare "Jelszó" under it: "azon a jelszo mihez
// tartozik? Kihez, mihez tartozik? Ez a problema." Sections are the answer: a
// template creates a named box and its fields live inside it.
describe('sections', () => {
  it('keeps the section on a field', () => {
    const out = normalizeVaultFields([{ label: 'Jelszó', kind: 'secret', value: 'x', section: 'Bankkártya' }])
    expect(out[0].section).toBe('Bankkártya')
  })

  it('treats a blank section as no section rather than a group named ""', () => {
    expect(normalizeVaultFields([{ label: 'a', value: 'b', section: '   ' }])[0]).not.toHaveProperty('section')
  })

  it('groups fields, keeping section order and field order inside each', () => {
    const fields = normalizeVaultFields([
      { label: 'Megjegyzés', value: 'x' },
      { label: 'Kártyaszám', value: '1', section: 'Bankkártya' },
      { label: 'Felhasználónév', value: 'u', section: 'Netbank' },
      { label: 'CVC', value: '2', section: 'Bankkártya' },
    ])
    expect(groupFieldsBySection(fields)).toEqual([
      { section: '', fields: [expect.objectContaining({ label: 'Megjegyzés' })] },
      { section: 'Bankkártya', fields: [expect.objectContaining({ label: 'Kártyaszám' }), expect.objectContaining({ label: 'CVC' })] },
      { section: 'Netbank', fields: [expect.objectContaining({ label: 'Felhasználónév' })] },
    ])
  })

  it('exposes the section in meta so a closed card can group its chips', () => {
    const meta = fieldsToMeta(normalizeVaultFields([{ label: 'CVC', kind: 'secret', value: '123', section: 'Bankkártya' }]))
    expect(meta[0].section).toBe('Bankkártya')
    expect(JSON.stringify(meta)).not.toContain('123')
  })

  it('names a repeated template apart so two bank cards do not merge', () => {
    expect(uniqueSectionName('Bankkártya', [])).toBe('Bankkártya')
    expect(uniqueSectionName('Bankkártya', ['Bankkártya'])).toBe('Bankkártya 2')
    expect(uniqueSectionName('Bankkártya', ['Bankkártya', 'Bankkártya 2'])).toBe('Bankkártya 3')
  })

  it('matches an existing section case-insensitively when picking a new name', () => {
    expect(uniqueSectionName('Wifi', ['wifi'])).toBe('Wifi 2')
  })
})

// Hand-typing tags on every card makes "Személyes", "szemelyes" and a typo
// three separate groups, and the filter row stops being usable (Boss: "ha lesz
// 50 cimke, vagy csak 15, az mar problema").
describe('tag canonicalisation', () => {
  it('treats case, accents, spacing and punctuation as the same tag', () => {
    const key = canonicalTagKey('Személyes')
    expect(canonicalTagKey('szemelyes')).toBe(key)
    expect(canonicalTagKey('SZEMÉLYES')).toBe(key)
    expect(canonicalTagKey(' személyes ')).toBe(key)
    expect(canonicalTagKey('személyes!')).toBe(key)
  })

  it('snaps a variant onto the spelling already in use', () => {
    expect(canonicalizeTags(['szemelyes', 'MUNKA'], ['Személyes', 'munka'])).toEqual(['Személyes', 'munka'])
  })

  it('leaves a genuinely new tag exactly as typed', () => {
    expect(canonicalizeTags(['Bank'], ['Személyes'])).toEqual(['Bank'])
  })

  it('collapses variants of the same tag within one save', () => {
    expect(canonicalizeTags(['Bank', 'bank', 'BANK'], [])).toEqual(['Bank'])
  })

  it('does NOT silently rewrite a typo -- that is a suggestion, not a fact', () => {
    expect(canonicalizeTags(['szemelyess'], ['Személyes'])).toEqual(['szemelyess'])
  })

  it('offers close existing tags as likely typos', () => {
    expect(similarTags('szemelyess', ['Személyes', 'munka'])).toEqual(['Személyes'])
    expect(similarTags('bnak', ['Bank'])).toEqual(['Bank'])
  })

  it('does not flag a different tag as a typo', () => {
    expect(similarTags('bank', ['munka', 'Személyes'])).toEqual([])
  })

  it('stays quiet for very short input, where everything looks similar', () => {
    expect(similarTags('ba', ['Bank'])).toEqual([])
  })
})
