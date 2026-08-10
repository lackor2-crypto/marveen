import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { isKeychainAvailable, keychainStore, keychainRetrieve } from './keychain.js'
import { logger } from '../logger.js'
import {
  normalizeVaultFields, fieldsToMeta, normalizeTags, pushHistory, secretValuesReplaced,
  canonicalizeTags,
  type VaultField, type VaultFieldMeta, type VaultHistoryEntry,
} from '../vault-fields.js'

const VAULT_PATH = join(PROJECT_ROOT, 'store', 'vault.json')
const VAULT_KEY_PATH = join(PROJECT_ROOT, 'store', '.vault-key')
const VAULT_KEY_MIGRATED = join(PROJECT_ROOT, 'store', '.vault-key.migrated')
const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const TAG_LENGTH = 16
const SALT_LENGTH = 32

interface VaultEntry {
  id: string
  label: string
  encrypted: string  // base64(salt + iv + tag + ciphertext)
  createdAt: string
  updatedAt: string
  // Kanban 85eafd56: category/URL/notes so the vault can hold more than raw
  // key-value pairs (Boss, 2026-08-07 -- e.g. a "Taxi cég" folder for company
  // API keys, separate from personal logins). All optional/absent on entries
  // written before this -- readVaultEntry() below is what normalizes that.
  category?: string
  url?: string
  notes?: string
  // Structured extra fields (username/password/token/...), encrypted with the
  // same master key as `encrypted` above -- a password manager's contents are
  // no less sensitive than the primary value. Stored as one blob rather than
  // per-field so a card is a single encrypt/decrypt, and absent on every entry
  // written before this (readSecretFields returns [] for those).
  encryptedFields?: string
  /** Multiple tags replace the single category; see normalizeTags. */
  tags?: string[]
  /** Superseded secret values, newest first, encrypted like everything else. */
  encryptedHistory?: string
}

export interface VaultEntryMeta {
  category?: string
  url?: string
  notes?: string
  tags?: unknown
}

interface VaultStore {
  entries: VaultEntry[]
}

function getMasterKey(): Buffer {
  if (isKeychainAvailable()) {
    if (existsSync(VAULT_KEY_PATH)) {
      const fileKey = readFileSync(VAULT_KEY_PATH, 'utf-8').trim()
      try {
        keychainStore(fileKey)
        renameSync(VAULT_KEY_PATH, VAULT_KEY_MIGRATED)
        logger.info('Vault master key migrated from file to macOS Keychain')
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Keychain migration failed, keeping file-based key')
      }
      return Buffer.from(fileKey, 'base64')
    }

    const existing = keychainRetrieve()
    if (existing) return Buffer.from(existing, 'base64')

    const newKey = randomBytes(64).toString('base64')
    try {
      keychainStore(newKey)
      logger.info('New vault master key stored in macOS Keychain')
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Keychain store failed, falling back to file')
      atomicWriteFileSync(VAULT_KEY_PATH, newKey, { mode: 0o600 })
    }
    return Buffer.from(newKey, 'base64')
  }

  if (!existsSync(VAULT_KEY_PATH)) {
    const key = randomBytes(64).toString('base64')
    atomicWriteFileSync(VAULT_KEY_PATH, key, { mode: 0o600 })
  }
  return Buffer.from(readFileSync(VAULT_KEY_PATH, 'utf-8').trim(), 'base64')
}

function deriveKey(master: Buffer, salt: Buffer): Buffer {
  return scryptSync(master, salt, KEY_LENGTH)
}

function encrypt(plaintext: string): string {
  const master = getMasterKey()
  const salt = randomBytes(SALT_LENGTH)
  const key = deriveKey(master, salt)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64')
}

function decrypt(packed: string): string {
  const master = getMasterKey()
  const buf = Buffer.from(packed, 'base64')
  const salt = buf.subarray(0, SALT_LENGTH)
  const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH)
  const tag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
  const key = deriveKey(master, salt)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf-8')
}

function readVault(): VaultStore {
  try { return JSON.parse(readFileSync(VAULT_PATH, 'utf-8')) }
  catch { return { entries: [] } }
}

function writeVault(store: VaultStore): void {
  atomicWriteFileSync(VAULT_PATH, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
}

export function listSecrets(): Array<{ id: string, label: string, createdAt: string, updatedAt: string, category?: string, url?: string, notes?: string, fields?: VaultFieldMeta[] }> {
  return readVault().entries.map(e => ({
    id: e.id, label: e.label, createdAt: e.createdAt, updatedAt: e.updatedAt,
    category: e.category, url: e.url, notes: e.notes,
    // An entry written before tags existed still has its category; surfacing it
    // as a tag means no card silently loses its grouping on the way over.
    tags: effectiveTags(e),
    // Structure only, never values: the list endpoint is read by the whole
    // dashboard, and a card must be able to show "has a password" without
    // handing the password to every page that renders a list.
    fields: fieldsToMeta(decodeFields(e.encryptedFields)),
  }))
}

/** Every tag in use across the vault, for canonicalisation and for the UI. */
export function listAllTags(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of readVault().entries) {
    for (const tag of effectiveTags(e)) {
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(tag)
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'hu'))
}

/**
 * Tags for storage: normalized, then snapped onto the spelling already used
 * elsewhere in the vault so "szemelyes" does not become a second "Személyes".
 */
function tagsForStorage(input: unknown, selfId: string): string[] {
  const known: string[] = []
  const seen = new Set<string>()
  for (const e of readVault().entries) {
    if (e.id === selfId) continue
    for (const tag of effectiveTags(e)) {
      const key = tag.toLowerCase()
      if (!seen.has(key)) { seen.add(key); known.push(tag) }
    }
  }
  return canonicalizeTags(normalizeTags(input), known)
}

/** Tags as the UI should see them: stored tags, or the legacy category. */
function effectiveTags(e: { tags?: string[]; category?: string }): string[] {
  if (e.tags && e.tags.length) return e.tags
  return e.category ? [e.category] : []
}

function decodeHistory(blob: string | undefined): VaultHistoryEntry[] {
  if (!blob) return []
  try {
    const parsed = JSON.parse(decrypt(blob))
    return Array.isArray(parsed) ? parsed as VaultHistoryEntry[] : []
  } catch (err) {
    logger.warn({ err }, 'vault: stored history unreadable, dropping it')
    return []
  }
}

/** Superseded secret values for one entry, newest first. */
export function getSecretHistory(id: string): VaultHistoryEntry[] {
  const entry = readVault().entries.find(e => e.id === id)
  return entry ? decodeHistory(entry.encryptedHistory) : []
}

function decodeFields(blob: string | undefined): VaultField[] {
  if (!blob) return []
  try {
    return normalizeVaultFields(JSON.parse(decrypt(blob)))
  } catch (err) {
    logger.warn({ err }, 'vault: stored fields unreadable, treating entry as field-less')
    return []
  }
}

/** Full field list WITH values. Only for the single-entry read path. */
export function getSecretFields(id: string): VaultField[] {
  const entry = readVault().entries.find(e => e.id === id)
  if (!entry) return []
  return decodeFields(entry.encryptedFields)
}

/** Replace an entry's field list. Leaves the primary value untouched. */
export function setSecretFields(id: string, fields: unknown): boolean {
  const store = readVault()
  const idx = store.entries.findIndex(e => e.id === id)
  if (idx < 0) return false
  const normalized = normalizeVaultFields(fields)
  const entry = store.entries[idx]
  const now = new Date().toISOString()
  // Keep whatever secret values this save overwrites: a rejected password
  // change or a broken integration is exactly when the old one is needed.
  const replaced = secretValuesReplaced(decodeFields(entry.encryptedFields), normalized)
  if (replaced.length) {
    const history = pushHistory(decodeHistory(entry.encryptedHistory), replaced, now)
    entry.encryptedHistory = encrypt(JSON.stringify(history))
  }
  entry.encryptedFields = normalized.length ? encrypt(JSON.stringify(normalized)) : undefined
  entry.updatedAt = now
  store.entries[idx] = entry
  writeVault(store)
  return true
}

export function setSecret(id: string, label: string, value: string, meta?: VaultEntryMeta & { fields?: unknown }): void {
  const store = readVault()
  const now = new Date().toISOString()
  const idx = store.entries.findIndex(e => e.id === id)
  const entry: VaultEntry = {
    id, label, encrypted: encrypt(value), createdAt: now, updatedAt: now,
    category: meta?.category || undefined,
    url: meta?.url || undefined,
    notes: meta?.notes || undefined,
    tags: meta?.tags === undefined ? undefined : tagsForStorage(meta.tags, id),
  }
  if (idx >= 0) {
    entry.createdAt = store.entries[idx].createdAt
    // A meta field left out of THIS call (undefined) keeps the previous
    // value rather than wiping it -- e.g. editing just the notes shouldn't
    // silently drop the category. Pass an explicit '' to clear a field.
    if (meta?.category === undefined) entry.category = store.entries[idx].category
    if (meta?.url === undefined) entry.url = store.entries[idx].url
    if (meta?.notes === undefined) entry.notes = store.entries[idx].notes
    if (meta?.tags === undefined) entry.tags = store.entries[idx].tags
    // The primary value is a secret too, so replacing it is history as well.
    const prevPrimary = decrypt(store.entries[idx].encrypted)
    entry.encryptedHistory = store.entries[idx].encryptedHistory
    if (prevPrimary && prevPrimary !== value) {
      const history = pushHistory(decodeHistory(entry.encryptedHistory), [{ label: PRIMARY_VALUE_LABEL, value: prevPrimary }], entry.updatedAt)
      entry.encryptedHistory = encrypt(JSON.stringify(history))
    }
    // Same rule as the meta fields: not passing `fields` edits nothing rather
    // than silently deleting every field on the card.
    entry.encryptedFields = meta?.fields === undefined
      ? store.entries[idx].encryptedFields
      : encodeFields(meta.fields)
    store.entries[idx] = entry
  } else {
    if (meta?.fields !== undefined) entry.encryptedFields = encodeFields(meta.fields)
    store.entries.push(entry)
  }
  writeVault(store)
}

function encodeFields(fields: unknown): string | undefined {
  const normalized = normalizeVaultFields(fields)
  return normalized.length ? encrypt(JSON.stringify(normalized)) : undefined
}

// Editing the label/category/URL/notes on an existing entry shouldn't force
// re-typing (and re-encrypting) the secret value itself -- this rewrites
// only the metadata fields in place.
export const PRIMARY_VALUE_LABEL = '(fo ertek)'

export function updateSecretMeta(id: string, meta: { label?: string } & VaultEntryMeta): boolean {
  const store = readVault()
  const idx = store.entries.findIndex(e => e.id === id)
  if (idx < 0) return false
  const entry = store.entries[idx]
  if (meta.label !== undefined) entry.label = meta.label
  if (meta.category !== undefined) entry.category = meta.category || undefined
  if (meta.url !== undefined) entry.url = meta.url || undefined
  if (meta.notes !== undefined) entry.notes = meta.notes || undefined
  if (meta.tags !== undefined) entry.tags = tagsForStorage(meta.tags, id)
  entry.updatedAt = new Date().toISOString()
  store.entries[idx] = entry
  writeVault(store)
  return true
}

export function getSecret(id: string): string | null {
  const store = readVault()
  const entry = store.entries.find(e => e.id === id)
  if (entry) return decrypt(entry.encrypted)
  // Not a top-level entry: it may be a FIELD on a card, bound to this id. That
  // is what lets one human "OpenRouter" card carry the fleet key, the
  // management key and the account email while every getSecret() caller keeps
  // asking for the same technical name it always did.
  for (const e of store.entries) {
    const bound = decodeFields(e.encryptedFields).find(f => f.bindingId === id)
    if (bound) return bound.value
  }
  return null
}

/** Which card+field currently answers for a bound id (diagnostics/UI). */
export function findSecretBinding(id: string): { entryId: string; label: string } | null {
  for (const e of readVault().entries) {
    const bound = decodeFields(e.encryptedFields).find(f => f.bindingId === id)
    if (bound) return { entryId: e.id, label: bound.label }
  }
  return null
}

export function deleteSecret(id: string): boolean {
  const store = readVault()
  const before = store.entries.length
  store.entries = store.entries.filter(e => e.id !== id)
  if (store.entries.length === before) return false
  writeVault(store)
  return true
}

export function getSecretsForEnv(envMap: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, vaultId] of Object.entries(envMap)) {
    const value = getSecret(vaultId)
    if (value !== null) result[key] = value
  }
  return result
}
