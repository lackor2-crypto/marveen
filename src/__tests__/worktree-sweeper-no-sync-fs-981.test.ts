// #981: the worktree sweep ran statSync / readlinkSync / readdirSync(/proc) on the dashboard's main thread
// (one call per worktree file and per process), which showed up as multi-second stalls in /api/perf/stalls.
// The two helpers are now async; this fails on the old synchronous versions.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { localProcessCwds, worktreeActivityMs } from '../web/worktree-sweeper.js'

describe('#981 worktree sweep does not block the main thread', () => {
  it('both helpers return promises', async () => {
    const a = localProcessCwds()
    expect(a).toBeInstanceOf(Promise)
    expect(Array.isArray(await a)).toBe(true)
    const b = worktreeActivityMs({ path: process.cwd(), branch: null } as never)
    expect(b).toBeInstanceOf(Promise)
    expect(typeof (await b)).toBe('number')
  })
  it('the module imports no synchronous stat/read/readlink/readdir', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'worktree-sweeper.ts'), 'utf8')
    expect(src).not.toMatch(/\b(statSync|readFileSync|readlinkSync|readdirSync)\b/)
  })
})
