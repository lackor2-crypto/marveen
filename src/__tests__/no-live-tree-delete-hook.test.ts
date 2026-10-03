// The no-live-tree-delete guard stops ANY destructive command that reaches the LIVE checkout. Incident
// (2026-10-03 02:28): `cd <worktree> && ...; rm -rf store/<db>*` -- the cd failed, the rm ran in the live
// root. It must still FAIL OPEN everywhere else (a gate never idles an online agent).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK = join(__dirname, '..', '..', 'scripts', 'hooks', 'no-live-tree-delete.py')

function runHook(payload: unknown, env: Record<string, string> = {}) {
  return spawnSync('python3', [HOOK], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, ...env } })
}
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}
const bash = (cwd: string, command: string) => ({ tool_name: 'Bash', cwd, tool_input: { command } })

let live = ''
let wt = ''
let plain = ''
beforeAll(() => {
  live = mkdtempSync(join(tmpdir(), 'nltd-live-'))
  git(live, 'init', '-b', 'main')
  git(live, 'commit', '--allow-empty', '-m', 'root')
  mkdirSync(join(live, '.worktrees'), { recursive: true })
  git(live, 'worktree', 'add', join(live, '.worktrees', 'wt'))
  wt = join(live, '.worktrees', 'wt')
  plain = mkdtempSync(join(tmpdir(), 'nltd-plain-'))
  git(plain, 'init', '-b', 'main')
  git(plain, 'commit', '--allow-empty', '-m', 'root')
})
afterAll(() => { for (const d of [live, plain]) if (d) rmSync(d, { recursive: true, force: true }) })

describe('no-live-tree-delete guard', () => {
  it('blocks the incident chain: cd fails, rm of a relative path runs in the live root', () => {
    const r = runHook(bash(live, 'cd /nope/missing && echo x; rm -rf store/some.db*'))
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('no-live-tree-delete')
  })
  it('blocks rm, unlink, mv, truncate, find -delete, git clean on live files, bare dir names too', () => {
    for (const c of ['rm -rf src', 'rm -f src/index.ts', 'unlink web/app.js', 'mv web/app.js /tmp/x', 'truncate -s 0 src/db.ts', 'find src -name "*.ts" -delete', 'git clean -fd']) {
      expect(runHook(bash(live, c)).status, c).toBe(2)
    }
  })
  it('blocks an absolute live path from anywhere, including from a worktree', () => {
    expect(runHook(bash(wt, `rm -rf ${join(live, 'src')}`)).status).toBe(2)
    expect(runHook(bash('/tmp', `rm ${join(live, 'web', 'app.js')}`)).status).toBe(0) // cwd /tmp is not a repo: fail open
  })
  it('allows the disposable places and a worktree', () => {
    for (const c of ['rm -rf store/tmp/restore-stage-x', 'rm -rf node_modules', 'rm -rf dist', 'rm -rf agents/x/tmp', `rm -rf ${join(wt, 'src')}`]) {
      expect(runHook(bash(live, c)).status, c).toBe(0)
    }
    expect(runHook(bash(wt, 'rm -rf src/foo')).status).toBe(0)
    expect(runHook(bash(live, `rm -rf ${join(live, '.worktrees', 'gone')}`)).status).toBe(0)
  })
  it('allows deleting outside the live tree, even from the live cwd', () => {
    expect(runHook(bash(live, 'rm -rf /tmp/something')).status).toBe(0)
    expect(runHook(bash(live, 'rm -f /tmp/a.txt')).status).toBe(0)
    // a relative target after a cd is judged against the live cwd too: the cd may fail (the incident)
    expect(runHook(bash(live, 'cd /tmp && rm -f a.txt')).status).toBe(2)
  })
  it('does not mistake other words of the command line for targets', () => {
    expect(runHook(bash(live, 'printf x >> /tmp/n.md; rm -f /tmp/a.txt')).status).toBe(0)
    expect(runHook(bash(live, 'echo src; rm -f /tmp/a.txt')).status).toBe(0)
    expect(runHook(bash(live, 'printf x; rm -f src/a.ts')).status).toBe(2)
  })
  it('ignores commands that do not destroy', () => {
    for (const c of ['ls src', 'cp src/db.ts /tmp/x', 'git status', 'cat web/app.js']) {
      expect(runHook(bash(live, c)).status, c).toBe(0)
    }
  })
  it('fails open: plain single-checkout install, bad payload, other tool, kill switch', () => {
    expect(runHook(bash(plain, 'rm -rf src')).status).toBe(0)
    expect(spawnSync('python3', [HOOK], { input: 'not json', encoding: 'utf-8' }).status).toBe(0)
    expect(runHook({ tool_name: 'Edit', cwd: live, tool_input: { command: 'rm -rf src' } }).status).toBe(0)
    expect(runHook(bash(live, 'rm -rf src'), { MARVEEN_NO_LIVE_TREE_DELETE_GATE: '0' }).status).toBe(0)
  })
})
