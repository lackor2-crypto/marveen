// Kanban #442: the nightly test-guard reported 814/814 test files red with
// zero tests run (2026-09-29). It created its throwaway worktree with
// `mktemp -d ${TMPDIR:-/tmp}/...`, and the suite's setup
// (setup/assert-not-live-install.ts) refuses to run from transient storage.
// Every file "failed" in setup, so the guard raised a false red about main.
// This locks the worktree location to the repo's own git-ignored .worktrees/.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TMP_ROOT_PREFIXES } from '../web/tmp-root-prefixes.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'test-guard.sh'), 'utf8')
const GITIGNORE = readFileSync(join(ROOT, '.gitignore'), 'utf8')

describe('test-guard.sh worktree location', () => {
  const worktreeLine = SCRIPT.split('\n').find((l) => /^\s*WORKTREE=/.test(l)) ?? ''

  it('creates the worktree under the repo .worktrees/ directory', () => {
    expect(worktreeLine).toMatch(/\$BASE\/\.worktrees\//)
  })

  it('never roots the worktree in TMPDIR or a transient prefix', () => {
    expect(worktreeLine).not.toMatch(/TMPDIR/)
    for (const prefix of TMP_ROOT_PREFIXES) expect(worktreeLine).not.toContain(prefix)
  })

  it('.worktrees/ is git-ignored so the throwaway checkout never dirties the tree', () => {
    expect(GITIGNORE.split('\n').map((l) => l.trim())).toContain('.worktrees/')
  })

  it('hands the live main-agent config dir to the suite (the worktree cannot resolve it)', () => {
    expect(SCRIPT).toMatch(/MARVEEN_LIVE_MAIN_CONFIG_DIR="\$LIVE_MAIN_CONFIG_DIR" npx vitest run/)
    expect(SCRIPT).toContain('mainAgentEffectiveConfigDir()')
  })
})
