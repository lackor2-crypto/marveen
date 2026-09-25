/**
 * The recovery key of the full backup (#396, plan §2.1 "Who holds the key", §6.1).
 *
 * Home-Assistant model: Marveen generates a strong key and keeps it locally in
 * store/.backup-key (0600) so scheduled backups need no human; the user gets it
 * ONCE on the emergency kit and confirms they saved it. The key file is NEVER
 * put into a backup (inventory STORE_EXCLUDE) -- a backup that carries its own
 * key protects nothing.
 *
 * Old keys stay in `previous` after a rotation: backups made before it still
 * need them, and the kit download lists every key still in use.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateRecoveryKey, keyIdOf, normalizeRecoveryKey } from './crypto.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'

export interface StoredKey {
  key: string
  keyId: string
  createdAt: string
  confirmedAt: string | null
  /** true when the user set their own password instead of the generated key. */
  custom?: boolean
}

export interface KeyFile {
  current: StoredKey
  previous: StoredKey[]
}

export function keyFilePath(storeDir: string): string {
  return join(storeDir, '.backup-key')
}

export function readKeyFile(storeDir: string): KeyFile | null {
  const p = keyFilePath(storeDir)
  if (!existsSync(p)) return null
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as KeyFile
  if (!parsed?.current?.key) throw new Error('store/.backup-key is damaged: no current key')
  if (!Array.isArray(parsed.previous)) parsed.previous = []
  return parsed
}

function writeKeyFile(storeDir: string, kf: KeyFile): void {
  mkdirSync(dirname(keyFilePath(storeDir)), { recursive: true })
  atomicWriteFileSync(keyFilePath(storeDir), JSON.stringify(kf, null, 2) + '\n', { mode: 0o600 })
}

function fresh(key: string, custom = false): StoredKey {
  const k = normalizeRecoveryKey(key)
  return { key: k, keyId: keyIdOf(k), createdAt: new Date().toISOString(), confirmedAt: null, ...(custom ? { custom: true } : {}) }
}

/** The current key; created on first use. */
export function getOrCreateKey(storeDir: string): StoredKey {
  const kf = readKeyFile(storeDir)
  if (kf) return kf.current
  const created: KeyFile = { current: fresh(generateRecoveryKey()), previous: [] }
  writeKeyFile(storeDir, created)
  return created.current
}

/**
 * Replace the current key (a new generated one, or the user's own password).
 * The old one moves to `previous`; future backups use the new key.
 */
export function rotateKey(storeDir: string, ownPassword?: string): StoredKey {
  if (ownPassword !== undefined && normalizeRecoveryKey(ownPassword).length < 12) {
    throw new Error('password_too_short')
  }
  const kf = readKeyFile(storeDir)
  const next = ownPassword !== undefined ? fresh(ownPassword, true) : fresh(generateRecoveryKey())
  const previous = kf ? [kf.current, ...kf.previous].filter((k) => k.keyId !== next.keyId) : []
  writeKeyFile(storeDir, { current: next, previous })
  return next
}

export function confirmKitSaved(storeDir: string): StoredKey {
  const kf = readKeyFile(storeDir)
  if (!kf) throw new Error('no_key')
  kf.current.confirmedAt = new Date().toISOString()
  writeKeyFile(storeDir, kf)
  return kf.current
}

/** Find a stored key (current or previous) by its key id. */
export function findKeyById(storeDir: string, keyId: string): StoredKey | null {
  const kf = readKeyFile(storeDir)
  if (!kf) return null
  return [kf.current, ...kf.previous].find((k) => k.keyId === keyId) ?? null
}

/** Drop previous keys no retained backup uses any more. */
export function prunePreviousKeys(storeDir: string, keyIdsInUse: Set<string>): void {
  const kf = readKeyFile(storeDir)
  if (!kf) return
  const kept = kf.previous.filter((k) => keyIdsInUse.has(k.keyId))
  if (kept.length !== kf.previous.length) writeKeyFile(storeDir, { current: kf.current, previous: kept })
}
