// Kanban #384 (Boss, 2026-09-25, TG 1454): "maskor ne hagyj ott az ilyeneket.
// ha keszen vagy akkor torlesnek automatikusnak kellene lennie. minden
// agentnel." -- after a verified merge, land-pr.sh removes the worktree it was
// run from. These tests drive the real cleanup script against real git
// worktrees: the promise is "removes a landed, clean worktree; NEVER one that
// still holds work", and only a real `git worktree` can show both halves.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(__dirname, '..', '..', 'scripts')
const CLEANUP = join(SCRIPTS, 'land-pr-worktree-cleanup.sh')

let root = ''
let main = ''
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function makeWorktree(name: string, where = join(main, '.worktrees')): { dir: string; sha: string } {
  mkdirSync(where, { recursive: true })
  const dir = join(where, name)
  git(main, 'worktree', 'add', '-q', '-b', `work/${name}`, dir)
  writeFileSync(join(dir, `${name}.txt`), 'munka\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', name)
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') }
}

function cleanup(cwd: string, sha: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [CLEANUP, sha], { cwd, encoding: 'utf8', env: { ...process.env, MARVEEN_WORKTREE_ROOT: '', ...env } })
  return { code: r.status, err: r.stderr }
}

const hasBranch = (b: string) => spawnSync('git', ['-C', main, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`]).status === 0

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'marveen-wtclean-')))
  main = join(root, 'repo')
  mkdirSync(main)
  execFileSync('git', ['-C', main, 'init', '-q', '-b', 'main'])
  git(main, 'config', 'user.email', 'test@example.invalid')
  git(main, 'config', 'user.name', 'test')
  writeFileSync(join(main, 'a.txt'), 'a\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'init')
})

afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

describe('land-pr-worktree-cleanup.sh -- a landolt, tiszta worktree eltunik', () => {
  it('tiszta worktree + a felnyomott HEAD: a worktree ES a lokalis branch torlodik', () => {
    const { dir, sha } = makeWorktree('agens-1')
    const r = cleanup(dir, sha)
    expect(r.code).toBe(0)
    expect(existsSync(dir)).toBe(false)
    expect(hasBranch('work/agens-1')).toBe(false)
    expect(git(main, 'worktree', 'list')).not.toContain('agens-1')
    expect(r.err).toContain('torolve')
  })

  it('a node_modules symlink nem szamit munkanak, es a cel-mappa NEM torlodik vele', () => {
    const shared = join(root, 'shared-node-modules')
    mkdirSync(shared)
    writeFileSync(join(shared, 'pkg.js'), 'x')
    const { dir, sha } = makeWorktree('agens-2')
    symlinkSync(shared, join(dir, 'node_modules'), 'dir')
    expect(cleanup(dir, sha).code).toBe(0)
    expect(existsSync(dir)).toBe(false)
    expect(readFileSync(join(shared, 'pkg.js'), 'utf8')).toBe('x')
  })

  it('a MARVEEN_WORKTREE_ROOT alatti worktree-t is felismeri', () => {
    const alt = join(root, 'alt-root')
    const { dir, sha } = makeWorktree('agens-3', alt)
    expect(cleanup(dir, sha, { MARVEEN_WORKTREE_ROOT: alt }).code).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('land-pr-worktree-cleanup.sh -- munkat SOHA nem dob el', () => {
  it('commitolatlan modositas: marad, es kimondja miert', () => {
    const { dir, sha } = makeWorktree('piszkos')
    writeFileSync(join(dir, 'a.txt'), 'felkesz\n')
    const r = cleanup(dir, sha)
    expect(r.code).toBe(0)
    expect(existsSync(join(dir, 'a.txt'))).toBe(true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('felkesz\n')
    expect(hasBranch('work/piszkos')).toBe(true)
    expect(r.err).toContain('NEM toroltem')
    expect(r.err).toContain('commitolatlan')
  })

  it('nem-kovetett uj fajl: marad', () => {
    const { dir, sha } = makeWorktree('ujfajl')
    writeFileSync(join(dir, 'uj.txt'), 'meg nincs commitolva\n')
    const r = cleanup(dir, sha)
    expect(existsSync(join(dir, 'uj.txt'))).toBe(true)
    expect(r.err).toContain('NEM toroltem')
  })

  it('a CI-varas alatt uj commit jott: marad (a HEAD mar nem a landolt)', () => {
    const { dir, sha } = makeWorktree('ujcommit')
    writeFileSync(join(dir, 'b.txt'), 'kesobbi\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'kesobbi')
    const r = cleanup(dir, sha)
    expect(existsSync(dir)).toBe(true)
    expect(r.err).toContain('HEAD elmozdult')
  })

  it('a fo checkoutot sosem torli', () => {
    const sha = git(main, 'rev-parse', 'HEAD')
    const r = cleanup(main, sha)
    expect(existsSync(join(main, 'a.txt'))).toBe(true)
    expect(r.err).toContain('fo checkoutot')
  })

  it('a worktree-gyokeren kivuli worktree-t nem torli', () => {
    const { dir, sha } = makeWorktree('idegen', join(root, 'mashol'))
    const r = cleanup(dir, sha)
    expect(existsSync(dir)).toBe(true)
    expect(r.err).toContain('NEM toroltem')
  })

  it('felnyomott commit nelkul nem csinal semmit', () => {
    const { dir } = makeWorktree('nosha')
    const r = cleanup(dir, '')
    expect(existsSync(dir)).toBe(true)
    expect(r.code).toBe(0)
  })
})

describe('land-pr.sh bekotes', () => {
  const landPr = readFileSync(join(SCRIPTS, 'land-pr.sh'), 'utf8')

  it('a takaritas a MERGE-ELVE utan fut, es csak visszaolvasott MERGED allapotnal', () => {
    const merged = landPr.indexOf('echo "land-pr: MERGE-ELVE.')
    const call = landPr.indexOf('land-pr-worktree-cleanup.sh" "$PUSHED_SHA"')
    expect(merged).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(merged)
    expect(landPr).toMatch(/\[ "\$state_rc" -eq 0 \] && \[ "\$pr_state" = "MERGED" \] && MERGED_CONFIRMED=1/)
    expect(landPr).toMatch(/if \[ "\$MERGED_CONFIRMED" != "1" \]; then/)
  })

  it('van kikapcsolo, es a fejlec dokumentalja', () => {
    expect(landPr).toContain('LAND_PR_KEEP_WORKTREE')
    expect(landPr.split('\n').slice(0, 40).join('\n')).toContain('LAND_PR_KEEP_WORKTREE')
  })
})
