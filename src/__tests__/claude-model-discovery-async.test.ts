import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanBinaryForModelIds, scanBinaryForModelIdsAsync } from '../claude-model-discovery.js'

describe('model id scan of a big binary', () => {
  it('finds the same ids sync and async, including one split at a chunk border', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mscan-'))
    try {
      const f = join(dir, 'claude')
      const chunk = 4 * 1024 * 1024
      const filler = Buffer.alloc(chunk * 2 + 1000, 0x41)
      // an id that straddles the first chunk border
      Buffer.from('claude-opus-5-5').copy(filler, chunk - 6)
      Buffer.from('xx claude-sonnet-5-5 yy claude-haiku-4-5\0claude-fable-5-1').copy(filler, chunk * 2 + 100)
      Buffer.from('claude-code and claude-opus-x').copy(filler, 500)
      writeFileSync(f, filler)
      const want = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'].sort()
      expect([...scanBinaryForModelIds(f)].sort()).toEqual(want)
      expect([...await scanBinaryForModelIdsAsync(f)].sort()).toEqual(want)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('never holds the event loop for long while scanning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mscan-'))
    try {
      const f = join(dir, 'claude')
      writeFileSync(f, Buffer.alloc(64 * 1024 * 1024, 0x41))
      let worst = 0
      let last = Date.now()
      const t = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n }, 5)
      await scanBinaryForModelIdsAsync(f)
      clearInterval(t)
      expect(worst).toBeLessThan(250)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns an empty set for a missing file', async () => {
    expect((await scanBinaryForModelIdsAsync('/nonexistent/claude')).size).toBe(0)
  })
})
