// #977: the first vault decrypt after a restart derived one scrypt key per entry on the main thread (~3 s frozen). The
// prewarm fills the same cache through the thread pool, with the very same key.
import { createCipheriv, randomBytes, scryptSync as realScryptSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const scryptSyncSpy = vi.hoisted(() => ({ calls: 0 }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, scryptSync: ((...a: Parameters<typeof actual.scryptSync>) => { scryptSyncSpy.calls++; return actual.scryptSync(...a) }) as typeof actual.scryptSync }
})

import { decryptWithKey, isDerivedKeyCached, prewarmDerivedKeys } from '../web/vault.js'

/** A blob in the vault format (salt + iv + tag + ciphertext), built with the plain synchronous key derivation. */
function pack(master: Buffer, plaintext: string): string {
  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-gcm', realScryptSync(master, salt, 32), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return Buffer.concat([salt, iv, cipher.getAuthTag(), enc]).toString('base64')
}

describe('vault derived-key prewarm', () => {
  beforeEach(() => { scryptSyncSpy.calls = 0 })

  it('is cold before, warm after, and a second pass derives nothing', async () => {
    const master = randomBytes(64)
    const packed = pack(master, 'x')
    scryptSyncSpy.calls = 0
    expect(isDerivedKeyCached(master, packed)).toBe(false)
    expect(await prewarmDerivedKeys(master, [packed, packed])).toBe(1)
    expect(isDerivedKeyCached(master, packed)).toBe(true)
    expect(await prewarmDerivedKeys(master, [packed])).toBe(0)
  })

  it('without the prewarm the first decrypt runs scryptSync on the calling (main) thread -- the measured freeze', () => {
    const master = randomBytes(64)
    const packed = pack(master, 'secret-1')
    scryptSyncSpy.calls = 0
    expect(decryptWithKey(master, packed)).toBe('secret-1')
    expect(scryptSyncSpy.calls).toBe(1)
  })

  it('after the prewarm the decrypt gets the SAME key (it opens the blob) and runs no scryptSync at all', async () => {
    const master = randomBytes(64)
    const blobs = ['a', 'b', 'c'].map((t) => pack(master, t))
    scryptSyncSpy.calls = 0
    expect(await prewarmDerivedKeys(master, blobs)).toBe(3)
    expect(scryptSyncSpy.calls).toBe(0) // the prewarm itself uses the thread pool, never the sync call
    expect(blobs.map((b) => decryptWithKey(master, b))).toEqual(['a', 'b', 'c'])
    expect(scryptSyncSpy.calls).toBe(0)
  })

  it('skips a blob too short to hold a salt', async () => {
    expect(await prewarmDerivedKeys(randomBytes(64), ['AAAA'])).toBe(0)
  })
})
