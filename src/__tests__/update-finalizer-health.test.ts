import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #728: the unattended update that runs right after a machine boot restarts a
// dashboard that needs far more than 20 s to answer. The detached finalizer used to
// declare it dead, roll back to the SAME commit (reset/ci/build), restart a second
// time and send the red "SIKERTELEN" alert although the dashboard was fine.
//
// This runs the REAL finalizer (cut out of update.sh) against stubbed stop/start/
// notify/curl/sleep/npm, so the three outcomes are measured, not read from source.

const ROOT = join(__dirname, '..', '..')
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function finalizerSource(): string {
  const script = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
  const start = script.indexOf("<<'FINALIZE_EOF'\n")
  const end = script.indexOf('\nFINALIZE_EOF\n', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return script.slice(start + "<<'FINALIZE_EOF'\n".length, end + 1)
}

function run(opts: { curlOkAfter: number | null; headIsOld: boolean }) {
  const base = mkdtempSync(join(tmpdir(), 'upd-final-'))
  dirs.push(base)
  const install = join(base, 'install')
  const bin = join(base, 'bin')
  mkdirSync(join(install, 'scripts'), { recursive: true })
  mkdirSync(bin)
  const sh = (p: string, body: string) => { writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`); chmodSync(p, 0o755) }
  const log = join(base, 'calls.log')
  sh(join(install, 'scripts', 'stop.sh'), `echo stop >> "${log}"`)
  sh(join(install, 'scripts', 'start.sh'), `echo start >> "${log}"`)
  sh(join(install, 'scripts', 'notify.sh'), `echo "notify: $1" >> "${log}"`)
  sh(join(bin, 'sleep'), 'exit 0')
  for (const t of ['npm']) sh(join(bin, t), `echo "${t} $*" >> "${log}"`)
  // curl succeeds from call number curlOkAfter on (never when null).
  const counter = join(base, 'curl.count')
  writeFileSync(counter, '0')
  sh(join(bin, 'curl'), [
    `n=$(( $(cat "${counter}") + 1 )); echo $n > "${counter}"`,
    opts.curlOkAfter === null ? 'exit 7' : `[ "$n" -ge ${opts.curlOkAfter} ] && exit 0 || exit 7`,
  ].join('\n'))

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  const git = (...a: string[]) => execFileSync('git', ['-C', install, ...a], { env, encoding: 'utf-8' }).trim()
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one')
  const head = git('rev-parse', 'HEAD')
  const oldFull = opts.headIsOld ? head : '0'.repeat(40)

  const fin = join(base, 'finalize.sh')
  writeFileSync(fin, finalizerSource())
  const result = join(base, 'result.json')
  const r = spawnSync('bash', [fin, install, oldFull, 'oldshort', '3420', result, join(base, 'built'), 'newshort', '', '1'], { env, encoding: 'utf-8' })
  const calls = existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : []
  return { code: r.status, calls, result: JSON.parse(readFileSync(result, 'utf-8')) as { status: string; message: string }, curlCalls: Number(readFileSync(counter, 'utf-8')) }
}

describe('update finalizer health window (#728)', () => {
  it('a dashboard that answers only after ~100 s is a success: one restart, no rollback, no alert', () => {
    const r = run({ curlOkAfter: 100, headIsOld: true })
    expect(r.code).toBe(0)
    expect(r.result.status).toBe('success')
    expect(r.calls.filter((c) => c === 'start')).toHaveLength(1)
    expect(r.calls.some((c) => c.startsWith('npm'))).toBe(false)
    expect(r.calls.some((c) => c.includes('SIKERTELEN'))).toBe(false)
  })

  it('no commit pulled and the dashboard is slower than the first window: no rollback, success in the grace window', () => {
    const r = run({ curlOkAfter: 200, headIsOld: true })
    expect(r.code).toBe(0)
    expect(r.result.status).toBe('success')
    expect(r.calls.filter((c) => c === 'start')).toHaveLength(1)
    expect(r.calls.some((c) => c.startsWith('npm'))).toBe(false)
  })

  it('no commit pulled and the dashboard never answers: failed WITHOUT a pointless rollback, honest message', () => {
    const r = run({ curlOkAfter: null, headIsOld: true })
    expect(r.code).toBe(1)
    expect(r.result.status).toBe('failed')
    expect(r.calls.filter((c) => c === 'start')).toHaveLength(1)
    expect(r.calls.some((c) => c.startsWith('npm'))).toBe(false)
    expect(r.result.message).not.toMatch(/visszaallit(as|ás) utan/)
    const alert = r.calls.find((c) => c.includes('SIKERTELEN'))
    expect(alert).toBeDefined()
    expect(alert).not.toContain('ES a rollback')
  })

  it('a pulled commit whose dashboard never answers still rolls back (restart twice) and ends rolled-back when the old one answers', () => {
    // First window (150 polls) fails, the rollback restart then answers.
    const r = run({ curlOkAfter: 151, headIsOld: false })
    expect(r.code).toBe(6)
    expect(r.result.status).toBe('rolled-back')
    expect(r.calls.filter((c) => c === 'start')).toHaveLength(2)
    expect(r.calls.some((c) => c.startsWith('npm ci'))).toBe(true)
  })

  it('a pulled commit and nothing ever answers: failed after the rollback', () => {
    const r = run({ curlOkAfter: null, headIsOld: false })
    expect(r.code).toBe(1)
    expect(r.result.status).toBe('failed')
    expect(r.result.message).toContain('visszaallitas utan')
  })
})
