import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The agent-terminal SSE tick (every 700 ms) and the background-task poller
// (every 10 s) must not fork tmux synchronously: that blocks the event loop.
describe('agent-terminal and background-tasks tmux probes are async', () => {
  for (const f of ['agent-terminal.ts', 'background-tasks.ts']) {
    it(`${f}: no execFileSync on the tmux probe path`, () => {
      const src = readFileSync(join(__dirname, '..', 'web', 'routes', f), 'utf-8')
      expect(src).not.toMatch(/execFileSync\(TMUX\(\), \['(capture-pane|has-session|list-sessions|kill-session)'/)
    })
  }
})
