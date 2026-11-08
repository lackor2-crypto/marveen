// The "this linked document is missing" record of the guard (#873), kept apart so the lists can read it
// without importing the guard itself (which imports them).
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './web/atomic-write.js'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

const STATE_FILE = join(STORE_DIR, 'linked-docs-missing.json')

export interface MissingEntry {
  /** Where the file was when it was last seen (depot-relative). */
  rel: string
  /** Where it is used, for the message: `Project / item (role)` lines. */
  uses: string[]
  since: string
  /** The owner said: take the state as it is now. The entry stays, but nothing reports or marks it. */
  ignored?: boolean
  /** When the guard last searched the whole tree for it by content (ms). A known-missing file is not searched again every sweep. */
  searchedAt?: number
}
export type MissingState = Record<string, MissingEntry>

export function readMissingState(): MissingState {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as MissingState } catch { return {} }
}
export function writeMissingState(s: MissingState): void {
  try { mkdirSync(STORE_DIR, { recursive: true }); atomicWriteFileSync(STATE_FILE, JSON.stringify(s, null, 2)) } catch (err) { logger.warn({ err }, '[link-guard] could not save the missing-state') }
}

/** Did the guard already conclude, after looking for it, that this linked document is gone for good (until it is back)? */
export function isMarkedMissing(docId: string): boolean {
  const e = readMissingState()[`doc:${docId}`]
  return Boolean(e && !e.ignored)
}
