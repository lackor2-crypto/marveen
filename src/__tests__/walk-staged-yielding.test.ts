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

// #835: `git bundle create` took ~1 s as a sync spawn inside createBackup and held the whole dashboard.
describe('createBackup git bundle', () => {
  it('runs the bundle through an async execFile, never execFileSync', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(__dirname, '..', 'backup', 'create.ts'), 'utf8')
    const bundleCall = src.slice(src.indexOf("'bundle', 'create'") - 200, src.indexOf("'bundle', 'create'") + 200)
    expect(bundleCall).toContain('execFile(')
    expect(bundleCall).not.toContain('execFileSync(')
  })
})
