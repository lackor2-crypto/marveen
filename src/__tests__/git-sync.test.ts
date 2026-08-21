// AUTOMATIKUS GIT-SZINKRON.
//
// Egyetlen dolgot kell itt biztosra tudni, es az nem az, hogy frissit:
// azt, hogy SOHA nem semmisit meg helyi munkat. Egy elveszett commit
// visszahozhatatlan, egy elavult repo pedig egy gombnyomas.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-gitsync-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-gsstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})

const { findRepos, syncRepo, syncAllRepos, lastSyncRun } = await import('../git-sync.js')

const WORK = join(depot, 'Munka', 'proba')
const REMOTE = join(depot, '.tavoli.git')

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

/** Egy uj commit KOZVETLENUL a tavoli repoba -- mintha masik gepen szuletett volna. */
function commitOnRemote(text: string) {
  const tmp = mkdtempSync(join(tmpdir(), 'marveen-push-'))
  execFileSync('git', ['clone', '-q', '-b', 'main', REMOTE, tmp], { stdio: 'ignore' })
  writeFileSync(join(tmp, 'tavoli.txt'), text, 'utf8')
  git(tmp, 'add', '-A')
  git(tmp, 'commit', '-qm', 'masik gepen')
  git(tmp, 'push', '-q', 'origin', 'HEAD:main')
  rmSync(tmp, { recursive: true, force: true })
}

beforeEach(() => {
  rmSync(join(depot, 'Munka'), { recursive: true, force: true })
  rmSync(REMOTE, { recursive: true, force: true })
  execFileSync('git', ['init', '-q', '--bare', REMOTE], { stdio: 'ignore' })
  mkdirSync(WORK, { recursive: true })
  git(WORK, 'init', '-q', '-b', 'main')
  writeFileSync(join(WORK, 'a.txt'), 'x', 'utf8')
  git(WORK, 'add', '-A')
  git(WORK, 'commit', '-qm', 'elso')
  git(WORK, 'remote', 'add', 'origin', REMOTE)
  git(WORK, 'push', '-q', '-u', 'origin', 'main')
})

describe('findRepos', () => {
  it('megtalalja a repot barhol a faban', () => {
    expect(findRepos()).toContain(WORK)
  })

  it('a repon BELUL nem keresgel tovabb', () => {
    // Egy repoba agyazott mappa nem kulon repo -- ha ide is belepnenk, egy
    // nagy repo bejarasa percekbe kerulne minden korben.
    mkdirSync(join(WORK, 'melyebb', 'meg-melyebb'), { recursive: true })
    expect(findRepos().filter((r) => r.startsWith(WORK))).toEqual([WORK])
  })
})

describe('syncRepo', () => {
  it('naprakesz repot naprakesznek mond', async () => {
    const r = await syncRepo(WORK)
    expect(r.state).toBe('current')
  })

  it('elorelep, ha a tavolin uj commit van', async () => {
    commitOnRemote('uj')
    const r = await syncRepo(WORK)
    expect(r.state).toBe('updated')
    expect(readFileSync(join(WORK, 'tavoli.txt'), 'utf8')).toBe('uj')
  })

  it('MODOSITOTT fajl mellett hozza sem nyul', async () => {
    commitOnRemote('uj')
    writeFileSync(join(WORK, 'a.txt'), 'amin eppen dolgozom', 'utf8')
    const r = await syncRepo(WORK)
    expect(r.state).toBe('skipped')
    // A lenyeg: a helyi munka SERTETLEN.
    expect(readFileSync(join(WORK, 'a.txt'), 'utf8')).toBe('amin eppen dolgozom')
  })

  it('FEL NEM TOLTOTT commit mellett hozza sem nyul', async () => {
    commitOnRemote('uj')
    writeFileSync(join(WORK, 'b.txt'), 'sajat', 'utf8')
    git(WORK, 'add', '-A')
    git(WORK, 'commit', '-qm', 'meg nincs feltoltve')
    const r = await syncRepo(WORK)
    expect(r.state).toBe('skipped')
    expect(r.message).toContain('push')
    // A sajat commit megvan.
    expect(readFileSync(join(WORK, 'b.txt'), 'utf8')).toBe('sajat')
  })

  it('tavoli ag nelkuli repot bekeen hagy', async () => {
    const solo = join(depot, 'Munka', 'maganyos')
    mkdirSync(solo, { recursive: true })
    git(solo, 'init', '-q', '-b', 'main')
    writeFileSync(join(solo, 'c.txt'), 'x', 'utf8')
    git(solo, 'add', '-A')
    git(solo, 'commit', '-qm', 'egy')
    const r = await syncRepo(solo)
    expect(r.state).toBe('skipped')
    expect(r.message).toContain('Nincs távoli ága')
  })
})

describe('syncAllRepos', () => {
  it('vegigmegy a fan, es lemezre irja, mi tortent', async () => {
    commitOnRemote('uj')
    const run = await syncAllRepos()
    expect(run.results.length).toBeGreaterThan(0)
    expect(run.updated).toBe(1)
    // A felulet ebbol dolgozik: ha nem marad meg, minden oldalbetoltesnel
    // ujra kellene futtatni a szinkront, hogy legyen mit mutatni.
    expect(lastSyncRun()?.updated).toBe(1)
  })
})
