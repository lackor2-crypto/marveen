// Kanban #207 (d345eb2c): pending-work assembly for a fresh/restarted session.
//
// These tests pin the PURE decision logic (limits, alreadyReplayed, the
// olvashatatlan-vs-empty distinction, assignee matching, injection text) via
// the injectable deps -- no filesystem, no database. That injectable design is
// the whole point: it lets case 4 force the "DB unreadable" branch and prove it
// is a DIFFERENT response from "no pending work" (Boss: "a nulla ket dolgot
// jelenthet").

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getPendingWork,
  buildPendingWorkContext,
  assigneeMatchesAgent,
  truncate,
  MAX_CARDS,
  MAX_MEMORIES,
  MEMORY_MAX_CHARS,
  type PendingWorkDeps,
  type PendingCardView,
  type PendingMemoryView,
  type InProgressSnapshot,
} from '../web/pending-work.js'
import { currentBotName, MAIN_AGENT_ID } from '../config.js'
import { REPLAY_SOURCES } from '../web/agent-taskstate.js'

const AGENT = 'lackor3'

function card(id: string, over: Partial<PendingCardView> = {}): PendingCardView {
  return { seq: undefined, id, title: 'T-' + id, status: 'in_progress', ...over }
}
function mem(id: number, content = 'm-' + id): PendingMemoryView {
  return { id, content }
}

// A fully controllable deps object. Each field defaults to a benign empty value;
// individual tests override just what they exercise.
function deps(over: Partial<PendingWorkDeps> = {}): PendingWorkDeps {
  return {
    listInProgressCards: (): InProgressSnapshot => ({ mine: [], unassignedCount: 0, othersCount: 0 }),
    getHotMemories: (): PendingMemoryView[] => [],
    hasActiveTaskState: (): boolean => false,
    ...over,
  }
}

describe('pending-work #207', () => {
  // CASE 1 -- only in_progress cards assigned to THIS agent are injected;
  // unassigned / other-agent cards are counted but NEVER injected.
  describe('1) assignee matching + only-mine injection', () => {
    it('assigneeMatchesAgent: exact id, case-insensitive, rejects others/empty', () => {
      expect(assigneeMatchesAgent('lackor3', 'lackor3')).toBe(true)
      expect(assigneeMatchesAgent('LacKor3', 'lackor3')).toBe(true)
      expect(assigneeMatchesAgent('  lackor3  ', 'lackor3')).toBe(true)
      expect(assigneeMatchesAgent('usalackor', 'lackor3')).toBe(false)
      expect(assigneeMatchesAgent('', 'lackor3')).toBe(false)
      expect(assigneeMatchesAgent(null, 'lackor3')).toBe(false)
      expect(assigneeMatchesAgent(undefined, 'lackor3')).toBe(false)
    })

    it('assigneeMatchesAgent: the MAIN agent also matches its DISPLAY name (free text)', () => {
      // assignee is free text: the main agent's cards are often assigned to its
      // display name (e.g. "Marvin"), not its agent_id. Host-agnostic: derive
      // the display name from config, never a hardcoded string.
      const display = currentBotName()
      expect(assigneeMatchesAgent(display, MAIN_AGENT_ID)).toBe(true)
      expect(assigneeMatchesAgent(display.toUpperCase(), MAIN_AGENT_ID)).toBe(true)
      // ...but a sub-agent is NOT matched by the main display name.
      expect(assigneeMatchesAgent(display, 'lackor3')).toBe(display.toLowerCase() === 'lackor3')
    })

    it("injects only mine; surfaces 'unassigned' vs 'others' counts separately", () => {
      const r = getPendingWork(
        AGENT,
        deps({
          listInProgressCards: () => ({ mine: [card('aaaaaaaa')], unassignedCount: 4, othersCount: 3 }),
        }),
      )
      expect(r.cards.map((c) => c.id)).toEqual(['aaaaaaaa'])
      expect(r.unassignedInProgressCount).toBe(4)
      expect(r.othersInProgressCount).toBe(3)
      expect(r.olvashatatlan).toBe(false)
      expect(r.alreadyReplayed).toBe(false)
      expect(r.additionalContext).toContain('aaaaaaaa')
      expect(r.additionalContext).toContain('Folytasd')
    })
  })

  // CASE 2 -- limits (5 cards + 5 memories) and memory truncation.
  describe('2) limits 5+5 and truncation', () => {
    it('caps injected cards at MAX_CARDS and memories at MAX_MEMORIES', () => {
      const manyCards = Array.from({ length: 9 }, (_, i) => card('c' + i))
      const manyMem = Array.from({ length: 9 }, (_, i) => mem(i))
      const r = getPendingWork(
        AGENT,
        deps({
          listInProgressCards: () => ({ mine: manyCards, unassignedCount: 0, othersCount: 0 }),
          getHotMemories: () => manyMem,
        }),
      )
      expect(r.cards).toHaveLength(MAX_CARDS)
      expect(r.memories).toHaveLength(MAX_MEMORIES)
    })

    it('truncate caps at MEMORY_MAX_CHARS with an ellipsis, leaves short text intact', () => {
      const long = 'x'.repeat(MEMORY_MAX_CHARS + 100)
      const t = truncate(long, MEMORY_MAX_CHARS)
      expect(t.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS)
      expect(t.endsWith('…')).toBe(true)
      expect(truncate('rovid', MEMORY_MAX_CHARS)).toBe('rovid')
      // collapses whitespace so the injected line stays single-line.
      expect(truncate('a\n\n  b', MEMORY_MAX_CHARS)).toBe('a b')
    })
  })

  // CASE 3 -- an ACTIVE taskstate record means taskstate-replay handles it:
  // pending-work stays silent (alreadyReplayed) so we do not double-inject.
  describe('3) active taskstate -> empty (alreadyReplayed)', () => {
    it('returns empty with alreadyReplayed and injects nothing', () => {
      const r = getPendingWork(
        AGENT,
        deps({
          hasActiveTaskState: () => true,
          // Even though there WOULD be cards, the taskstate guard wins first.
          listInProgressCards: () => ({ mine: [card('bbbbbbbb')], unassignedCount: 0, othersCount: 0 }),
          getHotMemories: () => [mem(1)],
        }),
      )
      expect(r.alreadyReplayed).toBe(true)
      expect(r.additionalContext).toBeNull()
      expect(r.cards).toHaveLength(0)
      expect(r.memories).toHaveLength(0)
    })
  })

  // CASE 4 -- "zero rows" is NOT "unreadable DB". Two structurally different
  // responses. This is the core fresh-install rule: never infer silence from a
  // count when the source itself might be unreachable.
  describe('4) unreadable DB != no pending work', () => {
    it('a throwing source -> olvashatatlan:true, context null', () => {
      const r = getPendingWork(
        AGENT,
        deps({
          listInProgressCards: () => {
            throw new Error('db locked')
          },
        }),
      )
      expect(r.olvashatatlan).toBe(true)
      expect(r.additionalContext).toBeNull()
    })

    it('a readable-but-empty source -> olvashatatlan:false (distinct response)', () => {
      const r = getPendingWork(AGENT, deps())
      expect(r.olvashatatlan).toBe(false)
      expect(r.additionalContext).toBeNull()
      // The two cases differ on exactly this flag -- that is the whole point.
    })
  })

  // CASE 5 -- fresh install (empty db, nothing assigned) is silent WITHOUT error.
  describe('5) fresh install -> empty, no error', () => {
    it('empty everything -> null context, no flags set, zero counts', () => {
      const r = getPendingWork(AGENT, deps())
      expect(r.additionalContext).toBeNull()
      expect(r.cards).toHaveLength(0)
      expect(r.memories).toHaveLength(0)
      expect(r.alreadyReplayed).toBe(false)
      expect(r.olvashatatlan).toBe(false)
      expect(r.unassignedInProgressCount).toBe(0)
      expect(r.othersInProgressCount).toBe(0)
    })
  })

  // CASE 6 -- template/code drift guard (2026-09-04 follow-up to #207): the
  // SessionStart matcher gates whether the harness invokes taskstate-replay.py
  // AT ALL -- it runs BEFORE agent-taskstate.ts's own source check, so a
  // matcher that lags REPLAY_SOURCES silently reproduces the exact "restart ->
  // idle session" bug this feature exists to fix, even though the TS decision
  // logic is correct. This test pins the two together so they cannot drift again.
  describe('6) SessionStart template matcher covers every REPLAY_SOURCES entry', () => {
    it('templates/settings.json.template matcher includes every REPLAY_SOURCES source', () => {
      const templatePath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
      const settings = JSON.parse(readFileSync(templatePath, 'utf-8')) as {
        hooks?: { SessionStart?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> }
      }
      const group = (settings.hooks?.SessionStart ?? []).find((g) =>
        (g.hooks ?? []).some((h) => (h.command ?? '').includes('taskstate-replay.py')),
      )
      expect(group, 'taskstate-replay.py SessionStart entry missing from the template').toBeDefined()
      const matcherSources = new Set((group?.matcher ?? '').split('|').filter(Boolean))
      for (const source of REPLAY_SOURCES) {
        expect(matcherSources.has(source), `template matcher "${group?.matcher}" is missing source "${source}"`).toBe(true)
      }
    })
  })

  // The injection text itself: greeting-discipline note + concrete identifiers +
  // a "folytasd" tail, so the resumed agent has a handle, not a vague nudge.
  describe('buildPendingWorkContext', () => {
    it('includes card id, memory id, a greeting note and a continue instruction', () => {
      const txt = buildPendingWorkContext(AGENT, [card('deadbeef', { seq: 207 })], [mem(42, 'utolso munka')])
      expect(txt).toContain('deadbeef')
      expect(txt).toContain('#207')
      expect(txt).toContain('42')
      expect(txt).toContain('utolso munka')
      expect(txt.toLowerCase()).toContain('koszon') // greeting-discipline note
      expect(txt).toContain('Folytasd')
      expect(txt).toContain('done') // the "do not move to done yourself" guard
    })
  })
})
