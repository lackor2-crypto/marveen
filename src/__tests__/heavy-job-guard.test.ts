// Card #683: on 2026-10-17 a deploy build, a full vitest run, a web-only
// instance and 3 Playwright runs overlapped on the 10 GB WSL VM and froze it.
// These tests pin the four guards that stop a repeat: the single-flight queue
// (heavy-job.sh), the PreToolUse gate, the memory gate's heavy-job kill, and
// the /tmp sweep (never the scratchpad of a running session).
import { describe, it, expect } from 'vitest'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HEAVY = join(root, 'scripts', 'heavy-job.sh')
const GATE_HOOK = join(root, 'scripts', 'hooks', 'heavy-job-gate.py')
const MEMGATE = join(root, 'scripts', 'fleet-memory-gate.sh')
const SWEEP = join(root, 'scripts', 'tmp-sweep.py')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('heavy-job.sh queue', () => {
  it('runs one job at a time: the second waits and gives up with 75, never running unqueued', async () => {
    const store = mkdtempSync(join(tmpdir(), 'heavy-q-'))
    const env = { ...process.env, MARVEEN_STORE: store, MARVEEN_HEAVY_JOB_ACTIVE: '' }
    const first = spawn('bash', [HEAVY, 'first', '--', 'sleep', '6'], { env, stdio: 'ignore' })
    await sleep(800)
    expect(existsSync(join(store, 'heavy-job.json'))).toBe(true)
    const reg = JSON.parse(readFileSync(join(store, 'heavy-job.json'), 'utf8'))
    expect(reg.name).toBe('first')
    const marker = join(store, 'second-ran')
    const second = spawnSync('bash', [HEAVY, '--wait', '5', 'second', '--', 'touch', marker], { env, encoding: 'utf8' })
    expect(second.status).toBe(75)
    expect(existsSync(marker)).toBe(false)
    first.kill('SIGTERM')
  }, 20000)

  it('a web-only instance has its own slot: a build / browser job is not blocked by it (H1)', async () => {
    const store = mkdtempSync(join(tmpdir(), 'heavy-q-'))
    const env = { ...process.env, MARVEEN_STORE: store, MARVEEN_HEAVY_JOB_ACTIVE: '' }
    const web = spawn('bash', [HEAVY, 'web-only', '--', 'sleep', '8'], { env, stdio: 'ignore' })
    await sleep(800)
    expect(existsSync(join(store, 'heavy-job-web.json'))).toBe(true)
    expect(existsSync(join(store, 'heavy-job.json'))).toBe(false)
    const marker = join(store, 'build-ran')
    const build = spawnSync('bash', [HEAVY, '--wait', '5', 'build', '--', 'touch', marker], { env, encoding: 'utf8' })
    expect(build.status).toBe(0)
    expect(existsSync(marker)).toBe(true)
    // a second web-only still waits for the first one
    const web2 = spawnSync('bash', [HEAVY, '--wait', '5', 'web-only-2', '--', 'true'], { env, encoding: 'utf8' })
    expect(web2.status).toBe(75)
    web.kill('SIGTERM')
  }, 25000)

  it('passes the command exit code through and clears the registry', async () => {
    const store = mkdtempSync(join(tmpdir(), 'heavy-q-'))
    const env = { ...process.env, MARVEEN_STORE: store, MARVEEN_HEAVY_JOB_ACTIVE: '' }
    const r = spawnSync('bash', [HEAVY, 'rc', '--', 'bash', '-c', 'exit 7'], { env })
    expect(r.status).toBe(7)
    expect(existsSync(join(store, 'heavy-job.json'))).toBe(false)
  })
})

function gate(command: string, env: Record<string, string> = {}) {
  return spawnSync('python3', [GATE_HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, MARVEEN_HEAVY_JOB_GATE: '', ...env },
    encoding: 'utf8',
  })
}

describe('heavy-job-gate.py (PreToolUse)', () => {
  it.each([
    'npx vitest run',
    'npx vitest run --reporter dot',
    'npm test',
    'npm run build',
    'cd x && npm run build',
    'WEB_ONLY=true node dist/index.js',
    'node pw-click.js --headless',
    'nice -n 10 npx vitest run',
    'cd x && nice -n 10 npx vitest run > /tmp/suite.log 2>&1',
    'npx vitest run > /tmp/suite.log',
    'npx vitest run 2>&1 | tail -5',
    'nohup npx vitest run >log 2>&1 &',
    'timeout 1200 npx vitest run',
    'timeout -s KILL 1200 npx vitest run > /tmp/s.log 2>&1',
    'python3 -c "from playwright.sync_api import sync_playwright"',
  ])('denies %s', (cmd) => {
    const r = gate(cmd)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('heavy-job.sh')
  })

  it.each([
    'npx vitest run src/__tests__/lang-parity.test.ts',
    'echo vitest',
    'grep -r vitest src',
    'npx tsc --noEmit',
    'bash scripts/heavy-job.sh build -- npm run build',
    'scripts/heavy-job.sh pw -- node pw-click.js',
    'git status',
    'nice -n 10 npx vitest run src/__tests__/lang-parity.test.ts > /tmp/x.log 2>&1',
    'npx vitest run src/__tests__/lang-parity.test.ts 2>&1 | tail -5',
    'timeout 600 npx vitest run src/__tests__/lang-parity.test.ts',
  ])('allows %s', (cmd) => {
    expect(gate(cmd).status).toBe(0)
  })

  it('is off with MARVEEN_HEAVY_JOB_GATE=0 and fails open on a broken payload', () => {
    expect(gate('npm run build', { MARVEEN_HEAVY_JOB_GATE: '0' }).status).toBe(0)
    const bad = spawnSync('python3', [GATE_HOOK], { input: 'not json', encoding: 'utf8' })
    expect(bad.status).toBe(0)
  })
})

describe('fleet-memory-gate --shed heavy-job kill', () => {
  it('names the registered heavy job in the dry run when memory is over the heavy threshold, and kills nothing', async () => {
    const store = mkdtempSync(join(tmpdir(), 'heavy-mg-'))
    const env = { ...process.env, MARVEEN_STORE: store, MARVEEN_HEAVY_JOB_ACTIVE: '' }
    const job = spawn('bash', [HEAVY, 'victim', '--', 'sleep', '20'], { env, stdio: 'ignore' })
    await sleep(800)
    try {
      const { stdout } = await execFileAsync('/bin/bash', [MEMGATE, '--shed', '--dry-run'], {
        encoding: 'utf8',
        env: { ...env, MARVEEN_MEM_HEAVY_KILL_PCT: '0', MARVEEN_MEM_GATE_OBSERVE: '0', WEB_PORT: '1' },
      })
      expect(stdout).toContain('would-kill-heavy victim')
      expect(job.exitCode).toBeNull() // dry run: still alive
    } finally {
      job.kill('SIGTERM')
    }
  }, 20000)

  it('does not touch the job below the threshold', async () => {
    const store = mkdtempSync(join(tmpdir(), 'heavy-mg-'))
    const env = { ...process.env, MARVEEN_STORE: store, MARVEEN_HEAVY_JOB_ACTIVE: '' }
    const job = spawn('bash', [HEAVY, 'safe', '--', 'sleep', '20'], { env, stdio: 'ignore' })
    await sleep(800)
    try {
      const { stdout } = await execFileAsync('/bin/bash', [MEMGATE, '--shed', '--dry-run'], {
        encoding: 'utf8',
        env: { ...env, MARVEEN_MEM_HEAVY_KILL_PCT: '101', MARVEEN_MEM_GATE_OBSERVE: '0', WEB_PORT: '1' },
      })
      expect(stdout).not.toContain('would-kill-heavy')
    } finally {
      job.kill('SIGTERM')
    }
  }, 20000)
})

describe('heavy-job-gate.py false positives', () => {
  it('the bare word playwright in a comment or text does not stop a python command', () => {
    expect(gate("python3 - <<'E'\n# the playwright run is fine\nprint(1)\nE").status).toBe(0)
  })
  it('a real browser launch still does', () => {
    expect(gate("node -e \"require('playwright').chromium.launch()\"").status).toBe(2)
  })
})

describe('tmp-sweep.py', () => {
  function old(path: string, days: number) {
    const t = Date.now() / 1000 - days * 86400
    utimesSync(path, t, t)
  }

  it('removes only OLD known leftovers and keeps new, unknown and in-use entries', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sweep-'))
    const store = mkdtempSync(join(tmpdir(), 'sweep-store-'))
    const uid = process.getuid!()

    const oldPw = join(tmp, 'playwright-old'); mkdirSync(oldPw); writeFileSync(join(oldPw, 'a'), 'x'); old(join(oldPw, 'a'), 5); old(oldPw, 5)
    const newPw = join(tmp, 'playwright-new'); mkdirSync(newPw)
    const unknown = join(tmp, 'my-notes'); mkdirSync(unknown); old(unknown, 30)
    // A quiet but RUNNING session's scratchpad: a live process has it as its cwd.
    const sess = join(tmp, `claude-${uid}`, 'proj', 'live-session'); mkdirSync(sess, { recursive: true }); old(sess, 30)
    const dead = join(tmp, `claude-${uid}`, 'proj', 'dead-session'); mkdirSync(dead, { recursive: true }); old(dead, 30)

    const holder = spawn('sleep', ['15'], { cwd: sess, stdio: 'ignore' })
    try {
      const dry = spawnSync('python3', [SWEEP, '--dry-run', '--dir', tmp], { env: { ...process.env, MARVEEN_STORE: store }, encoding: 'utf8' })
      expect(dry.stdout).toContain('would-remove')
      expect(existsSync(oldPw)).toBe(true) // dry run removes nothing

      spawnSync('python3', [SWEEP, '--dir', tmp], { env: { ...process.env, MARVEEN_STORE: store }, encoding: 'utf8' })
      expect(existsSync(oldPw)).toBe(false)
      expect(existsSync(dead)).toBe(false)
      expect(existsSync(newPw)).toBe(true)
      expect(existsSync(unknown)).toBe(true)
      expect(existsSync(sess)).toBe(true)
      expect(existsSync(join(store, 'tmp-sweep.log'))).toBe(true)
    } finally {
      holder.kill()
    }
  })

  it('sweeps the unit-test mkdtemp leftovers, and keeps a quiet session scratchpad for 14 days (H2, H5)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sweep-'))
    const store = mkdtempSync(join(tmpdir(), 'sweep-store-'))
    const uid = process.getuid!()
    const leak = ['marveen-deploy-abc', 'marveen-bigfolder-x', 'voice-scope-q', 'named-login-z'].map((n) => join(tmp, n))
    for (const d of leak) { mkdirSync(d); old(d, 5) }
    const quiet = join(tmp, `claude-${uid}`, 'proj', 'quiet-session'); mkdirSync(quiet, { recursive: true }); old(quiet, 5)
    spawnSync('python3', [SWEEP, '--dir', tmp], { env: { ...process.env, MARVEEN_STORE: store }, encoding: 'utf8' })
    for (const d of leak) expect(existsSync(d)).toBe(false)
    expect(existsSync(quiet)).toBe(true)
  })

  it('MARVEEN_TMP_SWEEP_DAYS moves the threshold', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sweep-'))
    const store = mkdtempSync(join(tmpdir(), 'sweep-store-'))
    const p = join(tmp, 'vitest-x'); mkdirSync(p); old(p, 3)
    const env = { ...process.env, MARVEEN_STORE: store, MARVEEN_TMP_SWEEP_DAYS: '10' }
    spawnSync('python3', [SWEEP, '--dir', tmp], { env, encoding: 'utf8' })
    expect(existsSync(p)).toBe(true)
    spawnSync('python3', [SWEEP, '--dir', tmp], { env: { ...env, MARVEEN_TMP_SWEEP_DAYS: '2' }, encoding: 'utf8' })
    expect(existsSync(p)).toBe(false)
  })
})
