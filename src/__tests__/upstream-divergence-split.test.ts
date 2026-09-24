// A "tisztan athuzhato" szam szetbontasa (kanban #375). A behuzas utan a doboz
// tovabbra is 723-at mutatott, mert a szam a nalunk MAR ugyanolyan fajlokat es
// a dontessel kihagyottakat is beleszamolta. Ez a teszt egy eldobhato git-repoban
// meri meg: behuzva / szandekosan kihagyva / meg hatra, es a kihagyas-lista
// hibaallapotait (hianyzik = 0, olvashatatlan = hiba, nem nulla).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const SCRIPT = resolve(__dirname, '../../scripts/upstream-divergence-check.sh')
let root: string
let fork: string
let up: string

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

const blob = (ref: string, path: string): string => git(fork, 'rev-parse', `${ref}:${path}`)

const measure = (skipList: string | null): Record<string, unknown> => {
  const list = join(fork, 'governance', 'upstream-skipped-files.json')
  rmSync(list, { force: true })
  if (skipList !== null) writeFileSync(list, skipList)
  execFileSync('bash', ['scripts/upstream-divergence-check.sh', 'manual'], { cwd: fork, encoding: 'utf8', timeout: 60_000 })
  return JSON.parse(readFileSync(join(fork, 'store', 'upstream-sync-status.json'), 'utf8'))
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'uds-split-'))
  up = join(root, 'up')
  fork = join(root, 'fork')
  mkdirSync(up)
  git(up, 'init', '-q', '-b', 'main')
  for (const f of ['conf.txt', 'same.txt', 'skip.txt', 'defer.txt', 'left.txt']) writeFileSync(join(up, f), `${f} base\n`)
  git(up, 'add', '.'); git(up, 'commit', '-q', '-m', 'base')
  git(root, 'clone', '-q', up, fork)
  git(fork, 'remote', 'rename', 'origin', 'upstream')
  // Upstream mind az ot fajlt megvaltoztatja.
  for (const f of ['conf.txt', 'same.txt', 'skip.txt', 'defer.txt', 'left.txt']) writeFileSync(join(up, f), `${f} UPSTREAM\n`)
  git(up, 'commit', '-q', '-am', 'upstream all')
  git(fork, 'fetch', '-q', 'upstream')
  // Mi: conf.txt-t masra irjuk (utkozes), same.txt-t pontosan behuzzuk.
  writeFileSync(join(fork, 'conf.txt'), 'conf.txt OURS\n')
  writeFileSync(join(fork, 'same.txt'), 'same.txt UPSTREAM\n')
  git(fork, 'commit', '-q', '-am', 'ours')
  mkdirSync(join(fork, 'scripts'))
  mkdirSync(join(fork, 'store'))
  mkdirSync(join(fork, 'governance'))
  copyFileSync(SCRIPT, join(fork, 'scripts', 'upstream-divergence-check.sh'))
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('upstream-meres: a tiszta szam szetbontasa (#375)', () => {
  it('friss telepites (nincs lista): 0 kihagyott, nem hiba; a behuzott fajl nem szamit hatralevonek', () => {
    const out = measure(null)
    expect(out.conflictCount).toBe(1)
    expect(out.absorbedCount).toBe(1)
    expect(out.skippedCount).toBe(0)
    expect(out.skippedDeferredCount).toBe(0)
    expect(out.skipListError).toBeNull()
    expect(out.cleanFileCount).toBe(3)
  })

  it('egyezo blobbal a listan allo fajl kihagyottnak szamit, a halasztott kulon is', () => {
    const out = measure(JSON.stringify({ files: {
      'skip.txt': { blob: blob('upstream/main', 'skip.txt'), kind: 'decided' },
      'defer.txt': { blob: blob('upstream/main', 'defer.txt'), kind: 'deferred' },
    } }))
    expect(out.absorbedCount).toBe(1)
    expect(out.skippedCount).toBe(2)
    expect(out.skippedDeferredCount).toBe(1)
    expect(out.cleanFileCount).toBe(1)
  })

  it('ha az upstream azota ujra modositotta a fajlt, a regi dontes nem ervenyes: visszakerul a hatralevok koze', () => {
    const out = measure(JSON.stringify({ files: {
      'skip.txt': { blob: blob('upstream/main~1', 'skip.txt'), kind: 'decided' },
    } }))
    expect(out.skippedCount).toBe(0)
    expect(out.cleanFileCount).toBe(3)
  })

  it('olvashatatlan lista: kimondott hiba, a szetbontott mezok null-ok (nem 0)', () => {
    const out = measure('{ ez nem json')
    expect(typeof out.skipListError).toBe('string')
    expect(out.skipListError).toContain('upstream-skipped-files.json')
    expect(out.absorbedCount).toBeNull()
    expect(out.skippedCount).toBeNull()
    expect(out.skippedDeferredCount).toBeNull()
    // A szetbontas nelkuli, regi ertelmu szam: minden nem utkozo fajl.
    expect(out.cleanFileCount).toBe(4)
  })
})
