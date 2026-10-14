// The owner-made debate modes (#597, phase 3): store/debate-modes.json.
//
// The file is the owner's data (backed up, see src/backup/inventory.ts), tiny, and read on every use -- a mode
// changed in the editor is the mode of the NEXT debate. A debate that is already running keeps the mode it started
// with: debate-run.ts writes a copy of the stored mode into the debate's `context` line.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'
import {
  MODES_MAX, modeFromStored, sanitizeStoredMode, findMode,
  type DebateModeDef, type StoredMode,
} from './debate-modes.js'

export const DEBATE_MODES_PATH = join(STORE_DIR, 'debate-modes.json')

function newModeId(): string {
  return `m-${randomBytes(4).toString('hex')}`
}

/** The stored modes, the broken entries left out: a file the owner edited by hand must never break a debate. */
export function loadStoredModes(): StoredMode[] {
  try {
    if (!existsSync(DEBATE_MODES_PATH)) return []
    const parsed = JSON.parse(readFileSync(DEBATE_MODES_PATH, 'utf-8')) as { modes?: unknown }
    if (!parsed || !Array.isArray(parsed.modes)) return []
    const out: StoredMode[] = []
    const seen = new Set<string>()
    for (const raw of parsed.modes) {
      const r = sanitizeStoredMode(raw, newModeId)
      // An entry without a valid id of its own is not kept (its id would change on every read).
      const hasId = !!raw && typeof raw === 'object' && (raw as { id?: unknown }).id === (r.ok ? r.mode.id : null)
      if (r.ok && hasId && !seen.has(r.mode.id)) { seen.add(r.mode.id); out.push(r.mode) }
    }
    return out
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message || err) }, '[debate] modes file unreadable, using the built-in modes only')
    return []
  }
}

function writeStoredModes(modes: StoredMode[]): void {
  mkdirSync(STORE_DIR, { recursive: true })
  const tmp = `${DEBATE_MODES_PATH}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, modes }, null, 2))
  renameSync(tmp, DEBATE_MODES_PATH)
}

/** The runnable owner-made modes. */
export function loadCustomModes(): DebateModeDef[] {
  return loadStoredModes().map(modeFromStored)
}

/** A mode by id, built-in or owner-made; null when there is none (a missing id is the default mode). */
export function lookupMode(id: unknown): DebateModeDef | null {
  return findMode(id, loadCustomModes())
}

export type SaveModeResult = { ok: true; mode: StoredMode } | { ok: false; error: string }

/** Creates a mode, or replaces the one with the same id. */
export function saveStoredMode(raw: unknown): SaveModeResult {
  const r = sanitizeStoredMode(raw, newModeId)
  if (!r.ok) return r
  const list = loadStoredModes()
  const at = list.findIndex(m => m.id === r.mode.id)
  if (at < 0 && list.length >= MODES_MAX) return { ok: false, error: 'too_many' }
  if (at >= 0) list[at] = r.mode
  else list.push(r.mode)
  writeStoredModes(list)
  return { ok: true, mode: r.mode }
}

/** Deletes a mode; false when there was none. Debates started with it keep their copy of it. */
export function deleteStoredMode(id: string): boolean {
  const list = loadStoredModes()
  const next = list.filter(m => m.id !== id)
  if (next.length === list.length) return false
  writeStoredModes(next)
  return true
}
