// deploy-live.sh -- a landolt kod eljuttatasa a futo apphoz (kanban 3b92bbec).
//
// A bash deploy-orszem git- es dontes-logikajat futtatja eldobhato repokon.
// A build es a restart parancs feluliras alatt all (MARVEEN_DEPLOY_BUILD_CMD /
// _RESTART_CMD), tehat itt npm/systemd NEM fut -- marker-fajlok jelzik, tenyleg
// meghivta-e oket a script. Amit bizonyitunk:
//   - naprakesz fanal NEM deployol (nincs build/restart),
//   - ha origin/main elorelep, MATERIALIZALJA a fat + build + restart + rogziti a sha-t,
//   - ha a futo checkoutban kezi (koveto) modositas van, MEGTAGADJA (nem irja felul),
//   - ha a fetch elbukik, azt NEM veszi naprakesznek (a nulla ket dolgot jelenthet),
//   - bare topologian (ami .worktrees/-t hoszt) is helyesen materializal.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', '..', 'scripts', 'deploy-live.sh')

const GENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...GENV } })
}

let base: string
let origin: string   // bare "origin"
let root: string     // the deploy target checkout
let store: string
let markers: string

// Copy the real script into <root>/scripts so BASE resolves to <root> and it
// reads <root>/.env, exactly like production.
function installScript(dest: string) {
  mkdirSync(join(dest, 'scripts'), { recursive: true })
  cpSync(SCRIPT, join(dest, 'scripts', 'deploy-live.sh'))
  execFileSync('chmod', ['+x', join(dest, 'scripts', 'deploy-live.sh')])
}

function runDeploy(extraEnv: Record<string, string> = {}) {
  return execFileSync('bash', [join(root, 'scripts', 'deploy-live.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env, ...GENV,
      MARVEEN_PROJECT_ROOT: root,
      MARVEEN_STORE: store,
      SERVICE_ID: 'marveen-test',
      WEB_PORT: '0',
      MARVEEN_DEPLOY_BUILD_CMD: `touch '${markers}/build'`,
      MARVEEN_DEPLOY_RESTART_CMD: `touch '${markers}/restart'`,
      MARVEEN_DEPLOY_SKIP_HEALTH: '1',
      ...extraEnv,
    },
  })
}

function deployLog(): string {
  const f = join(store, 'deploy.log')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const built = () => existsSync(join(markers, 'build'))
const restarted = () => existsSync(join(markers, 'restart'))

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'marveen-deploy-'))
  origin = join(base, 'origin.git')
  root = join(base, 'live')
  store = join(base, 'store')
  markers = join(base, 'markers')
  mkdirSync(store, { recursive: true })
  mkdirSync(markers, { recursive: true })

  // origin: a bare repo with one commit on main (src only -- dist/ is a build
  // artifact, gitignored in reality and produced locally, so we do the same).
  const seed = join(base, 'seed')
  mkdirSync(join(seed, 'src'), { recursive: true })
  writeFileSync(join(seed, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'first')
  execFileSync('git', ['init', '-q', '-b', 'main', '--bare', origin], { stdio: 'ignore' })
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'main')
  // make sure the bare origin's HEAD names main, so clones check out main (not
  // an empty default 'master') and advanceOrigin can commit+push.
  execFileSync('git', ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })

  // root: clone of origin (a normal checkout), with .env, plus a fresh local
  // dist/ (untracked build artifact) so NEED_BUILD is false unless main advances.
  execFileSync('git', ['clone', '-q', origin, root], { stdio: 'ignore', env: { ...process.env, ...GENV } })
  installScript(root)
  writeFileSync(join(root, '.env'), 'SERVICE_ID=marveen-test\nWEB_PORT=0\n', 'utf8')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'index.js'), '// build 1\n', 'utf8')
  execFileSync('touch', [join(root, 'dist', 'index.js')])
})

function advanceOrigin(file: string, content: string, msg: string) {
  const wc = join(base, 'wc-' + Math.random().toString(36).slice(2))
  execFileSync('git', ['clone', '-q', origin, wc], { stdio: 'ignore', env: { ...process.env, ...GENV } })
  mkdirSync(dirname(join(wc, file)), { recursive: true })
  writeFileSync(join(wc, file), content, 'utf8')
  git(wc, 'add', '-A'); git(wc, 'commit', '-qm', msg); git(wc, 'push', '-q', 'origin', 'main')
}

describe('deploy-live.sh', () => {
  it('naprakesz fanal nem deployol', () => {
    runDeploy()
    expect(built()).toBe(false)
    expect(restarted()).toBe(false)
  })

  it('origin/main elorelepesekor materializal + build + restart + rogziti a sha-t', () => {
    advanceOrigin('src/b.ts', 'export const b = 2\n', 'add b')
    runDeploy()
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(true)   // uj fajl a lemezen
    expect(built()).toBe(true)
    expect(restarted()).toBe(true)
    const target = execFileSync('git', ['--git-dir', join(root, '.git'), 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()
    expect(readFileSync(join(store, '.deployed-sha'), 'utf8').trim()).toBe(target)
  })

  it('torolt fajlt is materializal (nem csak hozzaad)', () => {
    // eloszor egy deploy, hogy legyen deployed-sha es a fa naprakesz legyen
    advanceOrigin('src/b.ts', 'export const b = 2\n', 'add b')
    runDeploy()
    rmSync(join(markers, 'build')); rmSync(join(markers, 'restart'))
    // most origin torli a b.ts-t
    const wc = join(base, 'wc-del')
    execFileSync('git', ['clone', '-q', origin, wc], { stdio: 'ignore', env: { ...process.env, ...GENV } })
    rmSync(join(wc, 'src', 'b.ts'))
    git(wc, 'add', '-A'); git(wc, 'commit', '-qm', 'del b'); git(wc, 'push', '-q', 'origin', 'main')
    runDeploy()
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)  // eltunt a lemezrol is
    expect(built()).toBe(true)
  })

  it('kezi (koveto) modositast a futo checkoutban NEM ir felul', () => {
    // elso deploy -> deployed-sha rogzitve
    advanceOrigin('src/b.ts', 'export const b = 2\n', 'add b')
    runDeploy()
    rmSync(join(markers, 'build')); rmSync(join(markers, 'restart'))
    // valaki kezzel modosit egy KOVETETT fajlt a futo checkoutban
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 999 // hand edit\n', 'utf8')
    // es origin is elorelep (mashol), hogy legyen mit deployolni
    advanceOrigin('src/c.ts', 'export const c = 3\n', 'add c')
    runDeploy()
    expect(deployLog()).toMatch(/REFUSING/)
    expect(built()).toBe(false)     // nem deployolt
    expect(restarted()).toBe(false)
    // a kezi modositas megmaradt
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toMatch(/hand edit/)
  })

  it('sikertelen fetch NEM naprakesz -- kulon mondja', () => {
    // toroljuk az origin remote-ot -> a fetch elbukik
    rmSync(origin, { recursive: true, force: true })
    runDeploy()
    expect(deployLog()).toMatch(/could not fetch/)
    expect(built()).toBe(false)
  })

  it('bare topologian (core.bare=true) is materializal', () => {
    // tegyuk a root-ot "bare"-re, ahogy az eles gepen -- a fa a helyen marad,
    // de a git bare-kent kezeli
    execFileSync('git', ['--git-dir', join(root, '.git'), 'config', 'core.bare', 'true'])
    advanceOrigin('src/d.ts', 'export const d = 4\n', 'add d')
    runDeploy()
    expect(existsSync(join(root, 'src', 'd.ts'))).toBe(true)
    expect(deployLog()).toMatch(/bare=true/)
    expect(built()).toBe(true)
  })
})
