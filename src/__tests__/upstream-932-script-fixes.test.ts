import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #932: four upstream fixes taken over (agent-msg base URL, progress-hook
// MARVEEN_ROOT, macOS optional Ollama/ffmpeg, nap-zaro heartbeat + task_runs).
// Each assertion fails on the code before the fix and passes after it.

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('agent-msg.sh: the base URL is env-overridable (upstream f8134372d)', () => {
  function run(env: Record<string, string>) {
    // Copy the real script into a throwaway repo layout so its failure log
    // never lands in the real store/.
    const base = mkdtempSync(join(tmpdir(), 'agent-msg-'))
    mkdirSync(join(base, 'scripts'))
    mkdirSync(join(base, 'store'))
    copyFileSync(join(ROOT, 'scripts', 'agent-msg.sh'), join(base, 'scripts', 'agent-msg.sh'))
    writeFileSync(join(base, 'store', '.dashboard-token'), 'tok')
    return spawnSync('bash', [join(base, 'scripts', 'agent-msg.sh'), 'a', 'b', 'hi'], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf-8',
      timeout: 20000,
    })
  }

  it('posts to MARVEEN_API_BASE (trailing slash trimmed) and names the URL in the failure line', () => {
    const r = run({ MARVEEN_API_BASE: 'http://127.0.0.1:1/' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('url=http://127.0.0.1:1/api/messages')
  }, 25000)

  it('keeps localhost:<MARVEEN_WEB_PORT> as the default base', () => {
    const r = run({ MARVEEN_WEB_PORT: '1' })
    expect(r.stdout).toContain('url=http://localhost:1/api/messages')
  }, 25000)
})

describe('install-telegram-progress-hook.sh: explicit MARVEEN_ROOT (upstream 5312726c7)', () => {
  it('passes MARVEEN_ROOT to both the launchd job and the systemd unit', () => {
    const s = read('scripts/install-telegram-progress-hook.sh')
    expect(s).toContain('<key>MARVEEN_ROOT</key>')
    expect(s).toContain('<string>$INSTALL_DIR</string>')
    expect(s).toContain('Environment=MARVEEN_ROOT=$INSTALL_DIR')
  })
})

describe('install-macos.sh: Ollama and ffmpeg are optional (upstream 6da79659a)', () => {
  it('runs the Ollama setup in a function judged by `command -v`, and warns instead of aborting', () => {
    const s = read('install-macos.sh')
    expect(s).toContain('install_ollama() {')
    expect(s).toContain('install_ollama || OLLAMA_RC=$?')
    expect(s).toContain('macos.ollama_skipped')
    expect(s).toContain('macos.ffmpeg_skipped')
  })

  it('has the skipped-warning texts in both languages', () => {
    const l = read('install-lang.sh')
    for (const k of ['ollama_skipped', 'ollama_skipped_hint', 'ffmpeg_skipped', 'ffmpeg_skipped_hint']) {
      expect(l).toContain(`en:macos.${k})`)
      expect(l).toContain(`hu:macos.${k})`)
    }
  })
})

describe('nap-zaro seed: a quiet heartbeat that lists the runs (upstream 963400870)', () => {
  it('is a heartbeat with a catch-up window', () => {
    const c = JSON.parse(read('seed-scheduled-tasks/nap-zaro/task-config.json'))
    expect(c.type).toBe('heartbeat')
    expect(c.catchUpMaxAgeMinutes).toBe(180)
  })

  it('stays silent whatever the delivery prompt says, and reads the task_runs table', () => {
    const s = read('seed-scheduled-tasks/nap-zaro/SKILL.md')
    expect(s).toContain('AKKOR SEM, ha a prompt elején')
    expect(s).toContain('FROM task_runs')
    expect(s).toContain("name != 'nap-zaro'")
  })
})
