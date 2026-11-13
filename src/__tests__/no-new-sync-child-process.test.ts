// #897: a synchronous child process (execSync / spawnSync / execFileSync) holds the whole dashboard while the child
// runs. On a busy machine a 20 ms git call became a 3.6 s freeze (measured). The existing calls are counted per file
// in governance/sync-child-process-baseline.json; this test goes red when a file gains one or a new file starts
// using them. The number may only go DOWN: when you remove a call, lower the figure in the baseline too.
//
// What to write instead: `execFile` / `spawn` with a callback or a promise (see src/web/code-live-tree-worktree.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const baseline: Record<string, number> = JSON.parse(readFileSync(join(root, 'governance', 'sync-child-process-baseline.json'), 'utf8'))
const RX = /\b(?:execSync|spawnSync|execFileSync)\s*\(/g

function count(): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p); continue }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      const n = (readFileSync(p, 'utf8').match(RX) ?? []).length
      if (n) out[relative(root, p).split('\\').join('/')] = n
    }
  }
  walk(join(root, 'src'))
  return out
}

describe('#897: no NEW synchronous child process on the main thread', () => {
  const now = count()
  it('no file has more of them than the baseline, and no new file starts', () => {
    const grown = Object.entries(now)
      .filter(([f, n]) => n > (baseline[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} (baseline ${baseline[f] ?? 0})`)
    expect(grown, 'a synchronous child process freezes the dashboard while it runs: use execFile/spawn with a promise instead').toEqual([])
  })
  it('the baseline is not stale: a file that got better has its lower figure written down', () => {
    const stale = Object.entries(baseline)
      .filter(([f, n]) => (now[f] ?? 0) < n)
      .map(([f, n]) => `${f}: now ${now[f] ?? 0}, baseline still ${n}`)
    expect(stale, 'lower these figures in governance/sync-child-process-baseline.json').toEqual([])
  })
  it('the files fixed in #897 stay free of them', () => {
    for (const f of ['src/web/code-live-tree-worktree.ts', 'src/web/ui-clickthrough-guard.ts', 'src/backup/create.ts', 'src/machine-pressure.ts', 'src/background-gate.ts']) {
      expect(now[f] ?? 0, f).toBe(0)
    }
  })
})
