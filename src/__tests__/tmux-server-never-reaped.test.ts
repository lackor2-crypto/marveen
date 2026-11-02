import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePollerPidsFromPs } from '../web/channel-poller-reap.js'

// #842 (Boss, 2026-11-02): the Szakerto agent "stopped" while nobody touched the computer. Measured root cause:
// an account switch restarts lackor2-bot-channels.service -> channels.sh runs its orphan-poller reap -> the shared
// tmux SERVER carries TELEGRAM_STATE_DIR=<main chan dir> in its environment (it was started from channels.sh) and
// matched the needle -> SIGKILL -> every sub-agent session in that server died (journal: tmux-spawn scopes ended
// 18:52:43-44, running_agents=0; the same on 8 occasions in 4 days). These tests run the REAL awk programs of
// channels.sh and the TS scanner against the real shape of the tmux server's `ps eww` row.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const channelsSh = readFileSync(join(REPO_ROOT, 'scripts', 'channels.sh'), 'utf-8')
const INSTALL = '/home/u/marveen'
const CHAN = `${INSTALL}/.claude/channels/telegram`

// Row shapes taken from `ps eww -e` on the failing machine.
const TMUX_SERVER = `1148446 ?        Ss     0:01 tmux new-session -d -s lackor2-bot-channels -x 80 -y 60 export TELEGRAM_STATE_DIR='${CHAN}' && claude TELEGRAM_STATE_DIR=${CHAN} CLAUDE_PLUGIN_ROOT=/home/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7`
const TMUX_SERVER_COMM = `2436 ?        Ssl    0:09 tmux: server TELEGRAM_STATE_DIR=${CHAN}`
const TMUX_ABSOLUTE = `2437 ?        Ssl    0:09 /usr/bin/tmux new-session -d TELEGRAM_STATE_DIR=${CHAN}`
const ORPHAN_POLLER = `5000 ?        Sl     0:03 /home/u/.bun/bin/bun run --cwd /x start TELEGRAM_STATE_DIR=${CHAN}`
const ORPHAN_POLLER_WITH_TMUX_ENV = `5001 ?        Sl     0:03 /home/u/.bun/bin/bun run --cwd /x start TMUX=/tmp/tmux-1000/default,1,0 TELEGRAM_STATE_DIR=${CHAN}`
const OLD_BUILD_ORPHAN = `5002 ?        Sl     0:03 node CLAUDE_PLUGIN_ROOT=/home/u/.claude/plugins/cache/x/telegram/0.0.6`
const TMUX_NO_STATE = `2438 ?        Ssl    0:09 tmux: server CLAUDE_PLUGIN_ROOT=/home/u/.claude/plugins/cache/x/telegram/0.0.6`

function awkProgram(marker: string): string {
  const line = channelsSh.split('\n').find((l) => l.includes(marker) && l.includes('awk'))
  if (!line) throw new Error(`${marker} awk line not found in channels.sh`)
  const m = line.match(/awk .*?'([^']*)'/)
  if (!m) throw new Error(`could not extract the awk program from ${marker}`)
  return m[1]!
}

function run(args: string, program: string, rows: string[]): string[] {
  const out = execSync(`awk ${args} '${program}'`, { input: rows.join('\n') + '\n', encoding: 'utf-8' })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

const pass1 = (rows: string[]) =>
  run(`-v needle='TELEGRAM_STATE_DIR=${CHAN}'`, awkProgram('ORPHAN_PIDS="'), rows)
const pass2 = (rows: string[]) =>
  run(`-v needle='CLAUDE_PLUGIN_ROOT=' -v prov='/telegram' -v subdir='${INSTALL}/agents/'`, awkProgram('ORPHAN_PIDS2='), rows)

describe('#842 the channels.sh orphan reap never kills the shared tmux server', () => {
  it('pass 1 (STATE_DIR) skips the tmux server in every row shape, and still reaps real orphans', () => {
    expect(pass1([TMUX_SERVER, TMUX_SERVER_COMM, TMUX_ABSOLUTE])).toEqual([])
    expect(pass1([TMUX_SERVER, ORPHAN_POLLER, TMUX_SERVER_COMM, ORPHAN_POLLER_WITH_TMUX_ENV])).toEqual(['5000', '5001'])
  })

  it('pass 2 (CLAUDE_PLUGIN_ROOT) skips the tmux server too, and still reaps old-build orphans', () => {
    expect(pass2([TMUX_NO_STATE, TMUX_SERVER])).toEqual([])
    expect(pass2([TMUX_NO_STATE, OLD_BUILD_ORPHAN])).toEqual(['5002'])
  })

  it('the dashboard-side scanner (channel-poller-reap.ts) skips the tmux server as well', () => {
    const ps = [TMUX_SERVER, TMUX_SERVER_COMM, TMUX_ABSOLUTE, ORPHAN_POLLER, ORPHAN_POLLER_WITH_TMUX_ENV].join('\n')
    expect(parsePollerPidsFromPs(ps, 'TELEGRAM_STATE_DIR', CHAN, 1)).toEqual([5000, 5001])
  })
})
