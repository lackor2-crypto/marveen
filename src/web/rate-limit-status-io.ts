// I/O for the rate-limit snapshot written by scripts/hooks/statusline.py.
// Pure-logic tiering lives in ../rate-limit-status.ts; this module only reads
// the JSON file the statusline script maintains per agent.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import type { RateLimitSnapshot } from '../rate-limit-status.js'

const SNAPSHOT_DIR = join(PROJECT_ROOT, 'store', 'rate-limit-status')

function snapshotPath(agentId: string): string {
  // Agent ids are already restricted to filesystem-safe characters at
  // creation time (sanitizeAgentName); this module only ever reads.
  return join(SNAPSHOT_DIR, `${agentId}.json`)
}

/** Reads the latest rate-limit snapshot for an agent, or null if none exists yet. */
export function readRateLimitSnapshot(agentId: string): RateLimitSnapshot | null {
  const path = snapshotPath(agentId)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return null
    const win = (w: unknown): RateLimitSnapshot['fiveHour'] => {
      if (!w || typeof w !== 'object') return null
      const o = w as Record<string, unknown>
      return {
        usedPct: typeof o.usedPct === 'number' && Number.isFinite(o.usedPct) ? o.usedPct : null,
        resetsAt: typeof o.resetsAt === 'number' && Number.isFinite(o.resetsAt) ? o.resetsAt : null,
      }
    }
    return {
      agent: typeof raw.agent === 'string' ? raw.agent : agentId,
      model: typeof raw.model === 'string' ? raw.model : null,
      contextPct: typeof raw.contextPct === 'number' && Number.isFinite(raw.contextPct) ? raw.contextPct : null,
      fiveHour: win(raw.fiveHour),
      sevenDay: win(raw.sevenDay),
      updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    }
  } catch {
    return null
  }
}
