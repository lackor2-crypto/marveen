// Kanban #405: a dashboard recovery respawn (`tmux respawn-pane -k`) of the main
// channels session lost the plugin's *_STATE_DIR, so the respawned plugin wrote
// bot.pid under $CLAUDE_CONFIG_DIR/channels/<provider>; the channels.sh
// watchdog (which also kept a stale pane pid) then saw a "dead" plugin and
// restarted the whole service 180s later (2026-09-25 23:56 -> 23:59,
// 2026-09-26 02:18 -> 02:21). These tests lock every leg of the fix.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMainSessionRespawnCmd, mainChannelStateDirEnv } from '../web/channel-monitor.js'
import { PROJECT_ROOT } from '../config.js'

const repo = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

describe('main respawn carries the channel state dir (#405)', () => {
  const base = { claudePath: '/usr/local/bin/claude', pluginId: 'telegram@claude-plugins-official', model: 'm', continueSession: true }

  it('mainChannelStateDirEnv mirrors channels.sh MAIN_CHAN_DIR', () => {
    expect(mainChannelStateDirEnv('telegram')).toEqual({
      name: 'TELEGRAM_STATE_DIR',
      dir: join(PROJECT_ROOT, '.claude', 'channels', 'telegram'),
    })
    expect(mainChannelStateDirEnv('slack').name).toBe('SLACK_STATE_DIR')
  })

  it('exports the state dir before the claude binary starts', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, stateDirEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/x/.claude/channels/telegram' } })
    expect(cmd).toContain("export TELEGRAM_STATE_DIR='/x/.claude/channels/telegram'")
    expect(cmd.indexOf('TELEGRAM_STATE_DIR')).toBeLessThan(cmd.indexOf('/usr/local/bin/claude'))
  })

  it('omits the export when no state dir is given', () => {
    expect(buildMainSessionRespawnCmd(base)).not.toContain('_STATE_DIR')
  })

  it('every respawn-pane call site in channel-monitor passes stateDirEnv', () => {
    const src = read('src/web/channel-monitor.ts')
    const builds = src.match(/buildMainSessionRespawnCmd\(\{[\s\S]*?\n\s*\}\)/g) || []
    expect(builds.length).toBeGreaterThanOrEqual(3)
    for (const b of builds) expect(b).toContain('stateDirEnv: mainChannelStateDirEnv(')
  })

  it('stuck-modal-guard.sh respawn exports the state dir too', () => {
    const sh = read('scripts/stuck-modal-guard.sh')
    expect(sh).toMatch(/RESPAWN_CMD="[^\n]*\$\{STATE_DIR_ENV\}\$\{CFG_ENV\}/)
    expect(sh).toContain('_senv="TELEGRAM_STATE_DIR"')
  })

  it('channels.sh watchdog re-reads the pane pid inside the loop', () => {
    const sh = read('scripts/channels.sh')
    const loop = sh.slice(sh.indexOf('while $TMUX has-session -t "=$SESSION:"'))
    const refresh = loop.indexOf('_cur_pane_pid="$($TMUX list-panes -t "=$SESSION:"')
    const pgrep = loop.indexOf('/usr/bin/pgrep -P "$_watchdog_claude_pid" bun')
    expect(refresh).toBeGreaterThan(-1)
    expect(refresh).toBeLessThan(pgrep)
  })
})
