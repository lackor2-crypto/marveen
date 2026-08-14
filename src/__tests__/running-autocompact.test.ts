import { describe, it, expect } from 'vitest'
import { foldAutocompactBySession, type ProcessArgs } from '../web/running-autocompact.js'

// The card used to print the CONFIGURED --autocompact value and call it the
// truth. The flag is passed at launch, so an agent running since yesterday
// keeps yesterday's number: the setting said 250000 while usalackor's process
// was still on 100000 and compacting every 2-3 minutes (Boss, 2026-08-14).
// This is the fold that turns "what is running" into something the card can
// compare against.
//
// Attribution is by tmux session on purpose. The first version keyed on
// CLAUDE_CONFIG_DIR, and on this install 13 of 15 agents share the default one
// -- one process's flag would have been reported as thirteen agents', stopped
// ones included.

const p = (argv: string[], session: string | null): ProcessArgs => ({ argv, session })
const CLAUDE = '/home/boss/.local/bin/claude'

describe('foldAutocompactBySession', () => {
  it('reads the flag of a running agent, keyed by its session', () => {
    const out = foldAutocompactBySession([
      p([CLAUDE, '--dangerously-skip-permissions', '--autocompact', '100000', '--model', 'claude-sonnet-5'], 'agent-usalackor'),
    ])
    expect(out.get('agent-usalackor')).toBe(100000)
  })

  it('keeps the agents apart even when they share a config dir', () => {
    const out = foldAutocompactBySession([
      p([CLAUDE, '--autocompact', '100000'], 'agent-gemma'),
      p([CLAUDE, '--autocompact', '250000'], 'agent-ling'),
    ])
    expect(out.get('agent-gemma')).toBe(100000)
    expect(out.get('agent-ling')).toBe(250000)
    expect(out.get('agent-north')).toBeUndefined()
  })

  it('reports the LOWER value when a session is only half restarted', () => {
    // Whichever fires first is the one the owner will notice.
    const out = foldAutocompactBySession([
      p([CLAUDE, '--autocompact', '250000'], 'agent-x'),
      p([CLAUDE, '--continue', '--autocompact', '100000'], 'agent-x'),
    ])
    expect(out.get('agent-x')).toBe(100000)
  })

  it('drops a process that could not be placed in a session', () => {
    // Guessing would print one agent's number on another agent's card.
    expect(foldAutocompactBySession([p([CLAUDE, '--autocompact', '100000'], null)]).size).toBe(0)
  })

  it('ignores processes that are not the claude CLI', () => {
    const out = foldAutocompactBySession([
      p(['/usr/bin/node', 'dist/index.js', '--autocompact', '999'], 'agent-a'),
      p(['/usr/bin/grep', 'claude', '--autocompact'], 'agent-a'),
      p(['claude-helper', '--autocompact', '999'], 'agent-a'),
    ])
    expect(out.size).toBe(0)
  })

  it('ignores a claude with no --autocompact at all (older CLI, flag unsupported)', () => {
    expect(foldAutocompactBySession([p([CLAUDE, '--continue'], 'agent-a')]).size).toBe(0)
  })

  it('ignores a malformed or trailing flag instead of guessing', () => {
    const out = foldAutocompactBySession([
      p([CLAUDE, '--autocompact'], 'agent-a'),
      p([CLAUDE, '--autocompact', 'auto'], 'agent-b'),
      p([CLAUDE, '--autocompact', '0'], 'agent-c'),
      p([CLAUDE, '--autocompact', '-5'], 'agent-d'),
    ])
    expect(out.size).toBe(0)
  })

  it('is empty when nothing is running, which reads as "unknown", not as zero', () => {
    expect(foldAutocompactBySession([]).size).toBe(0)
  })
})
