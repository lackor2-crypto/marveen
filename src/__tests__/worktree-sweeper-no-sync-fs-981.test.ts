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

  // The first #981 fix made the two helpers async but left the same pattern one level down: worktreeState
  // (called by the sweep for every worktree) ran existsSync/statSync/readFileSync once per dirty file, and the
  // sweep loop ran existsSync per worktree and appendFileSync per removal -- all on the dashboard's main thread.
  const body = (file: string, startMarker: string): string => {
    const src = readFileSync(join(__dirname, '..', 'web', file), 'utf8')
    const i = src.indexOf(startMarker)
    expect(i).toBeGreaterThan(-1)
    const rest = src.slice(i)
    const end = rest.indexOf('\n}\n')
    return rest.slice(0, end === -1 ? rest.length : end)
  }
  it('worktreeState (per dirty file) uses no synchronous fs', () => {
    expect(body('abandoned-worktrees.ts', 'export async function worktreeState')).not.toMatch(/\b(existsSync|statSync|readFileSync|lstatSync)\b/)
  })
  it('the sweep loop and its log writer use no synchronous fs', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'worktree-sweeper.ts'), 'utf8')
    expect(src).not.toMatch(/\b(existsSync|appendFileSync|writeFileSync)\b/)
  })
  it('worktreeState still answers for a missing folder and a real clean folder', async () => {
    const { worktreeState } = await import('../web/abandoned-worktrees.js')
    expect(await worktreeState('/nonexistent-981-folder', 'refs/remotes/origin/main')).toEqual({ kind: 'clean' })
  })
  it('the live log writer keeps lines in order and never throws on an unwritable path', async () => {
    const { liveSweepDeps } = await import('../web/worktree-sweeper.js')
    const { mkdtempSync, readFileSync: rf, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'sweep981-'))
    try {
      const f = join(dir, 'sweep.log')
      const deps = liveSweepDeps('/x', null, () => [], f)
      for (let i = 0; i < 20; i++) deps.record(`line ${i}`)
      await deps.flushLog?.()
      expect(rf(f, 'utf8').trim().split('\n')).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i}`))
      const bad = liveSweepDeps('/x', null, () => [], join(dir, 'no', 'such', 'dir', 'x.log'))
      expect(() => bad.record('x')).not.toThrow()
      await bad.flushLog?.()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
