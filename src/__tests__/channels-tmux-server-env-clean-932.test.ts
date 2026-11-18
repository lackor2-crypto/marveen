import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// #932 / upstream TMUXSERVERREAP929: channels.sh exports the MAIN channel state dir for its own session. The shared tmux
// server it creates inherits the launching process environment, so the var landed in the server's GLOBAL environment
// (measured on the live server 2026-11-18: TELEGRAM_STATE_DIR=<main channel dir>) and every sub-agent session inherited it.
// Every call that can create the server must run without that var, and a polluted server is cleaned after the launch.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sh = readFileSync(join(REPO_ROOT, 'scripts', 'channels.sh'), 'utf-8')
const lines = sh.split('\n')

describe('channels.sh keeps the channel state dir out of the shared tmux server', () => {
  it('start-server runs without the state-dir var', () => {
    const calls = lines.filter((l) => /\$TMUX start-server/.test(l) && !/^\s*#/.test(l))
    expect(calls.length).toBeGreaterThan(0)
    for (const l of calls) expect(l).toMatch(/env -u "\$STATE_ENV_VAR" \$TMUX start-server/)
  })

  it('every new-session of the channels session runs without the state-dir var', () => {
    const calls = lines.filter((l) => /\$TMUX new-session -d -s "\$SESSION"/.test(l) && !/^\s*#/.test(l))
    expect(calls.length).toBe(2)
    for (const l of calls) expect(l).toMatch(/env -u "\$STATE_ENV_VAR" \$TMUX new-session/)
  })

  it('a server polluted by an earlier launch is cleaned with set-environment -g -u', () => {
    expect(sh).toMatch(/\$TMUX set-environment -g -u "\$STATE_ENV_VAR"/)
  })
})
