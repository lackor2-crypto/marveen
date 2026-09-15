// Kartya 3837120e (#273): a kod-hid Marveen-feladata izolalt worktree-ben fut.
//
// Ez a teszt NEM szoveget egyeztet: egy VALODI, eldobhato git repot hoz letre a
// temp konyvtarban, es azon meri, hogy a resolver tenyleg nyit-e worktree-t,
// tenyleg ujrahasznalja-e, es hogy a NEM-elo-fa projekteket valoban nem
// bantja-e. Igy a teszt akkor is fog, ha valaki a git-hivast lecsereli.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  resolveTaskWorkspace,
  worktreeNameFor,
  reshapeToWorktree,
  rmDirForTests,
} from '../web/code-live-tree-worktree.js'

/** Egy igazi, ures git repo egy commit-tal -- a `git worktree add` HEAD-et kiván. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mv-wt-'))
  const git = (...args: string[]): void => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

let repo: string

beforeAll(() => {
  repo = makeRepo()
})

afterAll(() => {
  rmDirForTests(repo)
})

const task = (id: string, cardRef: string | null): { id: string; cardRef: string | null } => ({ id, cardRef })

describe('worktreeNameFor', () => {
  it('a kartya azonositojabol kepez nevet, es sosem ad ures komponenst', () => {
    expect(worktreeNameFor('3837120e', 'abcdef123456')).toBe('code-3837120e')
    // Kartya nelkul a task id eleje. Ez az, ami miatt egy kartya nelkuli feladat
    // sem futhat az elo faban.
    expect(worktreeNameFor(null, 'abcdef123456')).toBe('code-abcdef12')
    // Csupa tiltott karakter -> NEM ures string, hanem hasznalhato tartalek.
    expect(worktreeNameFor('///', '')).toBe('code-task')
  })

  it('kiszuri azt, ami a git branch-nevben vagy az utvonalban kart tehetne', () => {
    const n = worktreeNameFor('../../etc/passwd', 't')
    expect(n).not.toContain('/')
    expect(n).not.toContain('\\')
    expect(n.startsWith('code-')).toBe(true)
  })
})

describe('reshapeToWorktree -- a bejelentett ut ALAKJA megmarad', () => {
  it('POSIX ut POSIX marad', () => {
    expect(reshapeToWorktree('/home/x/mv', '/home/x/mv', '/home/x/mv/.worktrees/code-1'))
      .toBe('/home/x/mv/.worktrees/code-1')
  })

  it('WSL UNC ut UNC marad -- a worker Windowsrol Test-Path-eli', () => {
    // Ez a sor a lenyeg: ha POSIX utat adnank vissza, a worker `Test-Path`-ja
    // Windowson elbukna, es a feladat "workspace not found"-dal halna meg.
    expect(reshapeToWorktree('\\\\wsl.localhost\\Ubuntu\\home\\x\\mv', '/home/x/mv', '/home/x/mv/.worktrees/code-1'))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\x\\mv\\.worktrees\\code-1')
  })

  it('null, ha a worktree nem a telepites alatt van (nem talalgatunk prefixet)', () => {
    expect(reshapeToWorktree('/home/x/mv', '/home/x/mv', '/var/tmp/elsewhere/code-1')).toBe(null)
  })
})

describe('resolveTaskWorkspace -- a NEM elo fa projekteket nem bantja', () => {
  it('mas mappaban allo session valtozatlanul a sajat mappajaban fut', () => {
    const other = join(repo, 'nem-ez')
    const d = resolveTaskWorkspace(other, task('t1', 'c1'), { liveRoot: repo })
    expect(d.wasLiveTree).toBe(false)
    expect(d.redirected).toBe(false)
    expect(d.workspacePath).toBe(other)
    // Nincs magyarazat, mert nincs mit magyarazni -- nem hiba tortent.
    expect(d.reason).toBe(null)
  })

  it('ures bejelentett ut = "nem tudjuk", es nem irjuk at', () => {
    const d = resolveTaskWorkspace('', task('t2', 'c1'), { liveRoot: repo })
    expect(d.wasLiveTree).toBe(false)
    expect(d.redirected).toBe(false)
  })

  it('leforditthatatlan alak (halozati megosztas) NEM szamit elo fanak', () => {
    // A "nem latok oda" nem ugyanaz, mint a "ez az elo fa". Egy ilyen utat nem
    // irunk at, mert nem tudjuk, mit irnank a helyere.
    const d = resolveTaskWorkspace('\\\\szerver\\megosztas\\mv', task('t3', 'c1'), { liveRoot: repo })
    expect(d.wasLiveTree).toBe(false)
    expect(d.redirected).toBe(false)
  })

  it('a checkout ALMAPPAJA nem esik a hatokorbe', () => {
    const sub = join(repo, 'src')
    mkdirSync(sub, { recursive: true })
    const d = resolveTaskWorkspace(sub, task('t4', 'c1'), { liveRoot: repo })
    expect(d.wasLiveTree).toBe(false)
    expect(d.redirected).toBe(false)
  })
})

describe('resolveTaskWorkspace -- az elo fat izolalt worktree-re csereli', () => {
  it('VALODI worktree-t nyit, es azt adja vissza', () => {
    const d = resolveTaskWorkspace(repo, task('task-aaaa1111', '3837120e'), { liveRoot: repo })

    expect(d.wasLiveTree).toBe(true)
    expect(d.redirected).toBe(true)
    expect(d.reason).toBe(null)
    expect(d.branch).toBe('work/code-3837120e')
    expect(d.createdWorktree).toBe(true)
    expect(d.workspacePath).toBe(join(repo, '.worktrees', 'code-3837120e'))

    // Nem eleg, hogy a fuggveny ezt ALLITJA: legyen is ott, es legyen is
    // worktree (a git maga mondja meg).
    expect(existsSync(d.workspacePath)).toBe(true)
    const list = spawnSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).stdout
    expect(list).toContain(join(repo, '.worktrees', 'code-3837120e'))

    // Es a LENYEG: a visszaadott ut NEM az elo checkout.
    expect(d.workspacePath).not.toBe(repo)
  })

  it('ugyanarra a kartyara masodszor UJRAHASZNALJA (a folytatas lehetsegessege)', () => {
    const d = resolveTaskWorkspace(repo, task('task-bbbb2222', '3837120e'), { liveRoot: repo })
    expect(d.redirected).toBe(true)
    expect(d.workspacePath).toBe(join(repo, '.worktrees', 'code-3837120e'))
    // Ez dönti el, hogy a hivo folytathat-e beszelgetest: letezo worktree-nel
    // igen, frissen nyitottnal nem.
    expect(d.createdWorktree).toBe(false)
  })

  it('MAS kartya MAS worktree-t kap', () => {
    const d = resolveTaskWorkspace(repo, task('task-cccc3333', 'aaaa9999'), { liveRoot: repo })
    expect(d.workspacePath).toBe(join(repo, '.worktrees', 'code-aaaa9999'))
    expect(d.branch).toBe('work/code-aaaa9999')
  })

  it('KARTYA NELKUL is izolal -- a task id-bol kepzett worktree-ben', () => {
    const d = resolveTaskWorkspace(repo, task('deadbeefcafe', null), { liveRoot: repo })
    expect(d.redirected).toBe(true)
    expect(d.workspacePath).toBe(join(repo, '.worktrees', 'code-deadbeef'))
  })
})

describe('resolveTaskWorkspace -- a hiba SOSEM csendes es SOSEM tipp', () => {
  it('ha a git elhasal, az elo utat adja vissza a git SAJAT hibajaval', () => {
    const d = resolveTaskWorkspace(repo, task('task-dddd4444', 'ujkartya'), {
      liveRoot: repo,
      // A valodi git helyett egy olyan, ami pontosan azt mondja, amit egy nem-repo mond.
      run: () => ({ ok: false, stderr: "fatal: not a git repository (or any of the parent directories): .git" }),
      exists: () => false,
    })
    expect(d.redirected).toBe(false)
    expect(d.wasLiveTree).toBe(true)
    // A hivo ebbol tudja, MI a kovetkezo lepes -- ezert a git szo szerinti
    // mondata megy tovabb, nem egy atfogalmazas.
    expect(d.reason).toContain('not a git repository')
    expect(d.workspacePath).toBe(repo)
  })

  it('hibauzenet nelkuli git-bukas eseten sem ad null/ures okot', () => {
    const d = resolveTaskWorkspace(repo, task('task-eeee5555', 'ujkartya2'), {
      liveRoot: repo,
      run: () => ({ ok: false, stderr: '' }),
      exists: () => false,
    })
    expect(d.redirected).toBe(false)
    expect((d.reason ?? '').length).toBeGreaterThan(0)
  })

  it('a telepitesen KIVULI worktree-root eseten megmondja, miert nem tudja', () => {
    const d = resolveTaskWorkspace(repo, task('task-ffff6666', 'kartya'), {
      liveRoot: repo,
      worktreeRoot: join(tmpdir(), 'mv-wt-kivul'),
    })
    expect(d.redirected).toBe(false)
    expect(d.wasLiveTree).toBe(true)
    expect(d.reason).toContain('worktree')
  })
})
