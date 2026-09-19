import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The Telegram delivery contracts live in hermetic bash suites (local Bot API
// stub, HOME and MARVEEN_ROOT pinned to a temp tree). Nothing ran them in CI, so
// a regression only showed up in the owner's chat. Card 40227dc9: every orphan
// answer arrived twice because two watchdog timers raced for the same pending
// file -- telegram-double-send.test.sh pins the fix, and it fails (5 sends out
// of 8 parallel runs) on the code before it.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const SUITES = [
  'telegram-double-send.test.sh',
  'telegram-watchdog-wedged.test.sh',
  'telegram-fallback-dedup.test.sh',
]

describe('telegram delivery shell contracts', () => {
  for (const suite of SUITES) {
    it(`${suite} passes`, () => {
      const script = join(ROOT, 'scripts', '__tests__', suite)
      if (!existsSync(script)) return
      const r = spawnSync('bash', [script], { encoding: 'utf-8', timeout: 90_000 })
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
      expect(r.stdout).toMatch(/All tests passed/)
    }, 100_000)
  }
})
