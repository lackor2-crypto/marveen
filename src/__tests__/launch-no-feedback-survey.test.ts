// #413 (rebuilt from upstream a8477d1f): every place an agent comes up must
// switch off Claude Code's session-feedback survey, which waits on a keypress
// an unattended agent never gets. The sub-agent spawn was the one launch point
// here that did not (the main session and the channel watchdog did).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('no feedback survey on any unattended launch (#413)', () => {
  for (const f of ['src/web/agent-process.ts', 'scripts/channels.sh', 'scripts/channel-watchdog.sh']) {
    it(f, () => expect(read(f)).toContain('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1'))
  }

  it('the sub-agent spawn puts it into the actual launch command, next to the prompt-suggestion switch', () => {
    const src = read('src/web/agent-process.ts')
    const line = src.split('\n').find((l) => l.includes('const promptSuggestionEnv ='))!
    expect(line).toContain('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1')
    expect(src).toMatch(/\$\{promptSuggestionEnv\}\$\{mcpEnv\}/)
  })
})
