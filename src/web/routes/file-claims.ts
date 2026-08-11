// HTTP surface for file claims (kanban 37129602, layer B).
//
// The consumer is scripts/hooks/file-claim-gate.py, a PreToolUse hook that runs
// on EVERY Edit/Write in the fleet -- so these handlers must be fast and must
// never throw: an exception here becomes a blocked edit for whoever is holding
// the keyboard. Errors resolve to "allowed" on the hook side, but they should
// not happen in the first place.
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { claimPath, listLiveClaims, releaseClaims, sweepExpiredClaims } from '../file-claims-store.js'
import { describeBlock } from '../../file-claims.js'
import type { RouteContext } from './types.js'

function normalizeRelPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/^\.\//, '')
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('..')) return null
  return trimmed
}

export async function tryHandleFileClaims(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/file-claims' && method === 'GET') {
    sweepExpiredClaims()
    json(res, { claims: listLiveClaims() })
    return true
  }

  // Claim (or refresh) one path. Answers { allowed, ... } -- the hook turns a
  // false into a denial with the message built here, so the wording lives in
  // one place for every agent.
  if (path === '/api/file-claims' && method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const agent = typeof body.agent === 'string' ? body.agent.trim() : ''
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null

      // Batch form, for ASSIGNING work rather than reacting to an edit. The
      // industry pattern behind it is write partitioning: the orchestrator hands
      // each agent a disjoint set of files up front, so collisions are prevented
      // instead of detected (see kanban 18bf8b2c). One call claims the whole set
      // and reports which parts someone else already holds.
      if (Array.isArray(body.paths)) {
        if (!agent) {
          json(res, { error: 'agent is required' }, 400)
          return true
        }
        const claimed: string[] = []
        const rejected: Array<{ path: string; holder: string; message: string }> = []
        for (const raw of body.paths.slice(0, 200)) {
          const p = normalizeRelPath(raw)
          if (!p) continue
          const d = claimPath(p, agent, note)
          if (d.allowed) claimed.push(p)
          else rejected.push({ path: p, holder: d.holder, message: describeBlock(p, d.holder, d.heldForMs, d.note) })
        }
        json(res, { agent, claimed, rejected, allAvailable: rejected.length === 0 })
        return true
      }

      const relPath = normalizeRelPath(body.path)
      if (!relPath || !agent) {
        json(res, { error: 'path and agent are required' }, 400)
        return true
      }
      const decision = claimPath(relPath, agent, note)
      if (decision.allowed) {
        json(res, { allowed: true, reason: decision.reason, path: relPath, agent })
        return true
      }
      json(res, {
        allowed: false,
        reason: 'held',
        path: relPath,
        holder: decision.holder,
        heldForMs: decision.heldForMs,
        message: describeBlock(relPath, decision.holder, decision.heldForMs, decision.note),
      })
      return true
    } catch (err) {
      // Answer 200 with allowed:true rather than 500: a broken claim service
      // must not become a fleet-wide editing block (see src/file-claims.ts).
      logger.warn({ err }, 'file-claims: claim failed; allowing the edit')
      json(res, { allowed: true, reason: 'error' })
      return true
    }
  }

  if (path === '/api/file-claims' && method === 'DELETE') {
    try {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const agent = typeof body.agent === 'string' ? body.agent.trim() : ''
      if (!agent) {
        json(res, { error: 'agent is required' }, 400)
        return true
      }
      const relPath = normalizeRelPath(body.path)
      const released = releaseClaims(agent, relPath ?? undefined)
      json(res, { ok: true, released })
      return true
    } catch (err) {
      logger.warn({ err }, 'file-claims: release failed')
      json(res, { ok: false }, 200)
      return true
    }
  }

  return false
}
