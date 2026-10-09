// PULLING AN ACCOUNT PUTS A NEW REPOSITORY WHERE THE OWNER CHOSE (#518).
//
// A repository lives under its project in the Life tree, not under
// `Rendszer/Tárolók/Git/<account>`. So the pull first only MEASURES: when a
// repository is missing and no folder was chosen, nothing is cloned and the
// answer is a question (`needsDest`). With a folder, the missing ones go there;
// a bad folder (trash, inside another repository, not existing) clones nothing.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-pulldest-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-pulldeststore-'))
const remotes = mkdtempSync(join(tmpdir(), 'marveen-pulldestremote-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})

const { pullGitAccount, checkCloneDest } = await import('../git-accounts.js')
const { DEPOT_PROJECTS } = await import('../depot.js')
const { trashRelPath } = await import('../life-tree.js')

const ACC = 'probafiok'
const DEST = 'Projektek/Proba/Fejlesztés/GIT_REPOS'

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

/** A bare "remote" at `<remotes>/<account>/<name>.git` with one commit; returns its address. */
function remoteRepo(name: string): string {
  const bare = join(remotes, ACC, name + '.git')
  mkdirSync(join(remotes, ACC), { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
  const tmp = mkdtempSync(join(tmpdir(), 'marveen-pulldestseed-'))
  git(tmp, 'init', '-q', '-b', 'main')
  writeFileSync(join(tmp, 'a.txt'), name, 'utf8')
  git(tmp, 'add', '-A')
  git(tmp, 'commit', '-qm', 'egy')
  git(tmp, 'push', '-q', bare, 'main')
  rmSync(tmp, { recursive: true, force: true })
  return bare
}

let remoteList: Array<{ name: string; clone_url: string }> = []

beforeEach(() => {
  for (const n of readdirSync(depot)) rmSync(join(depot, n), { recursive: true, force: true })
  rmSync(join(remotes, ACC), { recursive: true, force: true })
  mkdirSync(join(depot, ...DEST.split('/')), { recursive: true })
  mkdirSync(join(store, 'store'), { recursive: true })
  writeFileSync(join(store, 'store', '.git-tokens.json'),
    JSON.stringify({ [ACC]: { token: 'x', login: ACC, addedAt: '2026-10-09' } }), 'utf8')
  remoteList = [
    { name: 'egyik', clone_url: remoteRepo('egyik') },
    { name: 'masik', clone_url: remoteRepo('masik') },
  ]
  // GitHub is never called: the account's repository list is this one.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(remoteList), { status: 200 })))
})

afterAll(() => {
  vi.unstubAllGlobals()
  for (const d of [depot, store, remotes]) rmSync(d, { recursive: true, force: true })
})

describe('pullGitAccount with a chosen folder', () => {
  it('clones nothing and asks for the folder when repositories are missing', async () => {
    const r = await pullGitAccount(ACC)
    expect(r.ok).toBe(false)
    expect(r.needsDest).toBe(true)
    expect(r.missing).toEqual(['egyik', 'masik'])
    expect(r.cloned).toEqual([])
    expect(readdirSync(join(depot, ...DEST.split('/')))).toEqual([])
    // Nothing is created under the old account folder either.
    expect(existsSync(join(depot, DEPOT_PROJECTS, ACC))).toBe(false)
  })

  it('puts the missing repositories into the chosen Life-tree folder', async () => {
    const r = await pullGitAccount(ACC, { dest: DEST })
    expect(r.ok).toBe(true)
    expect(r.cloned.sort()).toEqual(['egyik', 'masik'])
    expect(r.dest).toBe(DEST)
    expect(existsSync(join(depot, ...DEST.split('/'), 'egyik', '.git'))).toBe(true)
    expect(existsSync(join(depot, ...DEST.split('/'), 'masik', 'a.txt'))).toBe(true)
    expect(existsSync(join(depot, DEPOT_PROJECTS, ACC))).toBe(false)
  })

  it('a second pull finds them in the tree and neither asks nor clones again', async () => {
    await pullGitAccount(ACC, { dest: DEST })
    const r = await pullGitAccount(ACC)
    expect(r.needsDest).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.cloned).toEqual([])
    expect(r.present.sort()).toEqual(['egyik', 'masik'])
  })

  it('only the missing one is cloned when the other already lives elsewhere in the tree', async () => {
    const elsewhere = join(depot, 'Cégek', 'Valami')
    mkdirSync(elsewhere, { recursive: true })
    git(elsewhere, 'clone', '-q', remoteList[0].clone_url, 'egyik')
    const ask = await pullGitAccount(ACC)
    expect(ask.missing).toEqual(['masik'])
    const r = await pullGitAccount(ACC, { dest: DEST })
    expect(r.cloned).toEqual(['masik'])
    expect(existsSync(join(depot, ...DEST.split('/'), 'egyik'))).toBe(false)
  })

  it('never clones into a folder of the same name that is already there', async () => {
    const taken = join(depot, ...DEST.split('/'), 'egyik')
    mkdirSync(taken, { recursive: true })
    writeFileSync(join(taken, 'sajat.txt'), 'az enyem', 'utf8')
    const r = await pullGitAccount(ACC, { dest: DEST })
    expect(r.ok).toBe(false)
    expect(r.cloned).toEqual(['masik'])
    expect(r.failed.map((f) => f.name)).toEqual(['egyik'])
    expect(readdirSync(taken)).toEqual(['sajat.txt'])
  })

  it('refuses the trash, a missing folder and the inside of another repository -- and clones nothing', async () => {
    const trash = trashRelPath()
    mkdirSync(join(depot, trash, 'x'), { recursive: true })
    const inRepo = join(depot, 'Projektek', 'Proba', 'Fejlesztés', 'GIT_REPOS', 'mar-repo')
    mkdirSync(join(inRepo, 'sub'), { recursive: true })
    git(inRepo, 'init', '-q', '-b', 'main')
    for (const bad of [trash + '/x', 'Nincs/Ilyen', DEST + '/mar-repo/sub', '', '../kint']) {
      const chk = checkCloneDest(bad)
      expect(chk.ok, bad).toBe(false)
      if (!bad) continue
      const r = await pullGitAccount(ACC, { dest: bad })
      expect(r.needsDest, bad).toBe(true)
      expect(r.cloned, bad).toEqual([])
      expect(r.message.length, bad).toBeGreaterThan(10)
    }
    expect(existsSync(join(depot, trash, 'x', 'egyik'))).toBe(false)
    expect(existsSync(join(inRepo, 'sub', 'egyik'))).toBe(false)
  })
})
