// Sharing debate modes between installs (#597, phase 7): the owner's own modes as a file, and a file as modes.
//
// This is an open-source product, so a shared file carries NOTHING of the machine it came from: no id (the importing
// install makes its own), no path, no user name, no model list -- only what a mode is: name, description, kind, the
// texts, strength, role swap, round limit. Importing never overwrites: an imported mode is always a NEW mode, and one
// whose name is taken gets a number ("Name (2)").
//
// The texts of a mode are instructions to a model, so a file from someone else is read like a message from someone
// else: the panel shows the names and asks before it imports anything. Everything is checked again here, because the
// file can be anything the sender (or a text editor) made of it.
//
// Pure (no I/O); the routes do the reading and the writing.

import { MODES_MAX, MODE_NAME_MAX, sanitizeStoredMode, type StoredMode } from './debate-modes.js'

export const SHARE_FORMAT = 'marveen-debate-modes'
export const SHARE_VERSION = 1
/** A file larger than this is not a mode file (the biggest legal mode is far below it). */
export const SHARE_MAX_BYTES = 1024 * 1024

export type SharedMode = Omit<StoredMode, 'id'>

export interface ShareFile {
  format: typeof SHARE_FORMAT
  version: typeof SHARE_VERSION
  exported_at: string
  modes: SharedMode[]
}

/** The file for the given modes. The ids stay behind: they belong to this install. */
export function buildShareFile(modes: readonly StoredMode[], now: Date = new Date()): ShareFile {
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exported_at: now.toISOString(),
    modes: modes.map(m => {
      const { id: _id, ...rest } = m
      return rest
    }),
  }
}

export function shareFileName(count: number, now: Date = new Date()): string {
  return `marveen-vita-modok-${now.toISOString().slice(0, 10)}${count === 1 ? '' : `-${count}`}.json`
}

export type ParseShareResult = { ok: true; modes: unknown[] } | { ok: false; error: 'bad_json' | 'not_a_mode_file' | 'newer_version' | 'too_big' | 'empty' }

/** The raw mode entries of a mode file. `raw` is the file's text or its already parsed JSON. */
export function parseShareFile(raw: unknown): ParseShareResult {
  let data: unknown = raw
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf-8') > SHARE_MAX_BYTES) return { ok: false, error: 'too_big' }
    try { data = JSON.parse(raw) } catch { return { ok: false, error: 'bad_json' } }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'not_a_mode_file' }
  const f = data as Record<string, unknown>
  if (f.format !== SHARE_FORMAT || !Array.isArray(f.modes)) return { ok: false, error: 'not_a_mode_file' }
  if (typeof f.version === 'number' && f.version > SHARE_VERSION) return { ok: false, error: 'newer_version' }
  if (!f.modes.length) return { ok: false, error: 'empty' }
  return { ok: true, modes: f.modes }
}

export interface ImportSkip { name: string; reason: string }
export interface ImportPlan { toSave: StoredMode[]; skipped: ImportSkip[]; renamed: { from: string; to: string }[] }

/** The first free "Name (2)", "Name (3)" ...; the suffix is kept whole when the name has to be cut. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`
    const candidate = name.slice(0, MODE_NAME_MAX - suffix.length).trimEnd() + suffix
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return name
}

/**
 * What an import would do, without doing it: each entry is checked like a mode typed in the editor, gets a fresh id
 * and a free name, and only as many fit as the install has room for (MODES_MAX). Entries that do not fit or do not
 * pass are skipped one by one -- one bad entry never blocks the good ones.
 */
export function planImport(entries: readonly unknown[], existing: readonly StoredMode[], newId: () => string): ImportPlan {
  const taken = new Set(existing.map(m => m.name.toLowerCase()))
  const plan: ImportPlan = { toSave: [], skipped: [], renamed: [] }
  for (const raw of entries) {
    const label = raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' ? String((raw as { name: string }).name).slice(0, MODE_NAME_MAX) : ''
    // The file's own id is dropped: an imported mode never replaces one of this install.
    const clean = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>), id: undefined } : raw
    const r = sanitizeStoredMode(clean, newId)
    if (!r.ok) { plan.skipped.push({ name: label, reason: r.error }); continue }
    if (existing.length + plan.toSave.length >= MODES_MAX) { plan.skipped.push({ name: r.mode.name, reason: 'too_many' }); continue }
    const name = freeName(r.mode.name, taken)
    if (name !== r.mode.name) plan.renamed.push({ from: r.mode.name, to: name })
    taken.add(name.toLowerCase())
    plan.toSave.push({ ...r.mode, name })
  }
  return plan
}
