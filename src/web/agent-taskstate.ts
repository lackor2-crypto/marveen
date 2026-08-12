import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

// Compact task-state re-injection (Adam stability-fix #4, scoped 2026-06-03).
//
// When a sub-agent auto-compacts mid-task, Claude Code's own summary can lose
// the specific in-flight task-state and the agent "continues amnesically" --
// worst case RE-DELEGATING work already in flight. The PreCompact agent-hook
// (type:agent, already context-aware) writes a STRUCTURED record here; a
// SessionStart hook re-injects it on source=compact|resume.
//
// Fail-safe by design: if the PreCompact extraction fails (AUP/#209) no record
// is written -> re-injection no-ops -> Claude's own compact summary is used ->
// ZERO regression. The feature can only help, never harm.

const STORE_DIR = join(PROJECT_ROOT, 'store', 'agent-taskstate')

// Orphan hygiene only: the consumed flag is the PRIMARY single-replay guard, so
// the TTL can be generous -- a legitimate task may run many hours. 12h sweeps a
// truly abandoned record without risking dropping a real long-running task.
export const TASKSTATE_TTL_MS = 12 * 60 * 60 * 1000

// SessionStart sources we replay on. 'startup' IS included (2026-07-27): the
// original exclusion assumed a cold start is always a PLANNED one with no
// in-flight task. That holds for an operator restart, and is exactly wrong for
// the case this feature exists for -- a crash/watchdog respawn mid-task, which
// the harness also reports as source=startup. Observed: bigme hard-restarted at
// 07:31 in the middle of an update+debug thread and came back with only the
// channel-ledger replay (time-ordered chat turns), because the structured
// task-state was withheld on exactly the start that needed it most.
//
// Nothing else loosens: an unconsumed, non-empty, within-TTL record is still
// required, and the consumed flag still guarantees a single replay -- so a
// planned restart right after finishing work replays nothing (the record was
// either consumed or is empty), and at worst a stale-but-unconsumed record
// costs one short injected block that the agent can discard.
const REPLAY_SOURCES = new Set(['compact', 'resume', 'startup'])

// Structured state fields (Boss's context-management knowledge base, kanban
// 55af1bfe -> docs/context-compaction-knowledge.md). A one-line summary plus a
// done-list is not enough state to resume on: the document's points 5-7, 10, 30
// and 62 call out exactly what a rolling summary loses first -- the decisions,
// the approaches already ruled out, the user's hard constraints and the exact
// technical values. Those are extracted into their own fields so the compaction
// model cannot "prose them away".
//
// All of them are OPTIONAL and additive: a pre-existing 5-field record still
// reads, replays and behaves exactly as before.
export interface AgentTaskState {
  agent: string
  doneSteps: string[]        // completed -- do NOT repeat
  alreadyDelegated: string[] // already handed to another agent -- do NOT re-send
  nextAction: string         // where to resume
  pendingDecision: string    // open decision/blocker, if any
  summary: string            // one-line what-am-I-doing
  objective: string          // the overarching goal (survives many sub-tasks)
  phase: string              // PLANNING|IMPLEMENTING|TESTING|DEBUGGING|BLOCKED|WAITING_USER
  constraints: string[]      // pinned user requirements -- never negotiable
  decisions: string[]        // decision + reason, so "why?" survives
  rejected: string[]         // tried and ruled out -- do NOT retry
  filesChanged: string[]     // file + what changed (the file itself stays on disk)
  exactValues: string[]      // numbers/paths/ports/versions, verbatim, never rounded
  openQuestions: string[]    // unresolved, still needs an answer
  ts: number                 // epoch ms, written at PreCompact
  consumed: boolean          // set true AFTER a successful replay injection
}

/** The content-bearing half of a record: what emptiness and replay are judged on. */
export type TaskStateContent = Pick<AgentTaskState, 'doneSteps' | 'alreadyDelegated' | 'nextAction' | 'pendingDecision'> &
  Partial<Pick<AgentTaskState, 'objective' | 'phase' | 'constraints' | 'decisions' | 'rejected' | 'filesChanged' | 'exactValues' | 'openQuestions' | 'summary'>>

function sanitizeAgent(agent: string): string {
  // Defense: the agent name becomes a filename. Allow only the safe charset.
  return agent.replace(/[^a-zA-Z0-9_-]/g, '')
}

function recordPath(agent: string): string {
  return join(STORE_DIR, `${sanitizeAgent(agent)}.json`)
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 50)
}

// The checkpoint must not become the thing it is defending against: a state
// record that grows without bound is just context by another name. The added
// fields are therefore capped per item and per list -- one line each, index-like.
const STATE_ITEM_MAX = 300
const STATE_LIST_MAX = 25

function asStateList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => String(x).trim().replace(/\s+/g, ' ').slice(0, STATE_ITEM_MAX))
    .filter(Boolean)
    .slice(0, STATE_LIST_MAX)
}

/** True when the record carries no actual in-flight task (so nothing to replay). */
export function isEmptyTaskState(r: TaskStateContent): boolean {
  return (
    r.doneSteps.length === 0 &&
    r.alreadyDelegated.length === 0 &&
    !r.nextAction.trim() &&
    !r.pendingDecision.trim() &&
    // Structured state alone is worth replaying: a session whose only surviving
    // artefact is "we ruled out X" or "the user requires Y" must not silently
    // drop it just because there is no next action recorded.
    !(r.decisions?.length) &&
    !(r.rejected?.length) &&
    !(r.constraints?.length) &&
    !(r.filesChanged?.length) &&
    !(r.openQuestions?.length)
  )
}

/**
 * Pure decision: should this record be re-injected at SessionStart?
 * Replays ONLY when: record exists, not yet consumed, source is compact|resume
 * (never cold startup), within TTL, and the record actually holds a task.
 */
export function shouldReplayTaskState(
  record: AgentTaskState | null,
  source: string,
  nowMs: number,
  ttlMs: number = TASKSTATE_TTL_MS,
): boolean {
  if (!record) return false
  if (record.consumed) return false
  if (!REPLAY_SOURCES.has(source)) return false
  if (nowMs - record.ts > ttlMs) return false
  if (isEmptyTaskState(record)) return false
  return true
}

const SENTINEL = '=== TASK-FOLYTATAS (NEM uj feladat) ==='

/**
 * Build the additionalContext string. The structured do-not-resend lists are
 * the concrete defense against re-execution / re-delegation -- not the soft
 * framing alone (review hardening, Marveen 2026-06-03).
 */
export function buildTaskStateInjection(r: AgentTaskState): string {
  const lines: string[] = [
    SENTINEL,
    // Source-neutral wording: the same record is replayed after a compact, a
    // resume AND a crash respawn (source=startup, added 2026-07-27), so it must
    // not claim a compact happened.
    'A sessiond ujraindult egy FOLYAMATBAN LEVO feladat kozben (tomorites, resume vagy osszeomlas utani ujraindulas). Ez NEM uj feladat -- FOLYTASD onnan ahol abbamaradt. NE INDITSD ujra a mar kesz lepeseket, es NE delegald ujra amit mar atadtal.',
  ]
  // Order is deliberate (knowledge base points 39, 60, 61): models use the head
  // and the tail of a block far better than its middle, so the non-negotiable
  // constraints go near the top and the single NEXT ACTION goes last, where the
  // agent reads it right before acting. Everything in between is reference.
  const bullets = (items: string[]) => items.map((s) => `  - ${s}`).join('\n')
  if (r.objective?.trim()) lines.push(`CEL (a teljes feladat): ${r.objective.trim()}`)
  if (r.constraints?.length) lines.push('KOTOTT KOVETELMENYEK (a felhasznalo mondta ki, NEM alkuképes):\n' + bullets(r.constraints))
  if (r.summary.trim()) lines.push(`FELADAT: ${r.summary.trim()}`)
  if (r.phase?.trim()) lines.push(`FAZIS: ${r.phase.trim()}`)
  if (r.doneSteps.length) lines.push('MAR KESZ (NE ismeteld meg):\n' + bullets(r.doneSteps))
  if (r.alreadyDelegated.length) lines.push('MAR DELEGALVA (NE kuldd ujra):\n' + bullets(r.alreadyDelegated))
  if (r.rejected?.length) lines.push('MAR ELVETVE (NE probald ujra, hacsak a feltetel nem valtozott):\n' + bullets(r.rejected))
  if (r.decisions?.length) lines.push('DONTESEK (es miert):\n' + bullets(r.decisions))
  if (r.exactValues?.length) lines.push('PONTOS ERTEKEK (szo szerint, SOHA ne kerekitsd):\n' + bullets(r.exactValues))
  if (r.filesChanged?.length) lines.push('ERINTETT FAJLOK (a fajl maga a lemezen van, olvasd ujra ha kell):\n' + bullets(r.filesChanged))
  if (r.openQuestions?.length) lines.push('NYITOTT KERDESEK:\n' + bullets(r.openQuestions))
  if (r.pendingDecision.trim()) lines.push(`NYITOTT DONTES / BLOKKOLO: ${r.pendingDecision.trim()}`)
  if (r.nextAction.trim()) lines.push(`KOVETKEZO AKCIO (innen folytasd): ${r.nextAction.trim()}`)
  return lines.join('\n\n')
}

export function readTaskState(agent: string): AgentTaskState | null {
  const path = recordPath(agent)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AgentTaskState>
    return {
      agent: sanitizeAgent(agent),
      doneSteps: asStringArray(raw.doneSteps),
      alreadyDelegated: asStringArray(raw.alreadyDelegated),
      nextAction: String(raw.nextAction ?? '').trim(),
      pendingDecision: String(raw.pendingDecision ?? '').trim(),
      summary: String(raw.summary ?? '').trim(),
      objective: String(raw.objective ?? '').trim(),
      phase: String(raw.phase ?? '').trim(),
      constraints: asStateList(raw.constraints),
      decisions: asStateList(raw.decisions),
      rejected: asStateList(raw.rejected),
      filesChanged: asStateList(raw.filesChanged),
      exactValues: asStateList(raw.exactValues),
      openQuestions: asStateList(raw.openQuestions),
      ts: typeof raw.ts === 'number' ? raw.ts : 0,
      consumed: raw.consumed === true,
    }
  } catch (err) {
    logger.warn({ err, agent }, 'agent-taskstate: unreadable record')
    return null
  }
}

// Written by the PreCompact agent-hook. Always consumed:false + fresh ts, so a
// new compact's record supersedes (and re-arms) any prior one.
export function writeTaskState(
  agent: string,
  fields: Partial<Omit<AgentTaskState, 'agent' | 'ts' | 'consumed'>>,
  nowMs: number,
): AgentTaskState {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  const record: AgentTaskState = {
    agent: sanitizeAgent(agent),
    doneSteps: asStringArray(fields.doneSteps),
    alreadyDelegated: asStringArray(fields.alreadyDelegated),
    nextAction: String(fields.nextAction ?? '').trim(),
    pendingDecision: String(fields.pendingDecision ?? '').trim(),
    summary: String(fields.summary ?? '').trim(),
    objective: String(fields.objective ?? '').trim(),
    phase: String(fields.phase ?? '').trim(),
    constraints: asStateList(fields.constraints),
    decisions: asStateList(fields.decisions),
    rejected: asStateList(fields.rejected),
    filesChanged: asStateList(fields.filesChanged),
    exactValues: asStateList(fields.exactValues),
    openQuestions: asStateList(fields.openQuestions),
    ts: nowMs,
    consumed: false,
  }
  atomicWriteFileSync(recordPath(agent), JSON.stringify(record, null, 2))
  return record
}

export function markConsumed(agent: string): void {
  const r = readTaskState(agent)
  if (!r) return
  r.consumed = true
  atomicWriteFileSync(recordPath(agent), JSON.stringify(r, null, 2))
}

// Explicit done-clear (secondary to the consumed flag). Best-effort.
export function clearTaskState(agent: string): void {
  const path = recordPath(agent)
  try { if (existsSync(path)) unlinkSync(path) } catch { /* best effort */ }
}

// Orphan sweep: drop records older than the TTL. Cheap, opportunistic.
export function sweepOrphanTaskStates(nowMs: number, ttlMs: number = TASKSTATE_TTL_MS): number {
  if (!existsSync(STORE_DIR)) return 0
  let swept = 0
  for (const f of readdirSync(STORE_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(STORE_DIR, f), 'utf-8')) as Partial<AgentTaskState>
      if (typeof raw.ts !== 'number' || nowMs - raw.ts > ttlMs) {
        unlinkSync(join(STORE_DIR, f))
        swept++
      }
    } catch {
      try { unlinkSync(join(STORE_DIR, f)) ; swept++ } catch { /* ignore */ }
    }
  }
  return swept
}
