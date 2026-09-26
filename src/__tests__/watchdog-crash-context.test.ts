// A watchdog-os channels respawn (channel-watchdog.sh) a `respawn-pane -k`
// ELOTT mentse a crash-contextet, kulonben a -k eldobja a pane scrollbacket es
// a poller-halal oka nyomtalanul elvesz (Boss, 2026-09-13, kartya 6137eabd).
// Ez strukturalis orzes: a shell watchdog nem unit-tesztelheto viselkedesileg,
// de azt ki tudjuk kenyszeriteni, hogy a mento blokk letezzen ES a destruktiv
// respawn ELE keruljon -- egy kesobbi atrendezes ne dobhassa csendben ki.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const script = readFileSync(
  join(__dirname, '..', '..', 'scripts', 'channel-watchdog.sh'),
  'utf-8',
)

describe('channel-watchdog crash-context capture', () => {
  it('a crash-context logba ir', () => {
    expect(script).toContain('channel-poller-crash-context.log')
  })

  it('menti a pane utolso sorait (capture-pane -S)', () => {
    expect(script).toMatch(/capture-pane[^\n]*-S -60/)
  })

  it('rogziti a bot.pid poller-liveness jelet', () => {
    expect(script).toContain('poller-evidence:')
    expect(script).toContain('bot.pid')
  })

  it('#407: a bot.pid-et a #915 szerinti fo-agens mappabol olvassa, nem a fix regi utrol', () => {
    // A migracio utan a ~/.claude/channels/<provider> ures -- a fix ut minden
    // respawnnal hamis "DEAD" poller-bizonyitekot irt a naploba.
    expect(script).not.toMatch(/_wd_botpid_file="\$HOME\/\.claude\/channels/)
    expect(script).toContain('_wd_chan_dir="$MAIN_CHAN_DIR"')
    expect(script).toContain('_wd_botpid_file="$_wd_chan_dir/bot.pid"')
  })

  it('a mentes a destruktiv respawn-pane -k ELOTT tortenik', () => {
    const capturePos = script.indexOf('channel-poller-crash-context.log')
    // A TENYLEGES respawn-hivas (nem a kommentben emlitett) -- ez a destruktiv lepes.
    const respawnPos = script.search(/"\$TMUX_BIN"\s+respawn-pane\s+-k/)
    expect(capturePos).toBeGreaterThan(-1)
    expect(respawnPos).toBeGreaterThan(-1)
    expect(capturePos).toBeLessThan(respawnPos)
  })
})
