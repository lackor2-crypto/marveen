// "Why does it still say Haiku?" -- except it did not say Haiku either.
//
// Boss, 2026-08-16: "a beallitas agent alatt a sonett 5 van beallitva. marvinnak.
// akkor miert meg mindig a haiku van?" Measured that day, /api/marveen answered
// `"model": "unknown"`, and the card printed that word while .env named the model
// plainly. Two defects sat behind it:
//
//   1. the transcript reader gave up after ONE file. The freshest transcript was
//      13 KB of metadata with no `message.model` line at all, and the next
//      candidate in the ranking named the model.
//   2. there was no last resort. With the transcript silent and the statusline
//      snapshot stale, the answer became the literal string "unknown" instead of
//      what the install is configured to run.
//
// Card d80c50f6.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readConfiguredMainModel,
  resolveMainAgentModel,
  modelIdFromStatuslineLabel,
} from '../web/main-agent-model.js'
import { readActiveModelFromProjectDir, projectsDirFor } from '../web/active-model.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'main-model-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeEnv(model: string | null): void {
  const body = ['OTHER=1', model === null ? '' : `MAIN_AGENT_MODEL=${model}`, 'TAIL=2'].join('\n')
  writeFileSync(join(root, '.env'), body)
}

function writeSettings(content: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), content)
}

describe('readConfiguredMainModel', () => {
  it('prefers .env MAIN_AGENT_MODEL over settings.json', () => {
    // The precedence is not cosmetic: scripts/channels.sh launches with the .env
    // value, so reporting settings.json would name a model the next start will
    // not use.
    writeEnv('claude-haiku-4-5-20251001')
    writeSettings(JSON.stringify({ model: 'claude-sonnet-5' }))
    expect(readConfiguredMainModel(root)).toBe('claude-haiku-4-5-20251001')
  })

  it('falls back to settings.json when .env does not set the key', () => {
    writeEnv(null)
    writeSettings(JSON.stringify({ model: 'claude-sonnet-5' }))
    expect(readConfiguredMainModel(root)).toBe('claude-sonnet-5')
  })

  it('falls back to settings.json when there is no .env at all', () => {
    writeSettings(JSON.stringify({ model: 'claude-opus-5' }))
    expect(readConfiguredMainModel(root)).toBe('claude-opus-5')
  })

  it('returns an empty string when nothing is configured', () => {
    expect(readConfiguredMainModel(root)).toBe('')
  })

  it('returns an empty string rather than throwing on malformed settings.json', () => {
    writeSettings('{ not json')
    expect(readConfiguredMainModel(root)).toBe('')
  })

  it('ignores a non-string model in settings.json', () => {
    writeSettings(JSON.stringify({ model: 42 }))
    expect(readConfiguredMainModel(root)).toBe('')
  })

  it('trims whitespace around the configured value', () => {
    writeEnv('  claude-opus-5  ')
    expect(readConfiguredMainModel(root)).toBe('claude-opus-5')
  })
})

describe('resolveMainAgentModel', () => {
  const sources = (t: string | null, s: string | null, c: string) => ({
    fromTranscript: () => t,
    fromStatusline: () => s,
    configured: () => c,
  })

  it('takes the running process over everything else', () => {
    expect(resolveMainAgentModel(sources('t', 's', 'c')))
      .toEqual({ model: 't', source: 'transcript' })
  })

  it('takes a fresh statusline when the transcript is silent', () => {
    expect(resolveMainAgentModel(sources(null, 's', 'c')))
      .toEqual({ model: 's', source: 'statusline' })
  })

  it('falls back to the configured value, which is what was missing', () => {
    expect(resolveMainAgentModel(sources(null, null, 'claude-haiku-4-5-20251001')))
      .toEqual({ model: 'claude-haiku-4-5-20251001', source: 'configured' })
  })

  it('says unknown only when every source is silent', () => {
    expect(resolveMainAgentModel(sources(null, null, '')))
      .toEqual({ model: 'unknown', source: 'none' })
  })

  it('treats a whitespace-only reading as no reading', () => {
    expect(resolveMainAgentModel(sources('   ', null, 'c')))
      .toEqual({ model: 'c', source: 'configured' })
  })

  it('keeps going when a source throws', () => {
    const thrown = {
      fromTranscript: () => { throw new Error('unreadable') },
      fromStatusline: () => null,
      configured: () => 'claude-opus-5',
    }
    expect(resolveMainAgentModel(thrown))
      .toEqual({ model: 'claude-opus-5', source: 'configured' })
  })

  it('reports the source so a caller can say where the answer came from', () => {
    expect(resolveMainAgentModel(sources(null, 's', 'c')).source).toBe('statusline')
  })
})

describe('modelIdFromStatuslineLabel', () => {
  it('maps a spaced label to the canonical id', () => {
    expect(modelIdFromStatuslineLabel('Sonnet 5')).toBe(modelIdFromStatuslineLabel('sonnet-5'))
    expect(modelIdFromStatuslineLabel('Sonnet 5')).toBeTruthy()
  })

  it('answers null for an unknown label instead of guessing a version', () => {
    expect(modelIdFromStatuslineLabel('Sonnet 4.5-preview-xyz')).toBeNull()
  })

  it('answers null for an empty label', () => {
    expect(modelIdFromStatuslineLabel('   ')).toBeNull()
  })
})

describe('readActiveModelFromProjectDir with a model-less newest transcript', () => {
  function transcriptDir(workingDir: string): string {
    const dir = projectsDirFor(workingDir, join(root, '.claude'))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function write(dir: string, name: string, lines: object[], mtimeSec: number): void {
    const p = join(dir, name)
    writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    utimesSync(p, mtimeSec, mtimeSec)
  }

  // The probe transcripts live under the temp root, so the reader must be
  // pointed at THAT config dir -- the same one transcriptDir() built them in.
  // Without it the reader looks in the real ~/.claude, finds nothing and
  // answers null: the fallthrough cases fail, and the two null-expecting cases
  // below would go green for the wrong reason, proving nothing at all.
  function read(workingDir: string): string | null {
    return readActiveModelFromProjectDir(workingDir, undefined, join(root, '.claude'))
  }

  it('falls through to the next candidate when the freshest names no model', () => {
    // This is Boss's exact situation: a 13 KB metadata-only session ranked first.
    const workingDir = '/w/no-model-first'
    const dir = transcriptDir(workingDir)
    write(dir, 'stub.jsonl', [
      { type: 'summary', timestamp: '2026-08-16T10:14:15Z' },
      { type: 'system', subtype: 'custom-title', timestamp: '2026-08-16T10:14:16Z' },
    ], 1786000200)
    write(dir, 'real.jsonl', [
      { type: 'assistant', timestamp: '2026-08-16T10:05:15Z', message: { model: 'claude-haiku-4-5-20251001' } },
    ], 1786000100)
    expect(read(workingDir)).toBe('claude-haiku-4-5-20251001')
  })

  it('still prefers the freshest transcript when it does name a model', () => {
    const workingDir = '/w/fresh-wins'
    const dir = transcriptDir(workingDir)
    write(dir, 'older.jsonl', [
      { type: 'assistant', timestamp: '2026-08-16T09:00:00Z', message: { model: 'claude-opus-5' } },
    ], 1786000100)
    write(dir, 'newer.jsonl', [
      { type: 'assistant', timestamp: '2026-08-16T11:00:00Z', message: { model: 'claude-sonnet-5' } },
    ], 1786000200)
    expect(read(workingDir)).toBe('claude-sonnet-5')
  })

  it('returns null when no candidate names a model', () => {
    const workingDir = '/w/none-at-all'
    const dir = transcriptDir(workingDir)
    write(dir, 'a.jsonl', [{ type: 'summary', timestamp: '2026-08-16T10:00:00Z' }], 1786000100)
    write(dir, 'b.jsonl', [{ type: 'summary', timestamp: '2026-08-16T10:01:00Z' }], 1786000200)
    // null, not 'unknown': the string belongs to the presentation layer, and the
    // caller has one more source to try before saying anything to the owner.
    expect(read(workingDir)).toBeNull()
  })

  it('returns null when the project dir does not exist', () => {
    expect(read('/w/never-created')).toBeNull()
  })

  it('skips synthetic <...> model markers while falling through', () => {
    const workingDir = '/w/synthetic'
    const dir = transcriptDir(workingDir)
    write(dir, 'synthetic.jsonl', [
      { type: 'assistant', timestamp: '2026-08-16T10:10:00Z', message: { model: '<synthetic>' } },
    ], 1786000200)
    write(dir, 'real.jsonl', [
      { type: 'assistant', timestamp: '2026-08-16T10:00:00Z', message: { model: 'claude-opus-5' } },
    ], 1786000100)
    expect(read(workingDir)).toBe('claude-opus-5')
  })
})
