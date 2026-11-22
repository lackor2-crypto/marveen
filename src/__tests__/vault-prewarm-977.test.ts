// #977: the first vault decrypt after a restart derived one scrypt key per entry on the main thread (~3 s frozen). The
// prewarm fills the same cache through the thread pool, with the very same key.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isDerivedKeyCached, prewarmDerivedKeys } from '../web/vault.js'

describe('vault derived-key prewarm', () => {
  it('is cold before, warm after, and a second pass derives nothing', async () => {
    const master = randomBytes(64)
    const packed = Buffer.concat([randomBytes(32), randomBytes(40)]).toString('base64')
    expect(isDerivedKeyCached(master, packed)).toBe(false)
    expect(await prewarmDerivedKeys(master, [packed, packed])).toBe(1)
    expect(isDerivedKeyCached(master, packed)).toBe(true)
    expect(await prewarmDerivedKeys(master, [packed])).toBe(0)
  })
  it('skips a blob too short to hold a salt', async () => {
    expect(await prewarmDerivedKeys(randomBytes(64), ['AAAA'])).toBe(0)
  })
})
