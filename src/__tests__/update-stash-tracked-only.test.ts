import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Upstream #2835: update.sh's auto-stash (the dashboard's "update, stashed" button) used `git stash push -u`, so
// every untracked file went into the stash as a blob and stayed behind as an unreachable object after the pop: an
// install with a large untracked folder (a local model, a dataset) grew .git/objects by its full size on every
// update. The guard above the stash never looks at untracked files and a fast-forward leaves them alone, so the
// stash holds tracked changes only.
const SRC = readFileSync(join(__dirname, '..', '..', 'update.sh'), 'utf-8')
const code = SRC.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
const STASH_PUSH = /git stash push\b[^\n]*/g
const includesUntracked = (cmd: string) => /\s(-u|-[a-zA-Z]*u[a-zA-Z]*|--include-untracked|-a|--all)(\s|$)/.test(cmd)

describe('update.sh auto-stash stores tracked changes only', () => {
  it('the matcher bites: a `-u` / `--include-untracked` stash would be caught (positive control)', () => {
    expect(includesUntracked('git stash push -u -m "x"')).toBe(true)
    expect(includesUntracked('git stash push --include-untracked -m "x"')).toBe(true)
    expect(includesUntracked('git stash push -m "x"')).toBe(false)
  })

  it('every `git stash push` in update.sh leaves untracked files out', () => {
    const cmds = code.match(STASH_PUSH) ?? []
    expect(cmds.length).toBeGreaterThan(0)
    for (const c of cmds) expect(includesUntracked(c), c).toBe(false)
  })
})
