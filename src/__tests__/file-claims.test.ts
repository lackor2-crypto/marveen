// Tests for the file-claim decision (src/file-claims.ts, kanban 37129602).
//
// Two failure modes are being guarded against at once, and they pull in
// opposite directions: letting two agents overwrite each other (the bug), and
// blocking an agent that should be allowed to work (much worse -- a coordination
// feature that can freeze the fleet is not worth having). Most of these cases
// are about the second one.

import { describe, it, expect } from 'vitest'
import {
  decideClaim,
  describeBlock,
  isClaimExpired,
  isGuardedPath,
  CLAIM_TTL_MS,
  type FileClaim,
} from '../file-claims.js'

const NOW = 1_786_470_000_000
const held: FileClaim = { path: 'web/app.js', agent: 'lackor3', claimedAt: NOW - 60_000, note: 'wizard' }

describe('decideClaim', () => {
  it('allows an unclaimed path', () => {
    expect(decideClaim(null, 'usalackor', NOW)).toEqual({ allowed: true, reason: 'free' })
  })

  it('blocks the second agent on a live claim', () => {
    const d = decideClaim(held, 'usalackor', NOW)
    expect(d.allowed).toBe(false)
    if (d.allowed === false) {
      expect(d.holder).toBe('lackor3')
      expect(d.heldForMs).toBe(60_000)
    }
  })

  it('never blocks the holder itself (this is also the refresh path)', () => {
    expect(decideClaim(held, 'lackor3', NOW)).toEqual({ allowed: true, reason: 'own' })
  })

  it('lets an expired claim go, so a crashed agent cannot lock a file forever', () => {
    const stale = { ...held, claimedAt: NOW - CLAIM_TTL_MS - 1 }
    expect(decideClaim(stale, 'usalackor', NOW)).toEqual({ allowed: true, reason: 'expired' })
    expect(isClaimExpired(stale, NOW)).toBe(true)
    expect(isClaimExpired(held, NOW)).toBe(false)
  })
})

describe('isGuardedPath', () => {
  it('guards shared source', () => {
    expect(isGuardedPath('web/app.js', 'agents/usalackor/')).toBe(true)
    expect(isGuardedPath('src/web.ts', null)).toBe(true)
  })

  it('leaves an agent its own directory', () => {
    expect(isGuardedPath('agents/usalackor/notes.md', 'agents/usalackor/')).toBe(false)
    // ...but someone else writing there IS a collision worth catching.
    expect(isGuardedPath('agents/usalackor/notes.md', 'agents/lackor3/')).toBe(true)
  })

  it('never guards runtime state, logs or secrets', () => {
    for (const p of ['store/claudeclaw.db', 'logs/dashboard.log', 'node_modules/x/index.js', '.git/HEAD', '.env', 'store/x.log', 'HANDOFF.md']) {
      expect(isGuardedPath(p, null), p).toBe(false)
    }
  })

  it('ignores paths that escape the repo', () => {
    expect(isGuardedPath('../elsewhere/file.ts', null)).toBe(false)
    expect(isGuardedPath('', null)).toBe(false)
  })
})

describe('describeBlock', () => {
  it('tells the blocked agent what to do, not just what happened', () => {
    const msg = describeBlock('web/app.js', 'lackor3', 12 * 60_000, 'wizard')
    expect(msg).toContain('lackor3')
    expect(msg).toContain('12 perce')
    expect(msg).toContain('worktree')
  })

  it('rounds a fresh claim up to a minute rather than saying zero', () => {
    expect(describeBlock('a.ts', 'x', 900, null)).toContain('1 perce')
  })
})
