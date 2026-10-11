import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { STORE_DIR } from '../config.js'

// #546: the ONE source of "which schedule is faulty". The Overview self-check row and the Schedules list both read it,
// so the red mark on a schedule can never disagree with the count in the self-check.

export const COMMAND_HEALTH_FILE = 'command-task-health.json'

export interface ScheduleProblem {
  /** Machine-readable kind; the page turns it into a sentence (HU/EN). */
  code: 'command_fail'
  /** Consecutive failed runs (>= 1). */
  fails: number
  /** Epoch ms of the last run, 0 when unknown. */
  lastRun: number
  /** Why it failed (exit code + the start of the error output); '' when that run did not record it. */
  detail: string
}

type Health = Record<string, { lastStatus?: string; fails?: number; lastRun?: number; lastDetail?: string }>

function readHealth(path: string): Health | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Health } catch { return null }
}

/** Faulty schedules by task name. `health` is injectable for tests; null/unreadable file -> empty (nothing known). */
export function scheduleProblems(health: Health | null = readHealth(join(STORE_DIR, COMMAND_HEALTH_FILE))): Map<string, ScheduleProblem> {
  const out = new Map<string, ScheduleProblem>()
  if (!health || typeof health !== 'object') return out
  for (const name of Object.keys(health)) {
    const h = health[name]
    if (!h || h.lastStatus !== 'fail') continue
    out.set(name, { code: 'command_fail', fails: Math.max(1, Number(h.fails) || 1), lastRun: Number(h.lastRun) || 0, detail: typeof h.lastDetail === 'string' ? h.lastDetail : '' })
  }
  return out
}
