// A channels.sh KET restart-agon lephet ki service-manager restartra:
//   (a) "plugin dead for Ns"        -- a plugin FELALLT, majd meghalt,
//   (b) "plugin never started within Ns" -- a plugin FEL SE JOTT.
// Boss, 2026-09-14 (kartya d4aee0b5): eddig CSAK az (a) ag mentette a pane-t a
// crash-context logba; a 10:56-os restart a (b) agon ment, ezert nem lehetett
// latni, MIERT nem indult el a plugin. Ez a strukturalis orzes kikenyszeriti,
// hogy MINDKET ag mentsen pane-snapshotot a restart ELOTT -- egy kesobbi
// atrendezes ne dobhassa csendben ki a (b) ag mentesét.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const script = readFileSync(
  join(__dirname, '..', '..', 'scripts', 'channels.sh'),
  'utf-8',
)

describe('channels.sh never-started crash-context capture', () => {
  it('mindket restart-ag ir a crash-context logba (dead + never-started)', () => {
    const matches = script.match(/channel-poller-crash-context\.log/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('a "never started" ag pane-t ment a restart ELOTT', () => {
    const warnPos = script.indexOf('plugin never started within')
    expect(warnPos).toBeGreaterThan(-1)
    // A "never started" WARN es a kovetkezo `break` kozotti blokk mentsen pane-t.
    const breakPos = script.indexOf('break', warnPos)
    const block = script.slice(warnPos, breakPos)
    expect(block).toContain('capture-pane')
    expect(block).toContain('channel-poller-crash-context.log')
  })

  it('a mentes fail-open (a pane-hiba sem allitja meg a restartot)', () => {
    const warnPos = script.indexOf('plugin never started within')
    const breakPos = script.indexOf('break', warnPos)
    const block = script.slice(warnPos, breakPos)
    // capture-pane hibaja || true, es a teljes blokk >> ... || true
    expect(block).toMatch(/capture-pane[^\n]*\|\|\s*true/)
  })
})
