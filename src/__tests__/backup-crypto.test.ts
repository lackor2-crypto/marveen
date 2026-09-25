/**
 * #396 Phase 1 -- the backup file encryption (src/backup/crypto.ts).
 * Round trip, and every way a damaged or wrong-key file must be refused:
 * wrong key, a flipped bit in chunk N, a file cut at a chunk boundary (final
 * flag missing), an edited header (bound through the AAD).
 */
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  BackupDecryptError, decryptStream, encryptStream, generateRecoveryKey, keyIdOf,
  normalizeRecoveryKey, readHeader, unwrapDataKey, DEFAULT_KDF_N,
} from '../backup/crypto.js'

const CHUNK = 1024
const base = { createdAt: '2026-09-25T20:15:00+02:00', appVersion: '1.29.0', appCommit: 'abcd1234', kind: 'manual' as const }

async function encrypt(key: string, plain: Buffer, kdfN = 1024): Promise<Buffer> {
  const { header, transform } = encryptStream(key, base, { kdfN, chunkSize: CHUNK })
  const out: Buffer[] = [header]
  await pipeline(Readable.from([plain]), transform, new Writable({ write(c, _e, cb) { out.push(c); cb() } }))
  return Buffer.concat(out)
}

async function decrypt(key: string, file: Buffer): Promise<Buffer> {
  const { header, headerBytes, payloadOffset } = readHeader(file)
  const out: Buffer[] = []
  const dec = decryptStream(key, header, headerBytes)
  // Feed in odd-sized pieces so chunk boundaries never line up with writes.
  const body = file.subarray(payloadOffset)
  const pieces: Buffer[] = []
  for (let i = 0; i < body.length; i += 777) pieces.push(body.subarray(i, i + 777))
  await pipeline(Readable.from(pieces), dec, new Writable({ write(c, _e, cb) { out.push(c); cb() } }))
  return Buffer.concat(out)
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok' } catch (e) {
    if (e instanceof BackupDecryptError) return e.code
    throw e
  }
}

describe('recovery key', () => {
  it('is 6 groups of 5 Crockford characters', () => {
    const k = generateRecoveryKey()
    expect(k).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/)
    expect(generateRecoveryKey()).not.toBe(k)
  })

  it('is forgiving about case, spaces, dashes and look-alike letters', () => {
    const k = 'ABCDE-FGH1K-MN0PQ-RSTVW-XYZ01-23456'
    const typed = 'abcde fghik mnopq rstvw xyzol 23456'.replace(/i/g, 'I')
    expect(normalizeRecoveryKey(typed)).toBe(k)
    expect(keyIdOf(typed)).toBe(keyIdOf(k))
  })

  it('a user-chosen password is used as typed', () => {
    expect(normalizeRecoveryKey('  my own passphrase  ')).toBe('my own passphrase')
  })
})

describe('round trip', () => {
  const key = generateRecoveryKey()

  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 5 * CHUNK + 17])('%i bytes', async (n) => {
    const plain = randomBytes(n)
    const file = await encrypt(key, plain)
    expect((await decrypt(key, file)).equals(plain)).toBe(true)
  })

  it('the header is plaintext and names no content', async () => {
    const file = await encrypt(key, Buffer.from('secret payload'))
    const { header } = readHeader(file)
    expect(header.kind).toBe('manual')
    expect(header.keyId).toBe(keyIdOf(key))
    expect(file.toString('latin1')).not.toContain('secret payload')
  })

  it('works with the real scrypt cost', async () => {
    const plain = randomBytes(2000)
    const file = await encrypt(key, plain, DEFAULT_KDF_N)
    expect(readHeader(file).header.kdf.N).toBe(DEFAULT_KDF_N)
    expect((await decrypt(key, file)).equals(plain)).toBe(true)
  })
})

describe('refusals', () => {
  const key = generateRecoveryKey()
  const plain = randomBytes(4 * CHUNK + 100)

  it('wrong key -> wrong_key, before any data', async () => {
    const file = await encrypt(key, plain)
    const { header } = readHeader(file)
    expect(() => unwrapDataKey(generateRecoveryKey(), header)).toThrow(BackupDecryptError)
    expect(await codeOf(decrypt(generateRecoveryKey(), file))).toBe('wrong_key')
  })

  it('a flipped bit in chunk 2 -> corrupt', async () => {
    const file = await encrypt(key, plain)
    const { payloadOffset } = readHeader(file)
    const bad = Buffer.from(file)
    bad[payloadOffset + 2 * (CHUNK + 16) + 5] ^= 0x01
    expect(await codeOf(decrypt(key, bad))).toBe('corrupt')
  })

  it('a flipped bit in the final chunk -> corrupt', async () => {
    const file = await encrypt(key, plain)
    const bad = Buffer.from(file)
    bad[bad.length - 3] ^= 0x80
    expect(await codeOf(decrypt(key, bad))).toBe('corrupt')
  })

  it('cut at a chunk boundary (final chunk missing) -> truncated', async () => {
    const file = await encrypt(key, plain)
    const { payloadOffset } = readHeader(file)
    const cut = file.subarray(0, payloadOffset + 3 * (CHUNK + 16))
    expect(await codeOf(decrypt(key, cut))).toBe('truncated')
  })

  it('header only, no chunks -> truncated', async () => {
    const file = await encrypt(key, plain)
    const { payloadOffset } = readHeader(file)
    expect(await codeOf(decrypt(key, file.subarray(0, payloadOffset)))).toBe('truncated')
  })

  it('an edited header (createdAt) fails authentication', async () => {
    const file = await encrypt(key, plain)
    // Same-length edit, so the header still parses: only the AAD can catch it.
    const edited = Buffer.from(file.toString('latin1').replace('T20:15:00', 'T20:16:00'), 'latin1')
    expect(edited.length).toBe(file.length)
    expect(readHeader(edited).header.createdAt).toContain('T20:16:00')
    expect(await codeOf(decrypt(key, edited))).toBe('corrupt')
  })

  it('appended bytes after the final chunk fail', async () => {
    const file = await encrypt(key, plain)
    expect(await codeOf(decrypt(key, Buffer.concat([file, randomBytes(CHUNK + 16)])))).not.toBe('ok')
  })

  it('a non-backup file -> not_a_backup', () => {
    expect(() => readHeader(Buffer.from('PK\u0003\u0004 zip file'))).toThrow(/not a Marveen backup/)
  })

  it('an absurd scrypt cost in a header is refused, not computed', async () => {
    const file = await encrypt(key, plain)
    const { header } = readHeader(file)
    expect(() => unwrapDataKey(key, { ...header, kdf: { ...header.kdf, N: 1 << 24 } })).toThrow(BackupDecryptError)
  })
})
