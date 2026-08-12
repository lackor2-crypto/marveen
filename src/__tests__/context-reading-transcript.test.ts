// The context gate can only fire on a number, so how the transcript is picked
// and classified IS the feature. Boss reported (2026-08-12) that compaction
// "does not work"; three of four agents were stuck on
// "context-tokens-unmeasurable (fail-closed)" forever. Two separate causes,
// both covered here:
//
//   1. The reader took the newest .jsonl by MTIME. Claude Code rewrites
//      timestamp-less metadata lines (last-prompt, mode, permission-mode,
//      custom-title) into a session file long after that session stopped
//      producing turns -- a `/rename` left an 8-line stub whose mtime was newer
//      than the live 113 KB transcript, and reading the stub found no usage.
//   2. Every "no number" answer looked identical to the gate, so a session that
//      had simply not run a turn yet (the smallest context possible) was
//      reported as a broken measurement and escalated to an alert.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readContextReadingFromProjectDir } from '../web/active-model.js'

const WORKING_DIR = '/home/u/agents/tester'

let root: string
let projectDir: string

function transcript(name: string, lines: unknown[], mtimeSec: number): void {
  const p = join(projectDir, name)
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  utimesSync(p, mtimeSec, mtimeSec)
}

const usageTurn = (ts: string, tokens: number) => ({
  type: 'assistant',
  timestamp: ts,
  message: { model: 'claude-opus-5', usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 12 } },
})

const syntheticTurn = (ts: string) => ({
  type: 'assistant',
  timestamp: ts,
  message: { model: '<synthetic>', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
})

const renameStub = (ts: string) => [
  { type: 'custom-title', customTitle: 'Gypsy' },
  { type: 'mode', mode: 'normal' },
  { type: 'permission-mode', permissionMode: 'bypassPermissions' },
  { type: 'system', subtype: 'local_command', timestamp: ts, content: '<command-name>/rename</command-name>' },
  { type: 'last-prompt', leafUuid: 'x' },
]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-reading-'))
  projectDir = join(root, '.claude', 'projects', '-home-u-agents-tester')
  mkdirSync(projectDir, { recursive: true })
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

// The reader resolves <config>/projects/<encoded-dir>, so point configDir at the
// temp root's .claude to keep the whole test inside the temp dir.
const read = () => readContextReadingFromProjectDir(WORKING_DIR, join(root, '.claude'))

describe('context reading: which transcript is the live one', () => {
  it('ignores a metadata stub whose mtime is newer than the live transcript', () => {
    // Live session: last real turn at 15:55, file not touched since.
    transcript('live.jsonl', [usageTurn('2026-08-12T15:55:00.000Z', 113_431)], 1_000_000)
    // Rename stub: content is OLDER (15:40) but metadata lines bumped the mtime
    // 13 minutes past the live file. This is the shape that broke the gate.
    transcript('stub.jsonl', renameStub('2026-08-12T15:40:00.000Z'), 1_000_800)

    expect(read()).toEqual({ tokens: 113_431, state: 'measured' })
  })

  it('still prefers a genuinely newer session over an older heavy one', () => {
    transcript('old-heavy.jsonl', [usageTurn('2026-08-12T10:00:00.000Z', 300_207)], 1_000_000)
    transcript('new-light.jsonl', [usageTurn('2026-08-12T16:00:00.000Z', 8_400)], 1_000_500)

    // A fresh light session must never be reported with the old session's size:
    // that would compact (or clear) a session that just started.
    expect(read()).toEqual({ tokens: 8_400, state: 'measured' })
  })

  it('falls back to mtime when no entry carries a timestamp', () => {
    transcript('a.jsonl', [{ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 111 } } }], 1_000_000)
    transcript('b.jsonl', [{ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 222 } } }], 1_000_900)

    expect(read().tokens).toBe(222)
  })
})

describe('context reading: why a number is missing', () => {
  it('reports a session that has not run a turn as fresh, not unmeasurable', () => {
    transcript('stub.jsonl', renameStub('2026-08-12T16:21:45.309Z'), 1_000_000)

    expect(read()).toEqual({ tokens: null, state: 'fresh' })
  })

  it('reports turns that carry no token counts as no-usage (quota-limited agent)', () => {
    transcript('limited.jsonl', [
      { type: 'user', timestamp: '2026-08-12T19:41:17.112Z', message: { role: 'user', content: 'hi' } },
      syntheticTurn('2026-08-12T19:41:17.985Z'),
    ], 1_000_000)

    expect(read()).toEqual({ tokens: null, state: 'no-usage' })
  })

  it('reports a missing project dir as unknown (stays fail-closed)', () => {
    rmSync(projectDir, { recursive: true, force: true })

    expect(read()).toEqual({ tokens: null, state: 'unknown' })
  })

  it('reports an empty project dir as unknown', () => {
    expect(read()).toEqual({ tokens: null, state: 'unknown' })
  })
})

describe('context reading: compaction boundary', () => {
  it('uses postTokens instead of the stale pre-compaction usage', () => {
    transcript('s.jsonl', [
      usageTurn('2026-08-12T19:00:00.000Z', 101_222),
      { type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-12T19:05:00.000Z', compactMetadata: { postTokens: 5_597 } },
    ], 1_000_000)

    // Right after /compact the session is idle, so the newest usage is still the
    // pre-compaction one. Reporting that would make compaction look broken.
    expect(read()).toEqual({ tokens: 5_597, state: 'measured' })
  })

  it('prefers a post-compaction turn over the boundary once one exists', () => {
    transcript('s.jsonl', [
      usageTurn('2026-08-12T19:00:00.000Z', 101_222),
      { type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-12T19:05:00.000Z', compactMetadata: { postTokens: 5_597 } },
      usageTurn('2026-08-12T19:10:00.000Z', 6_300),
    ], 1_000_000)

    expect(read()).toEqual({ tokens: 6_300, state: 'measured' })
  })
})
