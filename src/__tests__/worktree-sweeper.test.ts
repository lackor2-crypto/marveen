// #453: the worktree sweeper against a REAL git repo (origin + worktrees), not
// mocks -- the question is exactly what git says about landed vs. not landed.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { liveSweepDeps, pathNamesWorktree, sweepWorktrees, SWEEP_QUIET_MS, type SweepDeps } from '../web/worktree-sweeper.js'

let dir: string
let root: string
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

function commitFile(cwd: string, file: string, body: string, msg: string): void {
  writeFileSync(join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', msg)
}
function addWt(name: string): string {
  const p = join(root, '.worktrees', name)
  git(root, 'worktree', 'add', '-q', '-b', `work/${name}`, p)
  return p
}
const later = (): number => Date.now() + SWEEP_QUIET_MS + 60_000
let log: string[] = []
function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return { ...liveSweepDeps(root, null, () => [], null), now: later, processCwds: () => [], record: (l) => log.push(l), ...over }
}
const branches = (): string[] => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean)

beforeEach(() => {
  log = []
  dir = mkdtempSync(join(tmpdir(), 'wt-sweep-'))
  const origin = join(dir, 'origin.git')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  root = join(dir, 'live')
  git(dir, 'clone', '-q', origin, root)
  git(root, 'checkout', '-q', '-b', 'main')
  commitFile(root, 'a.txt', 'base\n', 'base')
  git(root, 'push', '-q', 'origin', 'main')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('sweepWorktrees', () => {
  it('removes a quiet worktree with no commits, and its branch', async () => {
    const p = addWt('code-empty')
    const r = await sweepWorktrees(deps())
    expect(r.removedWorktrees).toEqual(['code-empty'])
    expect(existsSync(p)).toBe(false)
    expect(branches()).not.toContain('work/code-empty')
    // Every removal is logged with the tip, so it can be brought back.
    const line = log.find((l) => l.includes('branch work/code-empty'))!
    const sha = /vissza: git branch work\/code-empty ([0-9a-f]+)/.exec(line)![1]
    git(root, 'branch', 'work/code-empty', sha)
    expect(branches()).toContain('work/code-empty')
  })

  it('removes a worktree whose commit was squash-landed on origin/main', async () => {
    const p = addWt('code-landed')
    commitFile(p, 'b.txt', 'feature line one\nfeature line two\n', 'feat')
    commitFile(root, 'b.txt', 'feature line one\nfeature line two\n', 'feat (#1)')
    git(root, 'push', '-q', 'origin', 'main')
    git(root, 'fetch', '-q', 'origin')
    const r = await sweepWorktrees(deps())
    expect(r.removedWorktrees).toEqual(['code-landed'])
    expect(branches()).not.toContain('work/code-landed')
  })

  it('KEEPS uncommitted work, unlanded commits, fresh and in-use worktrees', async () => {
    const dirty = addWt('dirty')
    writeFileSync(join(dirty, 'x.txt'), 'half done\n')
    const unl = addWt('unlanded')
    commitFile(unl, 'c.txt', 'only here\n', 'wip')
    const used = addWt('used')
    addWt('busy-card')
    const r = await sweepWorktrees(deps({
      processCwds: () => [join(used, 'src')],
      busyWorkspaces: () => ['\\\\wsl.localhost\\Ubuntu\\x\\.worktrees\\busy-card'],
    }))
    expect(r.removedWorktrees).toEqual([])
    const why = Object.fromEntries(r.kept.map((k) => [k.name, k.why]))
    expect(why['dirty']).toMatch(/commitolatlan/)
    expect(why['unlanded']).toMatch(/nem landolt/)
    expect(why['used']).toMatch(/folyamat/)
    expect(why['busy-card']).toMatch(/kodhid/)

    addWt('fresh')
    const r2 = await sweepWorktrees(deps({ now: () => Date.now(), processCwds: () => [] }))
    expect(r2.removedWorktrees).not.toContain('fresh')
    expect(existsSync(join(root, '.worktrees', 'fresh'))).toBe(true)
  })

  it('removes landed orphan work/* branches, keeps unlanded ones and non-work branches', async () => {
    git(root, 'branch', 'work/orphan-landed')
    git(root, 'checkout', '-q', '-b', 'work/orphan-unlanded')
    commitFile(root, 'd.txt', 'not on main\n', 'wip')
    git(root, 'checkout', '-q', 'main')
    git(root, 'branch', 'feature/keep-me')
    const r = await sweepWorktrees(deps())
    expect(r.removedBranches).toEqual(['work/orphan-landed'])
    expect(branches()).toEqual(expect.arrayContaining(['main', 'work/orphan-unlanded', 'feature/keep-me']))
  })

  // A PR squash-landed, then one more small fix committed on the same branch and
  // never landed: 2 new lines under 40 landed ones are 95% of the whole -- the
  // sum alone called it landed and the fix went with the branch.
  it('KEEPS a landed branch with a small fix committed after the landing, as worktree and as branch', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `landed line ${i}`).join('\n') + '\n'
    const p = addWt('code-tail')
    commitFile(p, 'e.txt', body, 'feat')
    commitFile(root, 'e.txt', body, 'feat (#2)')
    git(root, 'push', '-q', 'origin', 'main')
    git(root, 'fetch', '-q', 'origin')
    commitFile(p, 'e.txt', body + 'follow-up fix one\nfollow-up fix two\n', 'fix after landing')
    git(root, 'branch', 'work/orphan-tail', 'work/code-tail')
    const r = await sweepWorktrees(deps())
    expect(r.removedWorktrees).toEqual([])
    expect(r.removedBranches).toEqual([])
    const why = Object.fromEntries(r.kept.map((k) => [k.name, k.why]))
    expect(why['code-tail']).toMatch(/igazolni/)
    expect(why['work/orphan-tail']).toMatch(/nem landolt/)
    expect(branches()).toEqual(expect.arrayContaining(['work/code-tail', 'work/orphan-tail']))
  })

  it('still removes a branch whose early lines a later commit of its own replaced', async () => {
    git(root, 'checkout', '-q', '-b', 'work/rewritten')
    commitFile(root, 'f.txt', 'first try\n', 'wip')
    commitFile(root, 'f.txt', 'final version\n', 'redo')
    git(root, 'checkout', '-q', 'main')
    commitFile(root, 'f.txt', 'final version\n', 'land (#3)')
    git(root, 'push', '-q', 'origin', 'main')
    git(root, 'fetch', '-q', 'origin')
    const r = await sweepWorktrees(deps())
    expect(r.removedBranches).toEqual(['work/rewritten'])
  })

  // No merge-base (an unrelated history here; a git timeout answers the same):
  // worktreeState reads that as "clean", which must never become a removal.
  it('KEEPS a clean worktree whose commits git cannot place against origin/main', async () => {
    const p = join(root, '.worktrees', 'unrelated')
    git(root, 'worktree', 'add', '-q', '--detach', p)
    git(p, 'checkout', '-q', '--orphan', 'work/unrelated')
    git(p, 'rm', '-rqf', '.')
    commitFile(p, 'g.txt', 'history of its own\n', 'root')
    const r = await sweepWorktrees(deps())
    expect(r.removedWorktrees).toEqual([])
    expect(existsSync(p)).toBe(true)
    expect(branches()).toContain('work/unrelated')
  })

  // A stray local branch called `origin/main` outranks the remote-tracking one
  // in git's lookup; the sweep must judge against the remote, not the stray.
  it('judges against the remote origin/main, not a local branch of the same name', async () => {
    git(root, 'checkout', '-q', '-b', 'work/only-on-stray')
    commitFile(root, 'h.txt', 'never pushed\n', 'wip')
    git(root, 'checkout', '-q', 'main')
    git(root, 'branch', 'origin/main', 'work/only-on-stray')
    const r = await sweepWorktrees(deps())
    expect(r.removedBranches).not.toContain('work/only-on-stray')
    expect(branches()).toContain('work/only-on-stray')
  })

  it('does nothing when origin/main cannot be read (fresh install without a remote)', async () => {
    const solo = join(dir, 'solo')
    git(dir, 'init', '-q', '-b', 'main', solo)
    commitFile(solo, 'a.txt', 'x\n', 'x')
    git(solo, 'worktree', 'add', '-q', '-b', 'work/w', join(solo, '.worktrees', 'w'))
    const r = await sweepWorktrees({ ...liveSweepDeps(solo, null, () => [], null), now: later, processCwds: () => [] })
    expect(r.skipped).toMatch(/origin\/main/)
    expect(existsSync(join(solo, '.worktrees', 'w'))).toBe(true)
  })

  it('does nothing on an install that never made a worktree', async () => {
    const r = await sweepWorktrees(deps())
    expect(r).toMatchObject({ removedWorktrees: [], removedBranches: [], skipped: null })
  })
})

describe('pathNamesWorktree', () => {
  it('matches POSIX and UNC task paths by folder name only', () => {
    expect(pathNamesWorktree('/h/m/.worktrees/code-7', 'code-7')).toBe(true)
    expect(pathNamesWorktree('\\\\wsl.localhost\\U\\m\\.worktrees\\code-7\\src', 'code-7')).toBe(true)
    expect(pathNamesWorktree('code-7', 'code-7')).toBe(true)
    expect(pathNamesWorktree('/h/m/.worktrees/code-70', 'code-7')).toBe(false)
  })
})
