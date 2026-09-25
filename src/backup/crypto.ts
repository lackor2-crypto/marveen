/**
 * Backup file encryption (#396, docs/BACKUP-RESTORE-PLAN.md §4).
 *
 * File layout:
 *   0      magic "MRVNBK01" (8 bytes)
 *   8      header length L (uint32 BE)
 *   12     header JSON (L bytes, UTF-8) -- plaintext, holds no content data
 *   12+L   chunks: ciphertext(<= chunkSize) || GCM tag (16 bytes)
 *
 * Key hierarchy: a random 256-bit data key per backup encrypts the payload; the
 * data key is wrapped with a key derived from the RECOVERY KEY through scrypt.
 * The recovery key is what the user keeps on the emergency kit.
 *
 * Chunking is the STREAM construction: every chunk nonce is
 * noncePrefix(7) || counter(uint32 BE) || lastFlag(1), and the AAD of every
 * chunk is sha256(header bytes). So a reordered, dropped, truncated or edited
 * file -- header included -- fails authentication instead of decrypting to
 * something plausible.
 *
 * Node built-ins only: `age`/`restic` are not present on a fresh install.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scryptSync } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { Transform, type TransformCallback } from 'node:stream'

export const MAGIC = Buffer.from('MRVNBK01', 'ascii')
export const FORMAT = 1
export const DEFAULT_CHUNK = 64 * 1024
const TAG = 16
const MAX_HEADER = 64 * 1024
/** scrypt cost used for real backups: 2^17 (~128 MiB, ~0.3-0.8 s). */
export const DEFAULT_KDF_N = 131072
// A header is attacker-controlled input: never let it make us burn gigabytes.
const MIN_KDF_N = 1024
const MAX_KDF_N = 1 << 20

// Crockford base32: no I, L, O, U -- nothing a human can misread when typing it
// back from paper.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export type BackupKind = 'scheduled' | 'manual' | 'pre-restore'

export interface BackupHeader {
  format: number
  createdAt: string
  appVersion: string
  appCommit: string
  kind: BackupKind
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; salt: string }
  wrappedKey: { alg: 'A256GCM'; nonce: string; ct: string }
  keyId: string
  noncePrefix: string
  chunkSize: number
}

export type HeaderBase = Pick<BackupHeader, 'createdAt' | 'appVersion' | 'appCommit' | 'kind'>

export type DecryptErrorCode = 'wrong_key' | 'corrupt' | 'truncated' | 'not_a_backup' | 'format_unknown'

export class BackupDecryptError extends Error {
  code: DecryptErrorCode
  constructor(code: DecryptErrorCode, message: string) {
    super(message)
    this.name = 'BackupDecryptError'
    this.code = code
  }
}

/** 30 random Crockford characters in six groups of five: ~150 bits, typeable. */
export function generateRecoveryKey(): string {
  let s = ''
  for (let i = 0; i < 30; i++) s += CROCKFORD[randomInt(32)]
  return s.match(/.{5}/g)!.join('-')
}

/**
 * The canonical form of a recovery key as the user types it back: case,
 * spaces and dashes do not matter, and the letters Crockford folds (O->0,
 * I/L->1) are folded. A string that is not a generated key (a user-chosen
 * password, the "own password" option) is used as typed, only trimmed.
 */
export function normalizeRecoveryKey(input: string): string {
  const raw = String(input ?? '').trim()
  const compact = raw.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
  if (compact.length === 30 && [...compact].every((c) => CROCKFORD.includes(c))) {
    return compact.match(/.{5}/g)!.join('-')
  }
  return raw
}

export function keyIdOf(recoveryKey: string): string {
  return createHash('sha256').update(normalizeRecoveryKey(recoveryKey), 'utf8').digest('hex').slice(0, 8)
}

function deriveKek(recoveryKey: string, kdf: BackupHeader['kdf']): Buffer {
  if (kdf.alg !== 'scrypt' || !Number.isInteger(kdf.N) || kdf.N < MIN_KDF_N || kdf.N > MAX_KDF_N
      || (kdf.N & (kdf.N - 1)) !== 0 || kdf.r < 1 || kdf.r > 16 || kdf.p < 1 || kdf.p > 4) {
    throw new BackupDecryptError('format_unknown', 'Unsupported key-derivation parameters in the backup header.')
  }
  return scryptSync(normalizeRecoveryKey(recoveryKey), Buffer.from(kdf.salt, 'base64'), 32, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024,
  })
}

function chunkNonce(prefix: Buffer, counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12)
  prefix.copy(n, 0, 0, 7)
  n.writeUInt32BE(counter >>> 0, 7)
  n[11] = last ? 1 : 0
  return n
}

function serializeHeader(h: BackupHeader): Buffer {
  const json = Buffer.from(JSON.stringify(h), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(json.length, 0)
  return Buffer.concat([MAGIC, len, json])
}

export interface EncryptOptions {
  /** Test seam only: a cheaper scrypt cost. Real backups use DEFAULT_KDF_N. */
  kdfN?: number
  chunkSize?: number
}

/**
 * Build the header for a new backup and the Transform that turns plaintext into
 * the chunk sequence. Write `header` first, then pipe the payload through
 * `transform`.
 */
export function encryptStream(recoveryKey: string, headerBase: HeaderBase, opts: EncryptOptions = {}): { header: Buffer; headerJson: BackupHeader; transform: Transform } {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK
  const kdf = { alg: 'scrypt' as const, N: opts.kdfN ?? DEFAULT_KDF_N, r: 8, p: 1, salt: randomBytes(16).toString('base64') }
  const dataKey = randomBytes(32)
  const kek = deriveKek(recoveryKey, kdf)
  const wrapNonce = randomBytes(12)
  const wc = createCipheriv('aes-256-gcm', kek, wrapNonce)
  const wrapped = Buffer.concat([wc.update(dataKey), wc.final(), wc.getAuthTag()])
  const noncePrefix = randomBytes(7)
  const headerJson: BackupHeader = {
    format: FORMAT,
    createdAt: headerBase.createdAt,
    appVersion: headerBase.appVersion,
    appCommit: headerBase.appCommit,
    kind: headerBase.kind,
    kdf,
    wrappedKey: { alg: 'A256GCM', nonce: wrapNonce.toString('base64'), ct: wrapped.toString('base64') },
    keyId: keyIdOf(recoveryKey),
    noncePrefix: noncePrefix.toString('base64'),
    chunkSize,
  }
  const header = serializeHeader(headerJson)
  const aad = createHash('sha256').update(header).digest()

  let counter = 0
  let pending = Buffer.alloc(0)
  const seal = (plain: Buffer, last: boolean): Buffer => {
    const c = createCipheriv('aes-256-gcm', dataKey, chunkNonce(noncePrefix, counter++, last))
    c.setAAD(aad)
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
  }
  const transform = new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
      // Keep at least one byte back: only the flush knows which chunk is last.
      while (pending.length > chunkSize) {
        this.push(seal(pending.subarray(0, chunkSize), false))
        pending = pending.subarray(chunkSize)
      }
      cb()
    },
    flush(cb: TransformCallback) {
      this.push(seal(pending, true))
      pending = Buffer.alloc(0)
      cb()
    },
  })
  return { header, headerJson, transform }
}

/** Parse the plaintext header from the first bytes of a backup file. */
export function readHeader(src: Buffer | string): { header: BackupHeader; headerBytes: Buffer; payloadOffset: number } {
  let buf: Buffer
  if (typeof src === 'string') {
    const fd = openSync(src, 'r')
    try {
      const head = Buffer.alloc(12)
      const n = readSync(fd, head, 0, 12, 0)
      if (n < 12 || !head.subarray(0, 8).equals(MAGIC)) {
        throw new BackupDecryptError('not_a_backup', 'This file is not a Marveen backup.')
      }
      const len = head.readUInt32BE(8)
      if (len === 0 || len > MAX_HEADER) throw new BackupDecryptError('corrupt', 'The backup header is damaged.')
      const body = Buffer.alloc(len)
      const m = readSync(fd, body, 0, len, 12)
      if (m < len) throw new BackupDecryptError('truncated', 'The backup file is cut short.')
      buf = Buffer.concat([head, body])
    } finally { closeSync(fd) }
  } else {
    buf = src
  }
  if (buf.length < 12 || !buf.subarray(0, 8).equals(MAGIC)) {
    throw new BackupDecryptError('not_a_backup', 'This file is not a Marveen backup.')
  }
  const len = buf.readUInt32BE(8)
  if (len === 0 || len > MAX_HEADER) throw new BackupDecryptError('corrupt', 'The backup header is damaged.')
  if (buf.length < 12 + len) throw new BackupDecryptError('truncated', 'The backup file is cut short.')
  const headerBytes = buf.subarray(0, 12 + len)
  let header: BackupHeader
  try {
    header = JSON.parse(headerBytes.subarray(12).toString('utf8')) as BackupHeader
  } catch {
    throw new BackupDecryptError('corrupt', 'The backup header is damaged.')
  }
  if (typeof header?.format !== 'number') throw new BackupDecryptError('corrupt', 'The backup header is damaged.')
  if (header.format !== FORMAT) {
    throw new BackupDecryptError('format_unknown', `Backup format ${header.format} is newer than this Marveen understands.`)
  }
  return { header, headerBytes: Buffer.from(headerBytes), payloadOffset: 12 + len }
}

/** Unwrap the data key; a wrong recovery key fails here, before any payload. */
export function unwrapDataKey(recoveryKey: string, header: BackupHeader): Buffer {
  const kek = deriveKek(recoveryKey, header.kdf)
  const ct = Buffer.from(header.wrappedKey.ct, 'base64')
  if (ct.length !== 32 + TAG) throw new BackupDecryptError('corrupt', 'The backup header is damaged.')
  try {
    const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(header.wrappedKey.nonce, 'base64'))
    d.setAuthTag(ct.subarray(32))
    return Buffer.concat([d.update(ct.subarray(0, 32)), d.final()])
  } catch {
    throw new BackupDecryptError('wrong_key', `This key does not open this backup (key id ${header.keyId}).`)
  }
}

/**
 * Transform that turns the chunk sequence (everything after the header) back
 * into plaintext. Errors are BackupDecryptError with a code:
 *   wrong_key  -- the recovery key does not unwrap the data key (thrown here,
 *                 synchronously, before any data flows)
 *   corrupt    -- a chunk fails authentication
 *   truncated  -- the stream ended without a final chunk
 */
export function decryptStream(recoveryKey: string, header: BackupHeader, headerBytes: Buffer): Transform {
  const dataKey = unwrapDataKey(recoveryKey, header)
  const chunkSize = header.chunkSize
  if (!Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > 16 * 1024 * 1024) {
    throw new BackupDecryptError('corrupt', 'The backup header is damaged.')
  }
  const record = chunkSize + TAG
  const prefix = Buffer.from(header.noncePrefix, 'base64')
  const aad = createHash('sha256').update(headerBytes).digest()
  let counter = 0
  let pending = Buffer.alloc(0)
  const open = (rec: Buffer, idx: number, last: boolean): Buffer | null => {
    if (rec.length < TAG) return null
    try {
      const d = createDecipheriv('aes-256-gcm', dataKey, chunkNonce(prefix, idx, last))
      d.setAAD(aad)
      d.setAuthTag(rec.subarray(rec.length - TAG))
      return Buffer.concat([d.update(rec.subarray(0, rec.length - TAG)), d.final()])
    } catch { return null }
  }
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
      // A full record is only known to be non-final once more bytes follow it.
      while (pending.length > record) {
        const plain = open(pending.subarray(0, record), counter, false)
        if (!plain) return cb(new BackupDecryptError('corrupt', `The backup file is damaged (chunk ${counter}).`))
        counter++
        this.push(plain)
        pending = pending.subarray(record)
      }
      cb()
    },
    flush(cb: TransformCallback) {
      if (pending.length === 0) return cb(new BackupDecryptError('truncated', 'The backup file is cut short (no final chunk).'))
      const plain = open(pending, counter, true)
      if (plain) {
        this.push(plain)
        return cb()
      }
      // The last record authenticates as a MIDDLE chunk: the real final chunk
      // (and maybe more) is missing -- the file was cut at a chunk boundary.
      if (pending.length === record && open(pending, counter, false)) {
        return cb(new BackupDecryptError('truncated', 'The backup file is cut short (final chunk missing).'))
      }
      // A short last record that authenticates neither way: the bytes are
      // damaged or the file was cut mid-chunk; cryptographically the two look
      // the same, so we say both.
      cb(new BackupDecryptError('corrupt', `The backup file is damaged or cut short (chunk ${counter}).`))
    },
  })
}
