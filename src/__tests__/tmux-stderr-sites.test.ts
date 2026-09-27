import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmuxStderr } from '../web/tmux-stderr.js'

// #413, rebuilt from upstream db261a7b (TMUXWINDOWATTR920). execFileSync
// without a stdio option copies the child's stderr onto the dashboard's own
// stderr (store/dashboard.error.log): measured here 1826 undated
// "can't find session/window/pane" lines. The by-name tmux probes now pipe
// stderr and log tmux's line with the call site. Companion of the upstream
// tmux-stderr-attribution test, whose site list names upstream's call shapes.

const ROOT = join(__dirname, '..')
const SITES: Array<[file: string, call: RegExp, site: string]> = [
  ['web/channel-monitor.ts', /\['has-session', '-t', exactTmuxTarget\(MAIN_CHANNELS_SESSION\)\][^\n]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'channel-monitor.mainChannelsSessionExists'],
  ['web/context-restart-gate-runner.ts', /\['list-panes', '-t', exactTmuxTarget\(session\), '-F', '#\{pane_pid\}'\],\s*\{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'context-restart-gate-runner.getPanePid'],
  ['web/stuck-tool-call-watcher.ts', /\['list-panes', '-t', exactTmuxTarget\(session\), '-F', '#\{pane_pid\}'\], \{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'stuck-tool-call-watcher.sampleMainClaudeCpuPercent'],
  ['web/agent-worker.ts', /\['kill-session', '-t', exactTmuxTarget\(ctx\.session\)\], \{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'agent-worker.restart'],
  ['channel-coordinator/liveness.ts', /\['list-panes', '-t', exactTmuxTarget\(session\), '-F', '#\{pane_pid\}'\], \{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'liveness.getClaudePidForSession'],
  ['web/main-agent-runtime.ts', /\['list-panes', '-t', exactTmuxTarget\(session\), '-F', '#\{pane_pid\}'\],\s*\{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'main-agent-runtime.findClaudePid'],
]

describe('tmux probes pipe stderr and log it with the call site', () => {
  for (const [file, call, site] of SITES) {
    it(file, () => {
      const s = readFileSync(join(ROOT, file), 'utf-8')
      expect(s, `${file}: the tmux call must pipe stderr`).toMatch(call)
      expect(s, `${file}: the catch must log the site`).toContain(`site: '${site}'`)
      expect(s).toContain('tmux: tmuxStderr(err)')
    })
  }
})

describe('tmuxStderr', () => {
  it("returns tmux's own line from a piped stderr", () => {
    expect(tmuxStderr({ stderr: "can't find session: agent-x\n", message: 'Command failed' })).toBe("can't find session: agent-x")
  })
  it('accepts a Buffer stderr', () => {
    expect(tmuxStderr({ stderr: Buffer.from('no server running\n') })).toBe('no server running')
  })
  it('falls back to the message when stderr is empty', () => {
    expect(tmuxStderr({ stderr: '', message: 'spawnSync tmux ETIMEDOUT' })).toBe('spawnSync tmux ETIMEDOUT')
  })
  it('caps the line', () => {
    expect(tmuxStderr({ stderr: 'x'.repeat(500) })).toHaveLength(200)
  })
})
