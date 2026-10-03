// The no-live-store-delete guard stops a destructive command on the LIVE claudeclaw.db. The incident
// (2026-10-03 02:28): `cd <worktree> && ...; rm -rf store/claudeclaw.db*` -- the cd failed, the rm ran
// in the live checkout. It must still FAIL OPEN everywhere else (a gate never idles an online agent).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK = join(__dirname, '..', '..', 'scripts', 'hooks', 'no-live-store-delete.py')

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
  live = mkdtempSync(join(tmpdir(), 'nlsd-live-'))
  git(live, 'init', '-b', 'main')
  git(live, 'commit', '--allow-empty', '-m', 'root')
  mkdirSync(join(live, '.worktrees'), { recursive: true })
  git(live, 'worktree', 'add', join(live, '.worktrees', 'wt'))
  wt = join(live, '.worktrees', 'wt')
  plain = mkdtempSync(join(tmpdir(), 'nlsd-plain-'))
  git(plain, 'init', '-b', 'main')
  git(plain, 'commit', '--allow-empty', '-m', 'root')
})
afterAll(() => { for (const d of [live, plain]) if (d) rmSync(d, { recursive: true, force: true }) })

describe('no-live-store-delete guard', () => {
  it('blocks the incident chain: cd fails, rm of a relative db path runs in the live root', () => {
    const r = runHook(bash(live, 'cd /nope/missing && echo x; rm -rf store/claudeclaw.db*'))
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('no-live-store')
  })
  it('blocks a plain relative rm, unlink, mv in the live root', () => {
    for (const c of ['rm -f store/claudeclaw.db', 'unlink store/claudeclaw.db-wal', 'mv store/claudeclaw.db /tmp/x']) {
      expect(runHook(bash(live, c)).status, c).toBe(2)
    }
  })
  it('blocks an absolute path into the live store, from anywhere', () => {
    expect(runHook(bash(wt, `rm -rf ${join(live, 'store')}/claudeclaw.db*`)).status).toBe(2)
  })
  it('allows a worktree test instance database (absolute worktree path, or relative from the worktree)', () => {
    expect(runHook(bash(live, `rm -rf ${join(wt, 'store')}/claudeclaw.db*`)).status).toBe(0)
    expect(runHook(bash(wt, 'rm -rf store/claudeclaw.db*')).status).toBe(0)
  })
  it('ignores commands that do not destroy or do not name the db', () => {
    expect(runHook(bash(live, 'ls store/claudeclaw.db')).status).toBe(0)
    expect(runHook(bash(live, 'cp store/claudeclaw.db /tmp/backup.db')).status).toBe(0)
    expect(runHook(bash(live, 'rm -rf /tmp/something')).status).toBe(0)
  })
  it('fails open: plain single-checkout install, bad payload, other tool, kill switch', () => {
    expect(runHook(bash(plain, 'rm -rf store/claudeclaw.db*')).status).toBe(0)
    expect(spawnSync('python3', [HOOK], { input: 'not json', encoding: 'utf-8' }).status).toBe(0)
    expect(runHook({ tool_name: 'Edit', cwd: live, tool_input: { command: 'rm store/claudeclaw.db' } }).status).toBe(0)
    expect(runHook(bash(live, 'rm -rf store/claudeclaw.db*'), { MARVEEN_NO_LIVE_STORE_GATE: '0' }).status).toBe(0)
  })
})
