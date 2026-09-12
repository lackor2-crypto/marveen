// The no-live-tree-commit guard blocks a direct `git commit` / `git add` in the
// live checkout root, but must FAIL OPEN everywhere else -- an online agent may
// never sit idle because a gate misfired. Boss, 2026-09-12: "sohasem dolgozunk
// kozvetlenul az elo tree ben!"
//
// Setup builds a throwaway git repo with a .worktrees/ worktree (the shape of
// this fleet host) and drives the hook with crafted PreToolUse payloads.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'no-live-tree-commit.py')

function runHook(payload: unknown, env: Record<string, string> = {}) {
  return spawnSync('python3', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r
}

let liveRoot = ''
let worktree = ''
let plainRoot = ''

beforeAll(() => {
  // A worktree-based fleet host: repo root + .worktrees/<wt>.
  liveRoot = mkdtempSync(join(tmpdir(), 'nolt-live-'))
  git(liveRoot, 'init', '-b', 'main')
  git(liveRoot, 'commit', '--allow-empty', '-m', 'root')
  mkdirSync(join(liveRoot, '.worktrees'), { recursive: true })
  git(liveRoot, 'worktree', 'add', join(liveRoot, '.worktrees', 'wt'))
  worktree = join(liveRoot, '.worktrees', 'wt')

  // A plain, single-checkout install (no .worktrees) -- must fail open.
  plainRoot = mkdtempSync(join(tmpdir(), 'nolt-plain-'))
  git(plainRoot, 'init', '-b', 'main')
  git(plainRoot, 'commit', '--allow-empty', '-m', 'root')
})

afterAll(() => {
  for (const d of [liveRoot, plainRoot]) if (d) rmSync(d, { recursive: true, force: true })
})

describe('no-live-tree-commit guard', () => {
  it('BLOCKS a direct git commit in the live checkout root (exit 2)', () => {
    const r = runHook({ tool_name: 'Bash', cwd: liveRoot, tool_input: { command: 'git commit -m x' } })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('agent-worktree.sh')
  })

  it('BLOCKS a direct git add in the live checkout root (exit 2)', () => {
    const r = runHook({ tool_name: 'Bash', cwd: liveRoot, tool_input: { command: 'git add -A' } })
    expect(r.status).toBe(2)
  })

  it('ALLOWS git commit inside a worktree (exit 0)', () => {
    const r = runHook({ tool_name: 'Bash', cwd: worktree, tool_input: { command: 'git commit -m x' } })
    expect(r.status).toBe(0)
  })

  it('ALLOWS a non-write git command in the live root (git log)', () => {
    const r = runHook({ tool_name: 'Bash', cwd: liveRoot, tool_input: { command: 'git log --oneline -1' } })
    expect(r.status).toBe(0)
  })

  it('ALLOWS a non-git command in the live root', () => {
    const r = runHook({ tool_name: 'Bash', cwd: liveRoot, tool_input: { command: 'echo commit add' } })
    expect(r.status).toBe(0)
  })

  it('FAILS OPEN when the command cd-s elsewhere (ambiguous target)', () => {
    const r = runHook({ tool_name: 'Bash', cwd: liveRoot, tool_input: { command: 'cd .worktrees/wt && git commit -m x' } })
    expect(r.status).toBe(0)
  })

  it('FAILS OPEN when the command uses git -C <path>', () => {
    const r = runHook({ tool_name: 'Bash', cwd: liveRoot, tool_input: { command: 'git -C .worktrees/wt commit -m x' } })
    expect(r.status).toBe(0)
  })

  it('FAILS OPEN on a plain single-checkout install (no .worktrees)', () => {
    const r = runHook({ tool_name: 'Bash', cwd: plainRoot, tool_input: { command: 'git commit -m x' } })
    expect(r.status).toBe(0)
  })

  it('is disabled by MARVEEN_NO_LIVE_TREE_GATE=0', () => {
    const r = runHook(
      { tool_name: 'Bash', cwd: liveRoot, tool_input: { command: 'git commit -m x' } },
      { MARVEEN_NO_LIVE_TREE_GATE: '0' },
    )
    expect(r.status).toBe(0)
  })

  it('ignores non-Bash tools', () => {
    const r = runHook({ tool_name: 'Edit', cwd: liveRoot, tool_input: { file_path: 'x' } })
    expect(r.status).toBe(0)
  })
})
