// Tests for the uncommitted-work guard (kanban 18bf8b2c, point 4).
//
// The risk being managed is nagging: a watcher that repeats itself teaches the
// owner to ignore it, and then the one message that mattered is ignored too.

import { describe, it, expect } from 'vitest'
import {
  INITIAL_UNCOMMITTED_STATE,
  describeUncommitted,
  dirtySignature,
  shouldAlertUncommitted,
  staleDirtyFiles,
  UNCOMMITTED_STALE_MS,
} from '../uncommitted-work.js'
import { parseDirtyPaths } from '../web/uncommitted-work-runner.js'

const NOW = 1_786_470_000_000
const old = (h: number) => ({ path: `src/f${h}.ts`, modifiedAt: NOW - h * 3_600_000 })

describe('staleDirtyFiles', () => {
  it('ignores work that is still warm', () => {
    expect(staleDirtyFiles([old(1)], NOW)).toEqual([])
  })

  it('reports the long-standing ones oldest first', () => {
    const stale = staleDirtyFiles([old(4), old(9), old(1)], NOW)
    expect(stale.map(f => f.path)).toEqual(['src/f9.ts', 'src/f4.ts'])
  })

  it('uses the documented threshold', () => {
    expect(staleDirtyFiles([{ path: 'a', modifiedAt: NOW - UNCOMMITTED_STALE_MS }], NOW)).toHaveLength(1)
    expect(staleDirtyFiles([{ path: 'a', modifiedAt: NOW - UNCOMMITTED_STALE_MS + 1 }], NOW)).toHaveLength(0)
  })
})

describe('shouldAlertUncommitted', () => {
  it('says nothing about a clean tree', () => {
    expect(shouldAlertUncommitted([], INITIAL_UNCOMMITTED_STATE)).toBe(false)
  })

  it('speaks once, then stays quiet about the same mess', () => {
    const stale = [old(5)]
    expect(shouldAlertUncommitted(stale, INITIAL_UNCOMMITTED_STATE)).toBe(true)
    const after = { lastSignature: dirtySignature(stale), lastAlertAt: NOW }
    expect(shouldAlertUncommitted(stale, after)).toBe(false)
  })

  it('speaks again when the mess changes', () => {
    const after = { lastSignature: dirtySignature([old(5)]), lastAlertAt: NOW }
    expect(shouldAlertUncommitted([old(5), old(6)], after)).toBe(true)
  })
})

describe('parseDirtyPaths', () => {
  it('reads modified, staged and renamed entries', () => {
    const out = parseDirtyPaths(' M web/app.js\nA  src/new.ts\nR  src/old.ts -> src/moved.ts\n')
    expect(out).toEqual(['web/app.js', 'src/new.ts', 'src/moved.ts'])
  })

  it('skips untracked scratch files', () => {
    expect(parseDirtyPaths('?? notes.txt\n M src/a.ts\n')).toEqual(['src/a.ts'])
  })
})

describe('describeUncommitted', () => {
  it('leads with how long the oldest has waited and what to do', () => {
    const msg = describeUncommitted(staleDirtyFiles([old(5), old(9)], NOW), NOW)
    expect(msg).toContain('9 oraja')
    expect(msg).toContain('worktree')
  })
})
