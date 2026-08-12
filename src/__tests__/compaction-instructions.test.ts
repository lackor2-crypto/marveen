// The compaction prompt was written off as "Claude Code's, not ours". It is
// not: `/compact` takes free-text instructions, so every compaction this fork
// triggers can ask for the thing the context-management document asks for --
// state, not prose.
//
// Two properties matter enough to pin down. It must stay one line (tmux
// send-keys turns a newline into Enter, which would submit the command halfway
// through and drop the rest into the fresh context as a stray prompt), and
// every path that compacts must actually use it, because a bare /compact
// somewhere is a silent hole in the guarantee.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { COMPACT_COMMAND, COMPACT_INSTRUCTIONS } from '../context-compaction-instructions.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..')

describe('the compaction instructions', () => {
  it('are a single line', () => {
    expect(COMPACT_INSTRUCTIONS).not.toMatch(/[\r\n]/)
    expect(COMPACT_COMMAND).not.toMatch(/[\r\n]/)
  })

  it('start the command with the slash command itself', () => {
    expect(COMPACT_COMMAND.startsWith('/compact ')).toBe(true)
  })

  // Short enough to cost nothing, long enough to say something. A runaway
  // instruction would be re-sent on every compaction of every agent.
  it('stay a reasonable length', () => {
    expect(COMPACT_INSTRUCTIONS.length).toBeGreaterThan(200)
    expect(COMPACT_INSTRUCTIONS.length).toBeLessThan(1200)
  })

  it('ask for what the document says compaction loses first', () => {
    const asked = COMPACT_INSTRUCTIONS.toLowerCase()
    for (const must of ['exact numbers', 'constraints', 'decisions', 'rejected', 'next action']) {
      expect(asked, `missing: ${must}`).toContain(must)
    }
  })
})

describe('every path that compacts uses them', () => {
  for (const file of ['web/context-restart-gate-runner.ts', 'web/routes/agents.ts']) {
    it(`${file} sends no bare /compact`, () => {
      const src = readFileSync(join(SRC, file), 'utf8')
      // A quoted literal '/compact' (with or without a trailing space) is the
      // shape of a compaction sent without instructions.
      const bare = [...src.matchAll(/['"`]\/compact\s*['"`]/g)]
      expect(bare.map((m) => m[0])).toEqual([])
      expect(src).toContain('COMPACT_COMMAND')
    })
  }
})
