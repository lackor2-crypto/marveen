// #516: every process has its OWN LibreOffice profile folder. One shared
// folder made two processes converting at the same time knock each other out
// (measured: 7 of 18 parallel conversions came back convert_failed).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

describe('LibreOffice profile folder (#516)', () => {
  it('is per process, and the first call clears what dead processes and the old shared profile left behind', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'lo-prof-'))
    try {
      // a pid that is certainly not alive: a child that has already exited
      const dead = spawnSync(process.execPath, ['-e', '0']).pid as number
      mkdirSync(join(cache, 'lo-profile', 'user'), { recursive: true })      // the old shared one
      mkdirSync(join(cache, `lo-profile-${dead}`, 'user'), { recursive: true })
      mkdirSync(join(cache, `lo-profile-${process.ppid}`), { recursive: true }) // a LIVE process: must stay
      mkdirSync(join(cache, 'tmp-something'), { recursive: true })              // not ours to judge

      const { loProfileDir } = await import('../office-convert.js')
      const mine = loProfileDir(cache)
      expect(basename(mine)).toBe(`lo-profile-${process.pid}`)
      expect(existsSync(join(cache, 'lo-profile'))).toBe(false)
      expect(existsSync(join(cache, `lo-profile-${dead}`))).toBe(false)
      expect(existsSync(join(cache, `lo-profile-${process.ppid}`))).toBe(true)
      expect(existsSync(join(cache, 'tmp-something'))).toBe(true)
      // the same folder every time, and no second sweep
      mkdirSync(join(cache, 'lo-profile'), { recursive: true })
      expect(loProfileDir(cache)).toBe(mine)
      expect(existsSync(join(cache, 'lo-profile'))).toBe(true)
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  })

  it('a cache folder that does not exist yet is not an error', async () => {
    const { loProfileDir } = await import('../office-convert.js')
    expect(basename(loProfileDir(join(tmpdir(), 'lo-prof-does-not-exist-' + process.pid)))).toBe(`lo-profile-${process.pid}`)
  })
})
