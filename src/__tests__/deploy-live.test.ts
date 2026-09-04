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
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

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

// A free TCP port, released before we return it -- used both as a "surely
// closed" port (FIX1/a) and as the port we then open a real server on (FIX1/b).
function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => res(p))
    })
  })
}

// Poll until <port> accepts a TCP connection (or time out) -- so the health
// check does not race the server's startup.
function waitPortOpen(port: number, tries = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) => {
      const c = net.connect(port, '127.0.0.1')
      c.once('connect', () => { c.destroy(); resolve() })
      c.once('error', () => {
        c.destroy()
        if (n <= 0) reject(new Error('port never opened'))
        else setTimeout(() => attempt(n - 1), 40)
      })
    }
    attempt(tries)
  })
}

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

  // --- FIX1: a health-check tenyleg ellenoriz (a regi `|| echo 000` "000000"-t
  // adott, ami != "000", ezert az elso korben ok=1 lett es sose ellenorzott).
  // Ezek SKIP_HEALTH NELKUL futnak, ezert fogtak volna meg a bugot.
  it('FIX1/a: zart porton NEM valaszol -> "NOT answering" + ALERT (nem "live")', async () => {
    const closed = await getFreePort()   // szabad port, de senki nem figyel rajta
    advanceOrigin('src/b.ts', 'export const b = 2\n', 'add b')
    runDeploy({
      MARVEEN_DEPLOY_SKIP_HEALTH: '0',
      WEB_PORT: String(closed),
      MARVEEN_DEPLOY_HTTP_TRIES: '2',
      MARVEEN_DEPLOY_HTTP_GAP: '0',
    })
    const l = deployLog()
    expect(l).toMatch(/NOT answering/)
    expect(l).toMatch(/ALERT/)
    expect(l).not.toMatch(/live \(HTTP/)
  })

  it('FIX1/b: valo szerver 200-at ad -> "live (HTTP 200)"', async () => {
    const port = await getFreePort()
    // Kulon processz kell: az execFileSync BLOKKOLJA a Node event-loopot, egy
    // ugyanebben a processzben inditott JS-szerver nem valaszolna a deploy alatt.
    const srv: ChildProcess = spawn(
      process.execPath,
      ['-e', `require('http').createServer((q,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},'0.0.0.0')`],
      { stdio: 'ignore' },
    )
    try {
      await waitPortOpen(port)
      advanceOrigin('src/b.ts', 'export const b = 2\n', 'add b')
      runDeploy({
        MARVEEN_DEPLOY_SKIP_HEALTH: '0',
        WEB_PORT: String(port),
        MARVEEN_DEPLOY_HTTP_TRIES: '10',
        MARVEEN_DEPLOY_HTTP_GAP: '0',
      })
      expect(deployLog()).toMatch(/live \(HTTP 200/)
    } finally {
      srv.kill('SIGKILL')
    }
  })

  // --- FIX2: elso futas / elveszett .deployed-sha eseten kulonbozteti meg az
  // ELAVULT fat (regebbi commit tiszta materializacioja -> deployol) a KEZI
  // modositastol (egyetlen commitnak sem tiszta mat. -> megall, nem ir felul).
  it('FIX2/a: regebbi commit tiszta materializacioja, nincs .deployed-sha -> DEPLOYOL', () => {
    // origin elorelep haromszor; a root fa a seed (HEAD~3) marad, .deployed-sha nincs
    advanceOrigin('src/b.ts', 'export const b = 2\n', 'c2')
    advanceOrigin('src/c.ts', 'export const c = 3\n', 'c3')
    advanceOrigin('src/d.ts', 'export const d = 4\n', 'c4')
    expect(existsSync(join(store, '.deployed-sha'))).toBe(false)
    runDeploy()
    expect(deployLog()).toMatch(/clean materialization of/)   // baseline elfogadva
    expect(built()).toBe(true)
    expect(restarted()).toBe(true)
    expect(existsSync(join(root, 'src', 'd.ts'))).toBe(true)   // felmaterializalt a target-re
    const target = execFileSync('git', ['--git-dir', join(root, '.git'), 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()
    expect(readFileSync(join(store, '.deployed-sha'), 'utf8').trim()).toBe(target)
  })

  it('FIX2/b: regebbi fa + kezi modositas, nincs .deployed-sha -> NEM deployol, a modositas megmarad', () => {
    advanceOrigin('src/b.ts', 'export const b = 2\n', 'c2')
    advanceOrigin('src/c.ts', 'export const c = 3\n', 'c3')
    advanceOrigin('src/d.ts', 'export const d = 4\n', 'c4')
    // kezi modositas egy KOVETETT fajlon -> egyetlen ismert commitnak sem lesz tiszta mat.
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 777 // kezi bootstrap edit\n', 'utf8')
    expect(existsSync(join(store, '.deployed-sha'))).toBe(false)
    runDeploy()
    expect(built()).toBe(false)
    expect(restarted()).toBe(false)
    expect(deployLog()).toMatch(/not a clean materialization/)
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toMatch(/kezi bootstrap edit/)
  })
})
