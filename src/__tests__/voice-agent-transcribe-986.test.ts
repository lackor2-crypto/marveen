// #986: every agent can write down the speech of an audio or video file. The wrappers run from the checkout, which
// never has its own venv: they used to look for one there and died, although the toolkit was installed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { voiceScript } from '../web/routes/voice.js'

const SCRIPTS = join(PROJECT_ROOT, 'scripts', 'voice')
const CODE = join(SCRIPTS, '_vtools.py')
let home = ''
let empty = ''

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'voice986-'))
  empty = mkdtempSync(join(tmpdir(), 'voice986-empty-'))
  const bin = join(home, '.local', 'share', 'marveen-voice', 'venv', 'bin')
  mkdirSync(bin, { recursive: true })
  // Stands in for the installed interpreter: prints what it was asked to run.
  writeFileSync(join(bin, 'python'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n')
  chmodSync(join(bin, 'python'), 0o755)
})
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(empty, { recursive: true, force: true })
})

function run(script: string, args: string[], h: string) {
  return spawnSync('bash', [join(SCRIPTS, script), ...args], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', HOME: h } })
}

describe('voice wrappers run from the checkout (#986)', () => {
  it('stt.sh runs this checkout\'s code with the installed interpreter, for a file on disk', () => {
    const r = run('stt.sh', ['/some/recording.mp4'], home)
    expect(r.status, r.stderr).toBe(0)
    const argv = r.stdout.trim().split('\n')
    expect(argv.slice(0, 3)).toEqual([CODE, 'transcribe', '/some/recording.mp4'])
  })

  it('tts.sh finds the installed interpreter and voices', () => {
    const r = run('tts.sh', ['imre', '1', 'szia'], home)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(CODE)
    expect(r.stdout).toContain(join(home, '.local', 'share', 'marveen-voice', 'voices', 'hu_HU-imre-medium.onnx'))
  })

  it('canary.sh tests the installed toolkit instead of silently skipping it', () => {
    const r = run('canary.sh', [], home)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('canary')
    expect(r.stdout).not.toContain('skip:')
  })

  it('without the toolkit it says in words what to do', () => {
    const r = run('stt.sh', ['/some/recording.mp4'], empty)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('nincs telepitve')
    expect(r.stderr).toContain('not installed')
  })

  it('a path that does not exist is reported as such, not sent to Telegram as a file id', () => {
    const r = spawnSync('python3', ['-I', CODE, 'transcribe', '/no/such/file.m4a', empty], { encoding: 'utf-8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no such file: /no/such/file.m4a')
  })

  it('the dashboard runs the same up to date script, never the copy made at install time', () => {
    expect(voiceScript()).toBe(CODE)
    for (const f of ['web/routes/voice.ts', 'workbench-video-autosub.ts']) {
      const src = readFileSync(join(PROJECT_ROOT, 'src', f), 'utf-8')
      expect(src, f).not.toMatch(/\[VTOOLS_PY,/)
    }
  })
})
