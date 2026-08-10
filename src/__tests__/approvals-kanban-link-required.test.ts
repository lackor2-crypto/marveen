import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

// Boss 2026-08-10: every approval must be traceable back to a kanban card
// (structured payload OR an 8-hex-char id in the description), so the
// dashboard's "Kártya megnyitása" button never dead-ends again -- see the
// kanban-approval-workflow skill and src/web/routes/approvals.ts POST guard.
// The failure mode here is silence (an approval nobody can trace to its
// card), same class of bug as agent-put-fields.test.ts guards against, so
// this gets its own direct coverage rather than relying on incidental hits
// from other approval tests.

function fakePost(body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL('http://localhost:3420/api/approvals')
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

describe('POST /api/approvals requires a kanban card link', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('rejects an approval with no card reference anywhere', async () => {
    const { ctx, out } = fakePost({
      agent_id: 'lackor2-bot',
      category: 'marveen_kod_modositas',
      action_description: 'Fixed a bug in the widget, no card mentioned.',
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/noKanbanCard/)
  })

  it('accepts a card id via action_payload.kanban_card_id', async () => {
    const { ctx, out } = fakePost({
      agent_id: 'lackor2-bot',
      category: 'kanban_done',
      action_description: 'Card done, ready for approval.',
      action_payload: JSON.stringify({ kanban_card_id: 'a67de6ad' }),
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)
  })

  it('accepts a bare 8-hex-char card id anywhere in the description text', async () => {
    const { ctx, out } = fakePost({
      agent_id: 'lackor2-bot',
      category: 'marveen_kod_modositas',
      action_description: 'Token Monitor fix, elesben fut. Kiegeszites a67de6ad-hoz.',
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)
  })

  it('does not mistake a 7-char git short-hash for a card id', async () => {
    const { ctx, out } = fakePost({
      agent_id: 'lackor2-bot',
      category: 'marveen_kod_modositas',
      action_description: 'Fix applied. Commit bccab9f, deployed live.',
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
  })

  it('allows an explicit noKanbanCard opt-out for genuinely cardless approvals', async () => {
    const { ctx, out } = fakePost({
      agent_id: 'lackor2-bot',
      category: 'email_send',
      action_description: 'Send the weekly digest email.',
      noKanbanCard: true,
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)
  })
})
