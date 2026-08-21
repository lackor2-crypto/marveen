// GIT-FIOK LEVETELE.
//
// Ezt a fajlt egy ELO proba hivta eletre: a torles "ures volt"-ot mondott egy
// olyan fiokra, amiben fel nem toltott munkat tartalmazo repo allt -- mert a
// mappa utjat relativan szamoltam, es igy egy nem letezo helyet mertem meg.
// Minden fiok "uresnek" latszott. Ezert az elso teszt itt az, hogy a NEM ures
// fiokot NEM ures fioknak lassa.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-acc-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-accstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})

const { deleteGitAccount } = await import('../git-accounts.js')
const { DEPOT_PROJECTS } = await import('../depot.js')

const GIT = join(depot, DEPOT_PROJECTS)

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

/** Egy repo a fiok alatt. `remote=true` esetén fel is van tolve valahova. */
function repo(account: string, name: string, remote: boolean) {
  const dir = join(GIT, account, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'x', 'utf8')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'egy')
  if (remote) {
    const bare = join(depot, '.tavoli-' + account + '-' + name + '.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' })
    git(dir, 'remote', 'add', 'origin', bare)
    git(dir, 'push', '-q', '-u', 'origin', 'main')
  }
  return dir
}

beforeEach(() => {
  rmSync(GIT, { recursive: true, force: true })
  mkdirSync(GIT, { recursive: true })
})

describe('deleteGitAccount', () => {
  it('ures fiokot szo nelkul levesz', async () => {
    mkdirSync(join(GIT, 'ures'), { recursive: true })
    const r = await deleteGitAccount('ures')
    expect(r.ok).toBe(true)
    expect(existsSync(join(GIT, 'ures'))).toBe(false)
  })

  it('FEL NEM TOLTOTT munkat force-szal SEM torol', async () => {
    repo('veszelyes', 'sajat', false)
    const r = await deleteGitAccount('veszelyes', { force: true })
    expect(r.ok).toBe(false)
    // A lenyeg nem az uzenet, hanem hogy a munka ott van meg.
    expect(existsSync(join(GIT, 'veszelyes', 'sajat', 'a.txt'))).toBe(true)
  })

  it('feltoltott repo eseten ELOSZOR rakerdez, es nem torol', async () => {
    repo('rendes', 'feltoltve', true)
    const r = await deleteGitAccount('rendes')
    expect(r.ok).toBe(false)
    expect(r.needsConfirm).toBe(true)
    expect(r.repos).toEqual(['feltoltve'])
    expect(existsSync(join(GIT, 'rendes', 'feltoltve'))).toBe(true)
  })

  it('megerositessel torli a feltoltott repot is', async () => {
    repo('rendes2', 'feltoltve', true)
    const r = await deleteGitAccount('rendes2', { force: true })
    expect(r.ok).toBe(true)
    expect(existsSync(join(GIT, 'rendes2'))).toBe(false)
  })

  it('nev nelkul nem csinal semmit', async () => {
    const r = await deleteGitAccount('   ')
    expect(r.ok).toBe(false)
  })
})
