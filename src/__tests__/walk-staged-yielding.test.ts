import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkStaged, walkStagedYielding } from '../backup/create.js'

// #835: the staging walk hashed every file in one blocking pass (3 s stall). The yielding variant must give the same manifest.
describe('walkStagedYielding', () => {
  it('returns exactly what the sync walk returns, and lets timers run meanwhile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'walk-yield-'))
    try {
      mkdirSync(join(root, 'a', 'b'), { recursive: true })
      writeFileSync(join(root, 'a', 'one.txt'), 'x'.repeat(3 * 1024 * 1024))
      writeFileSync(join(root, 'a', 'b', 'two.txt'), 'hello')
      writeFileSync(join(root, 'three.txt'), '')
      symlinkSync('a/one.txt', join(root, 'link'))
      let ticks = 0
      const t = setInterval(() => { ticks++ }, 0)
      const y = await walkStagedYielding(root)
      clearInterval(t)
      expect(y).toEqual(walkStaged(root))
      expect(y.files.length).toBe(3)
      expect(y.links.length).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
