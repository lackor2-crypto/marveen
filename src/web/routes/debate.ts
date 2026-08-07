// Mostly-read-only API for the multi-model "vitaztatas" (debate/cross-check)
// feature. scripts/debate.mjs is the primary writer (append-only JSONL); this
// route parses store/debate-log.jsonl on each GET -- no DB table, no schema
// migration, matches the file's size (a handful of debates, not a
// high-volume log) and keeps the whole feature a self-contained add rather
// than touching the shared SQLite schema. DELETE is the one exception: it
// lets Boss prune stray one-round connectivity-test sessions (logged the same
// as real debates, but never reach a `conclude` entry) out of the archive.

import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { PROJECT_ROOT } from '../../config.js'
import type { RouteContext } from './types.js'

const LOG_PATH = join(PROJECT_ROOT, 'store', 'debate-log.jsonl')

interface RoundEntry {
  ts: number
  session: string
  round: number
  type: 'round'
  prompt: string
  model: string
  ok: boolean
  text: string | null
  tokensIn: number | null
  tokensOut: number | null
  error: string | null
}

interface ConcludeEntry {
  ts: number
  session: string
  type: 'conclude'
  consensus: boolean
  summary: string
}

type LogEntry = RoundEntry | ConcludeEntry

function isRound(e: LogEntry): e is RoundEntry {
  return e.type === 'round'
}

function isConclude(e: LogEntry): e is ConcludeEntry {
  return e.type === 'conclude'
}

// Malformed/legacy lines (the format gained `type`/`prompt`/`text` fields
// after the first version of debate.mjs) are skipped individually rather
// than failing the whole read -- one bad line must not blank the page.
function readLog(): LogEntry[] {
  if (!existsSync(LOG_PATH)) return []
  const raw = readFileSync(LOG_PATH, 'utf-8')
  const out: LogEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && (parsed.type === 'round' || parsed.type === 'conclude')) out.push(parsed)
    } catch { /* skip malformed line */ }
  }
  return out
}

// Rewrites the log with all lines for `sessionId` removed. Atomic (tmp file
// + rename in the same directory) so a crash mid-write can't half-truncate
// the file out from under a concurrent GET.
function deleteSession(sessionId: string): boolean {
  if (!existsSync(LOG_PATH)) return false
  const raw = readFileSync(LOG_PATH, 'utf-8')
  const lines = raw.split('\n').filter(l => l.trim())
  const kept: string[] = []
  let removed = false
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && parsed.session === sessionId) { removed = true; continue }
    } catch { /* keep malformed lines as-is */ }
    kept.push(line)
  }
  if (!removed) return false
  const tmpPath = `${LOG_PATH}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, kept.length ? kept.join('\n') + '\n' : '')
  renameSync(tmpPath, LOG_PATH)
  return true
}

export async function tryHandleDebate(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/debate/sessions' && method === 'GET') {
    try {
      const entries = readLog()
      const bySession = new Map<string, LogEntry[]>()
      for (const e of entries) {
        if (!bySession.has(e.session)) bySession.set(e.session, [])
        bySession.get(e.session)!.push(e)
      }
      const sessions = Array.from(bySession.entries()).map(([id, es]) => {
        const rounds = es.filter(isRound)
        const conclude = es.find(isConclude)
        const models = Array.from(new Set(rounds.map(r => r.model)))
        const roundCount = rounds.reduce((m, r) => Math.max(m, r.round), 0)
        const firstRoundPrompt = rounds.find(r => r.round === 1)?.prompt ?? ''
        const startedAt = es.reduce((min, e) => Math.min(min, e.ts), Infinity)
        const lastAt = es.reduce((max, e) => Math.max(max, e.ts), 0)
        return {
          id,
          startedAt: Number.isFinite(startedAt) ? startedAt : lastAt,
          lastAt,
          rounds: roundCount,
          models,
          questionPreview: firstRoundPrompt.slice(0, 140),
          consensus: conclude ? conclude.consensus : null,
          summary: conclude ? conclude.summary : null,
          concluded: !!conclude,
        }
      }).sort((a, b) => b.lastAt - a.lastAt)
      json(res, { sessions })
    } catch (err) {
      logger.error({ err }, 'debate sessions list failed')
      json(res, { error: 'Failed to load debate sessions' }, 500)
    }
    return true
  }

  const sessionMatch = path.match(/^\/api\/debate\/sessions\/([^/]+)$/)
  if (sessionMatch && method === 'DELETE') {
    try {
      const id = decodeURIComponent(sessionMatch[1])
      if (deleteSession(id)) { json(res, { ok: true }); return true }
      json(res, { error: 'Not found' }, 404)
    } catch (err) {
      logger.error({ err }, 'debate session delete failed')
      json(res, { error: 'Failed to delete debate session' }, 500)
    }
    return true
  }
  if (sessionMatch && method === 'GET') {
    try {
      const id = decodeURIComponent(sessionMatch[1])
      const entries = readLog().filter(e => e.session === id)
      if (!entries.length) { json(res, { error: 'Not found' }, 404); return true }
      const rounds = entries.filter(isRound)
      const conclude = entries.find(isConclude)

      const byRound = new Map<number, RoundEntry[]>()
      for (const r of rounds) {
        if (!byRound.has(r.round)) byRound.set(r.round, [])
        byRound.get(r.round)!.push(r)
      }
      const roundsOut = Array.from(byRound.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([round, forRound]) => ({
          round,
          prompt: forRound[0]?.prompt ?? '',
          responses: forRound.map(e => ({
            model: e.model, ok: e.ok, text: e.text, error: e.error, tokensIn: e.tokensIn, tokensOut: e.tokensOut,
          })),
        }))

      json(res, {
        id,
        rounds: roundsOut,
        consensus: conclude ? conclude.consensus : null,
        summary: conclude ? conclude.summary : null,
      })
    } catch (err) {
      logger.error({ err }, 'debate session detail failed')
      json(res, { error: 'Failed to load debate session' }, 500)
    }
    return true
  }

  if (path === '/api/debate/stats' && method === 'GET') {
    try {
      const rounds = readLog().filter(isRound)
      const byModel = new Map<string, { calls: number, ok: number, fail: number, tokensIn: number, tokensOut: number }>()
      for (const e of rounds) {
        if (!byModel.has(e.model)) byModel.set(e.model, { calls: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0 })
        const s = byModel.get(e.model)!
        s.calls++
        if (e.ok) s.ok++
        else s.fail++
        s.tokensIn += e.tokensIn ?? 0
        s.tokensOut += e.tokensOut ?? 0
      }
      const totalCalls = rounds.length
      const models = Array.from(byModel.entries())
        .map(([model, s]) => ({ model, ...s, sharePct: totalCalls ? Math.round((s.calls / totalCalls) * 1000) / 10 : 0 }))
        .sort((a, b) => b.calls - a.calls)
      json(res, { totalCalls, models })
    } catch (err) {
      logger.error({ err }, 'debate stats failed')
      json(res, { error: 'Failed to load debate stats' }, 500)
    }
    return true
  }

  return false
}
