import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The python hooks carry their own --self-test, and until now nothing ran them.
// A self-test nobody calls is not a test: precompact-checkpoint.py shipped with
// four separate defects (the isMeta filter throwing away every --channels
// Telegram message, machine wake-ups stored as owner instructions, a ~2 KB
// scheduled-task preamble stored 27 times as if the owner had said it, and a
// "/compact ..." slash command stored as the agent's next action) and every one
// of them was found by hand, on the live transcripts, after the hook was already
// running in production.
//
// So the suite calls them. They are pure and self-contained -- no dashboard, no
// network, no live install -- and they fail loudly with a diff.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const HOOKS = [
  'precompact-checkpoint.py',
  'channel-inbox-drain.py',
  'channel-inbox-stop-drain.py',
]

describe('python hook self-tests', () => {
  for (const hook of HOOKS) {
    it(`${hook} --self-test passes`, () => {
      const script = join(ROOT, 'scripts', 'hooks', hook)
      // Skipping is the honest outcome when the file is not in this checkout:
      // failing would only report on the sync, not on the hook.
      if (!existsSync(script)) return
      const out = execFileSync('python3', [script, '--self-test'], {
        encoding: 'utf-8',
        timeout: 30_000,
      })
      expect(out.toLowerCase()).toMatch(/ok|passed/)
    })
  }
})
