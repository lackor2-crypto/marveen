// #366 (722896e9): every agent is told, when it wakes up, about ITS OWN
// half-finished worktrees -- and the unowned ones go to the main agent.
//
// What must hold:
//   - owner from the audit log's file operations/cwd, never from a command that
//     merely mentions a path, never from an unknown agent,
//   - "landed" from content (squash merges leave no ancestry), so a landed
//     branch is silent and an unlanded one is listed,
//   - "could not look" is never "nothing abandoned",
//   - the SessionStart route carries it, and the hook waits long enough.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseWorktreeList, attributeOwners, parseDirtyFiles, addedLinesByFile,
  worktreeState, getAbandonedWorktrees, buildAbandonedWorktreeContext,
  UNOWNED_QUIET_MS, MAX_LISTED, SCAN_BUDGET_MS, withScanBudget, type AbandonedDeps, type WorktreeState,
} from '../web/abandoned-worktrees.js'

const REPO = join(__dirname, '..', '..')

describe('parsing', () => {
  it('worktree list: main checkout and bare entries left out, detached kept', () => {
    const txt = [
      'worktree /r', 'bare', '',
      'worktree /r/live', 'HEAD abc', 'branch refs/heads/main', '',
      'worktree /r/.worktrees/a', 'HEAD def', 'branch refs/heads/work/a', '',
      'worktree /x/claw', 'HEAD 123', 'detached', '',
    ].join('\n')
    expect(parseWorktreeList(txt, '/r/live')).toEqual([
      { path: '/r/.worktrees/a', branch: 'work/a' },
      { path: '/x/claw', branch: null },
    ])
  })

  it('dirty files: rename gives the new path, untracked kept', () => {
    expect(parseDirtyFiles(' M src/a.ts\nR  old.ts -> new.ts\n?? t/x.test.ts\n')).toEqual(['src/a.ts', 'new.ts', 't/x.test.ts'])
  })

  it('added lines per file, blanks and headers skipped', () => {
    const d = ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1 +1,2 @@', '+one', '+   ', '-gone', '+++ /dev/null'].join('\n')
    expect(addedLinesByFile(d).get('f')).toEqual(['one'])
  })
})

describe('attributeOwners', () => {
  const line = (o: Record<string, string>) => JSON.stringify(o)
  const W = '/r/.worktrees/w'
  it('the last KNOWN agent that changed a file inside wins', () => {
    const log = [
      line({ agent: 'alpha', op: 'edit', target: `${W}/src/a.ts`, cwd: '/r/agents/alpha' }),
      line({ agent: 'beta', op: 'write', target: `${W}/src/b.ts`, cwd: '/r/agents/beta' }),
    ].join('\n')
    expect(attributeOwners(log, [W], ['alpha', 'beta']).get(W)).toBe('beta')
  })
  it('a command that only MENTIONS the path does not make an owner', () => {
    const log = line({ agent: 'alpha', op: 'bash', target: `git -C ${W} status`, cwd: '/r/agents/alpha' })
    expect(attributeOwners(log, [W], ['alpha']).get(W)).toBeNull()
  })
  it('a session whose cwd is inside the worktree counts, an unknown agent never does', () => {
    const log = [
      line({ agent: 'alpha', op: 'bash', target: 'npm test', cwd: `${W}/src` }),
      line({ agent: 'w', op: 'edit', target: `${W}/x.ts`, cwd: W }),
    ].join('\n')
    expect(attributeOwners(log, [W], ['alpha']).get(W)).toBe('alpha')
  })
  it('a sibling with a common prefix is not the same worktree', () => {
    const log = line({ agent: 'alpha', op: 'edit', target: `${W}2/x.ts` })
    expect(attributeOwners(log, [W], ['alpha']).get(W)).toBeNull()
  })
})

describe('getAbandonedWorktrees', () => {
  const pending = (lastChangeMs: number): WorktreeState => ({
    kind: 'pending', dirtyFiles: ['a.ts'], dirtyOnMainPct: 0, unlandedCommits: 0, commitsOnMainPct: null, lastChangeMs,
  })
  const NOW = 10 * UNOWNED_QUIET_MS
  const deps = (over: Partial<AbandonedDeps> = {}): AbandonedDeps => ({
    listWorktrees: async () => [
      { path: '/w/mine', branch: 'work/mine' },
      { path: '/w/other', branch: 'work/other' },
      { path: '/w/nobody-old', branch: null },
      { path: '/w/nobody-fresh', branch: null },
      { path: '/w/mine-clean', branch: 'work/c' },
    ],
    readAudit: () => [
      { agent: 'me', op: 'edit', target: '/w/mine/a.ts' },
      { agent: 'me', op: 'edit', target: '/w/mine-clean/a.ts' },
      { agent: 'other', op: 'edit', target: '/w/other/a.ts' },
    ].map((o) => JSON.stringify(o)).join('\n'),
    knownAgents: () => ['main', 'me', 'other'],
    state: async (p) => (p === '/w/mine-clean' ? { kind: 'clean' } : pending(p === '/w/nobody-fresh' ? NOW - 1000 : 0)),
    now: () => NOW,
    ...over,
  })

  it('an agent gets only its own, clean ones stay silent', async () => {
    const r = await getAbandonedWorktrees('me', 'main', deps())
    expect(r.items.map((i) => i.path)).toEqual(['/w/mine'])
    expect(r.unowned).toEqual([])
  })
  it('the main agent also gets the unowned ones, once they have been quiet', async () => {
    const r = await getAbandonedWorktrees('main', 'main', deps())
    expect(r.items).toEqual([])
    expect(r.unowned.map((i) => i.path)).toEqual(['/w/nobody-old'])
  })
  it('git failing is "olvashatatlan", never an empty all-clear', async () => {
    const r = await getAbandonedWorktrees('me', 'main', deps({ state: async () => { throw new Error('x') } }))
    expect(r.olvashatatlan).toBe(true)
    expect(buildAbandonedWorktreeContext(r)).toMatch(/NEM LATTAM ODA/)
  })
  it('one unreadable worktree does not hide the others', async () => {
    const r = await getAbandonedWorktrees('me', 'main', deps({
      listWorktrees: async () => [{ path: '/w/mine', branch: 'a' }, { path: '/w/mine-clean', branch: 'b' }],
      state: async (p) => { if (p === '/w/mine-clean') throw new Error('x'); return pending(0) },
    }))
    expect(r.olvashatatlan).toBe(true)
    expect(r.items.map((i) => i.path)).toEqual(['/w/mine'])
    const txt = buildAbandonedWorktreeContext(r)!
    expect(txt).toContain('/w/mine')
    expect(txt).toMatch(/lehet hianyos/)
  })
  it('a fresh install (no audit log, no worktrees) is a quiet null', async () => {
    const r = await getAbandonedWorktrees('main', 'main', deps({ listWorktrees: async () => [], readAudit: () => '' }))
    expect(r.olvashatatlan).toBe(false)
    expect(buildAbandonedWorktreeContext(r)).toBeNull()
  })
  it('the text names the worktree, tells to finish and to ask before removing, and is capped', async () => {
    const many = Array.from({ length: MAX_LISTED + 3 }, (_, i) => ({ path: `/w/m${i}`, branch: `b${i}` }))
    const r = await getAbandonedWorktrees('me', 'main', deps({
      listWorktrees: async () => many,
      readAudit: () => many.map((w) => JSON.stringify({ agent: 'me', op: 'write', target: `${w.path}/f` })).join('\n'),
    }))
    const txt = buildAbandonedWorktreeContext(r)!
    expect(txt).toContain('/w/m0')
    expect(txt).toContain('land-pr.sh')
    expect(txt).toMatch(/igen-je utan/)
    expect(txt).toContain(`es meg 3`)
  })
})

describe('worktreeState on a real git repository', () => {
  let dir = ''
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'marveen-abandoned-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'a.txt'), 'base line\n')
    git('add', '.'); git('commit', '-qm', 'base')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('a worktree whose folder is gone is not work', async () => {
    expect((await worktreeState(join(dir, 'nope'), 'main')).kind).toBe('clean')
  })
  it('clean and even with main -> clean', async () => {
    expect((await worktreeState(dir, 'main')).kind).toBe('clean')
  })
  it('an uncommitted edit -> pending, with how much of it is on main', async () => {
    writeFileSync(join(dir, 'a.txt'), 'base line\nnew work\n')
    const s = await worktreeState(dir, 'main')
    expect(s.kind).toBe('pending')
    if (s.kind === 'pending') { expect(s.dirtyFiles).toEqual(['a.txt']); expect(s.dirtyOnMainPct).toBe(0) }
    git('checkout', '-q', '--', 'a.txt')
  })
  it('a commit that was squash-landed on main (and touched again there) is silent; an unlanded one is not', async () => {
    git('checkout', '-q', '-b', 'work/x')
    writeFileSync(join(dir, 'b.txt'), 'feature one\nfeature two\n')
    git('add', '.'); git('commit', '-qm', 'feature')
    // "squash merge" onto main, then main edits the same file further.
    git('checkout', '-q', 'main')
    writeFileSync(join(dir, 'b.txt'), 'header\nfeature one\nfeature two\n')
    git('add', '.'); git('commit', '-qm', 'squash of feature + later edit')
    git('checkout', '-q', 'work/x')
    expect((await worktreeState(dir, 'main')).kind).toBe('clean')

    writeFileSync(join(dir, 'c.txt'), 'never landed\n')
    git('add', '.'); git('commit', '-qm', 'more')
    const s = await worktreeState(dir, 'main')
    expect(s.kind).toBe('pending')
    if (s.kind === 'pending') expect(s.unlandedCommits).toBe(2)
  })
})

describe('withScanBudget', () => {
  const ok = { items: [], unowned: [], olvashatatlan: false }
  it('a scan that answers in time is passed through', async () => {
    expect(await withScanBudget(Promise.resolve(ok), 50)).toBe(ok)
  })
  it('a scan that overruns becomes "could not look", never an all-clear', async () => {
    const r = await withScanBudget(new Promise(() => {}), 20)
    expect(r.olvashatatlan).toBe(true)
    expect(buildAbandonedWorktreeContext(r)).toMatch(/NEM LATTAM ODA/)
  })
  it('the budget leaves the hook room for the rest of the answer', () => {
    const hook = readFileSync(join(REPO, 'scripts/hooks/pending-work-replay.py'), 'utf8')
    const wait = Number(/urlopen\(req, timeout=(\d+)\)/.exec(hook)?.[1])
    expect(SCAN_BUDGET_MS).toBeLessThanOrEqual((wait * 1000) / 2)
  })
})

describe('wiring', () => {
  it('the SessionStart pending-work route injects the abandoned worktrees', () => {
    const src = readFileSync(join(REPO, 'src/web/routes/agents.ts'), 'utf8')
    expect(src).toContain('getAbandonedWorktrees(')
    expect(src).toContain('withScanBudget(getAbandonedWorktrees(')
    expect(src).toContain('buildAbandonedWorktreeContext(abandoned)')
  })
  it('the hook waits for the scan, and still ends before the hook timeout', () => {
    const hook = readFileSync(join(REPO, 'scripts/hooks/pending-work-replay.py'), 'utf8')
    const wait = Number(/urlopen\(req, timeout=(\d+)\)/.exec(hook)?.[1])
    const tpl = readFileSync(join(REPO, 'templates/settings.json.template'), 'utf8')
    const hookTimeout = Number(/pending-work-replay\.py[^\n]*\n\s*"timeout": (\d+)/.exec(tpl)?.[1])
    expect(wait).toBeGreaterThanOrEqual(10)
    expect(wait).toBeLessThan(hookTimeout)
  })
})
