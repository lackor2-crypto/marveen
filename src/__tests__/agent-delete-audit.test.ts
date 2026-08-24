// Deleting an agent must leave a trace, and must be recoverable.
//
// The real case, 2026-08-23: seven agents were deleted in one batch and one of
// them (Gypsy) had never been named by the owner. Afterwards NOTHING in this
// system could say who deleted it or when -- config_change_log had no row,
// store_file_audit does not watch agents/, dashboard.log had no line, and the
// directory was gone for good. The only reason Gypsy came back at all is that
// a nightly backup happened to predate the deletion, and even that restored it
// without its model or security profile (see scripts/backup.sh).
//
// So the DELETE branch now does two things it did not do before:
//   1. moves the directory into store/deleted-agents/<name>-<timestamp>
//      instead of rmSync-ing it, and
//   2. writes an `agents.deleted` row with the identity snapshot and the actor.
//
// A "no config" and an "unreadable config" must not look the same in that row:
// that silent zero is exactly what hid the original incident.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { getRecentConfigChanges, initDatabase } from '../db.js'
import { agentDir } from '../web/agent-config.js'
import { removeDesiredAgent } from '../web/agent-desired-state.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

const THROWAWAY = 'zz-delete-audit-probe'
const TRASH_ROOT = join(STORE_DIR, 'deleted-agents')

// In-memory DB: the audit row is read back here, never written to the live one.
beforeAll(() => {
  initDatabase(':memory:')
})

function fakeCtx(path: string, method: string, auth?: RouteContext['auth']): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> | null }
} {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      out.status = status
      return res
    },
    end(chunk?: string) {
      if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown>
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req: {} as RouteContext['req'], res, path: url.pathname, method, url, auth } as RouteContext,
    out,
  }
}

function trashEntries(): string[] {
  if (!existsSync(TRASH_ROOT)) return []
  return readdirSync(TRASH_ROOT).filter(e => e.startsWith(`${THROWAWAY}-`))
}

afterEach(() => {
  rmSync(agentDir(THROWAWAY), { recursive: true, force: true })
  for (const e of trashEntries()) rmSync(join(TRASH_ROOT, e), { recursive: true, force: true })
  removeDesiredAgent(THROWAWAY)
})

async function del(auth?: RouteContext['auth']) {
  const { ctx, out } = fakeCtx(`/api/agents/${THROWAWAY}`, 'DELETE', auth)
  const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
  return { handled, out }
}

function latestDeleteRow() {
  return getRecentConfigChanges(50).find(r => r.key === 'agents.deleted')
}

describe('DELETE /api/agents/:name leaves an audit trail', () => {
  it('moves the directory into store/deleted-agents instead of destroying it', async () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    writeFileSync(join(agentDir(THROWAWAY), 'SOUL.md'), 'ezt vissza kell tudni szerezni\n')

    const { out } = await del({ kind: 'session', user: 'lackor2' })

    expect(out.body?.ok).toBe(true)
    expect(existsSync(agentDir(THROWAWAY))).toBe(false)
    const kept = trashEntries()
    expect(kept.length).toBe(1)
    // Recoverable means the CONTENT survived, not just a directory name.
    expect(existsSync(join(TRASH_ROOT, kept[0]!, 'SOUL.md'))).toBe(true)
  })

  it('records who did it and what was deleted', async () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    writeFileSync(
      join(agentDir(THROWAWAY), 'agent-config.json'),
      JSON.stringify({ model: 'openai/gpt-5.6-luna-pro', securityProfile: 'developer-senior' }),
    )

    await del({ kind: 'session', user: 'lackor2' })

    const row = latestDeleteRow()
    expect(row).toBeDefined()
    expect(row!.actor).toBe('lackor2')
    // The snapshot is what makes the row useful on its own: it names the model
    // and the profile, which is precisely what the Gypsy restore had to
    // reconstruct by measurement because nothing had written them down.
    expect(row!.old_value).toContain('openai/gpt-5.6-luna-pro')
    expect(row!.old_value).toContain('developer-senior')
    expect(row!.old_value).toContain('visszaallithato:')
  })

  it('says "hianyzik" for a missing config -- never a silent blank', async () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })

    await del({ kind: 'token' })

    const row = latestDeleteRow()
    expect(row!.old_value).toContain('hianyzik')
    // A tokened caller has no username; the row must still name the kind
    // rather than leave the actor empty.
    expect(row!.actor).toBe('token')
  })

  it('writes no row and creates no trash when the agent does not exist', async () => {
    const before = latestDeleteRow()
    const { out } = await del({ kind: 'session', user: 'lackor2' })
    expect(out.status).toBe(404)
    expect(trashEntries().length).toBe(0)
    expect(latestDeleteRow()?.id).toBe(before?.id)
  })
})
