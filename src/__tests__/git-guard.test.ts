// HAROMSZINTU GIT-VEDELEM.
//
// Amit itt biztosra kell tudni:
//   - a repon BELUL nem irunk, de a tiltas SOSE nema: az uzenet megmondja,
//     mit tegyen helyette (szerkeszto -> commit -> push),
//   - magat a repo-mappat SZABAD torolni -- de csak azutan, hogy megmertuk,
//     elveszne-e vele el nem kuldott munka,
//   - egy depon KIVULI `.git` nem tehet ora ala egy fa-agat.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-gitguard-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-gstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { repoAt, repoStatus, deleteRepo, writeBlockReason } = await import('../git-guard.js')

const REPO = join(depot, 'GIT_REPOS', 'proba')

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

beforeEach(() => {
  rmSync(join(depot, 'GIT_REPOS'), { recursive: true, force: true })
  mkdirSync(join(REPO, 'src'), { recursive: true })
  writeFileSync(join(REPO, 'src', 'a.ts'), 'x', 'utf8')
  git(REPO, 'init', '-q', '-b', 'main')
  git(REPO, 'add', '-A')
  git(REPO, 'commit', '-qm', 'elso')
})

describe('repoAt', () => {
  it('megtalalja a repo gyokeret a repon belulrol is', () => {
    expect(repoAt('GIT_REPOS/proba')).toMatchObject({ rel: 'GIT_REPOS/proba', isRoot: true })
    expect(repoAt('GIT_REPOS/proba/src/a.ts')).toMatchObject({ rel: 'GIT_REPOS/proba', isRoot: false })
  })

  it('a repon kivuli tetelre nem mond igent', () => {
    mkdirSync(join(depot, 'Iratok'), { recursive: true })
    expect(repoAt('Iratok')).toBeNull()
  })
})

describe('writeBlockReason', () => {
  it('a repon BELULI fajlt vedi, es megmondja, mit tegyen helyette', () => {
    const msg = writeBlockReason('GIT_REPOS/proba/src/a.ts')
    expect(msg).not.toBe('')
    // A lenyeg: nem csak tiltunk, hanem utat mutatunk.
    expect(msg).toContain('commit')
    expect(msg).toContain('GIT_REPOS/proba')
  })

  it('magat a repo-mappat NEM tiltja -- azt torolni/mozgatni szabad', () => {
    expect(writeBlockReason('GIT_REPOS/proba')).toBe('')
  })

  it('a fa tobbi reszehez hozza sem nyul', () => {
    mkdirSync(join(depot, 'Iratok'), { recursive: true })
    expect(writeBlockReason('Iratok')).toBe('')
  })
})

describe('repoStatus', () => {
  it('tavoli ag nelkul NEM mondja biztonsagosnak', async () => {
    const st = await repoStatus('GIT_REPOS/proba')
    expect(st.isRepo).toBe(true)
    expect(st.safe).toBe(false)
    expect(st.sentence).toContain('elveszik')
  })

  it('szamolja a nem kommitolt fajlokat', async () => {
    writeFileSync(join(REPO, 'src', 'b.ts'), 'y', 'utf8')
    const st = await repoStatus('GIT_REPOS/proba')
    expect(st.dirty).toBe(1)
    expect(st.safe).toBe(false)
  })

  it('feltoltott allapotban nyugodtan torolhetonek mondja', async () => {
    // Egy helyi "tavoli" repo: pontosan az az eset, amikor minden fent van.
    const remote = join(depot, 'tavoli.git')
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' })
    git(REPO, 'remote', 'add', 'origin', remote)
    git(REPO, 'push', '-q', '-u', 'origin', 'main')
    const st = await repoStatus('GIT_REPOS/proba')
    expect(st.hasUpstream).toBe(true)
    expect(st.ahead).toBe(0)
    expect(st.safe).toBe(true)
    expect(st.sentence).toContain('Nyugodtan')
  })

  it('a fel nem toltott commitokat megszamolja', async () => {
    const remote = join(depot, 'tavoli2.git')
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' })
    git(REPO, 'remote', 'add', 'origin', remote)
    git(REPO, 'push', '-q', '-u', 'origin', 'main')
    writeFileSync(join(REPO, 'src', 'c.ts'), 'z', 'utf8')
    git(REPO, 'add', '-A')
    git(REPO, 'commit', '-qm', 'masodik')
    const st = await repoStatus('GIT_REPOS/proba')
    expect(st.ahead).toBe(1)
    expect(st.safe).toBe(false)
    expect(st.sentence).toContain('1 commit')
  })
})

describe('deleteRepo', () => {
  it('nem torol elore, ha munka veszne el -- eloszor kimondja', async () => {
    const r = await deleteRepo('GIT_REPOS/proba')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('unsafe')
    expect(existsSync(REPO)).toBe(true)
  })

  it('kifejezett megerositesre torol', async () => {
    const r = await deleteRepo('GIT_REPOS/proba', { force: true })
    expect(r.ok).toBe(true)
    expect(existsSync(REPO)).toBe(false)
  })

  it('a repon BELULRE mutatva nem torol, hanem a gyokeret mondja meg', async () => {
    const r = await deleteRepo('GIT_REPOS/proba/src', { force: true })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('not_root')
    expect(r.message).toContain('GIT_REPOS/proba')
    expect(existsSync(REPO)).toBe(true)
  })

  it('nem git-mappat sose torol', async () => {
    mkdirSync(join(depot, 'Iratok'), { recursive: true })
    const r = await deleteRepo('Iratok', { force: true })
    expect(r.ok).toBe(false)
    expect(existsSync(join(depot, 'Iratok'))).toBe(true)
  })
})
