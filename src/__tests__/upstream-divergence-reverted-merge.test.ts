// A mert "tisztan athuzhato" halmaz a MOSTANI agunkhoz merve (kanban #375).
// Visszavont upstream-behuzas utan a script a behuzas ELOTTI regi commitot
// fesulte ossze az upstreammel: egy fajl, amit AZOTA mi is modositottunk,
// "tisztan athuzhatonak" latszott. Merve 2026-09-24: 76 helyett 100 utkozes.
// Ez a teszt egy valodi, eldobhato git-repoban jatssza le az esetet.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const SCRIPT = resolve(__dirname, '../../scripts/upstream-divergence-check.sh')
let root: string

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'uds-revert-'))
  const up = join(root, 'up')
  const fork = join(root, 'fork')
  mkdirSync(up)
  git(up, 'init', '-q', '-b', 'main')
  writeFileSync(join(up, 'a.txt'), 'line1\nline2\nline3\n')
  writeFileSync(join(up, 'b.txt'), 'b1\n')
  git(up, 'add', '.'); git(up, 'commit', '-q', '-m', 'base')
  git(root, 'clone', '-q', up, fork)
  git(fork, 'remote', 'rename', 'origin', 'upstream')
  // Upstream valtoztat a.txt-n.
  writeFileSync(join(up, 'a.txt'), 'line1\nUPSTREAM\nline3\n')
  git(up, 'commit', '-q', '-am', 'upstream a')
  git(fork, 'fetch', '-q', 'upstream')
  // A fork behuzza, majd visszavonja a behuzast.
  git(fork, 'merge', '-q', '--no-ff', '--no-edit', 'upstream/main')
  git(fork, 'revert', '--no-edit', '-m', '1', 'HEAD')
  // Azota MI IS modositjuk ugyanazt a sort -> valodi utkozes.
  writeFileSync(join(fork, 'a.txt'), 'line1\nOURS\nline3\n')
  git(fork, 'commit', '-q', '-am', 'ours a')
  // Upstream meg egyet lep egy masik fajlon (az tenyleg tiszta).
  writeFileSync(join(up, 'b.txt'), 'b2\n')
  git(up, 'commit', '-q', '-am', 'upstream b')
  mkdirSync(join(fork, 'scripts'))
  mkdirSync(join(fork, 'store'))
  copyFileSync(SCRIPT, join(fork, 'scripts', 'upstream-divergence-check.sh'))
  execFileSync('bash', ['scripts/upstream-divergence-check.sh', 'manual'], { cwd: fork, encoding: 'utf8', timeout: 60_000 })
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('upstream-meres visszavont behuzas utan', () => {
  it('a mostani agunkhoz mer: az azota altalunk is modositott fajl UTKOZIK', () => {
    const out = JSON.parse(readFileSync(join(root, 'fork', 'store', 'upstream-sync-status.json'), 'utf8'))
    expect(out.revertedMerge).toBeTruthy()
    expect(out.conflictingFiles).toEqual(['a.txt'])
    expect(out.conflictCount).toBe(1)
    expect(out.cleanFileCount).toBe(1)
  })
})
