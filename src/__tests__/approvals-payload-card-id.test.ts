/**
 * Approving a kanban_done request must move its card to done -- whatever shape
 * the requesting agent wrote the card reference in.
 *
 * Measured on the live approvals table, 2026-09-24: three approvals Boss had
 * approved (#379 payload "4637b37c", #350 payload "a0fc644e", #359 payload
 * {"card_id":"144fe69a"}) left their cards in waiting, and the reconcile loop
 * then raised a NEW pending request for each. The resolve path read only
 * {"kanban_card_id": ...}, while the pairing (approvalCardId) already fell back
 * to the description -- two answers to one question. And the POST refresh
 * branch overwrote a good payload with any payload the second request carried.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, createKanbanCard, createApproval, getKanbanCard, getApproval } from '../db.js'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-a' }
})

import { tryHandleApprovals, kanbanCardIdFromApproval } from '../web/routes/approvals.js'
import { approvalCardId, payloadCardId } from '../kanban-related.js'
import type { RouteContext } from '../web/routes/types.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function fakePost(path: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

function fakePatch(id: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = `/api/approvals/${id}`
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method: 'PATCH', url } as RouteContext, out }
}


describe('payloadCardId: every shape agents actually write', () => {
  it('documented, hand-written, bare and JSON-quoted bare ids', () => {
    expect(payloadCardId('{"kanban_card_id":"4637b37c"}')).toBe('4637b37c')
    expect(payloadCardId('{"card_id":"144FE69A"}')).toBe('144fe69a')
    expect(payloadCardId('{"card_id":"144fe69a"}')).toBe('144fe69a')
    expect(payloadCardId('a0fc644e')).toBe('a0fc644e')
    expect(payloadCardId(' a0fc644e ')).toBe('a0fc644e')
    expect(payloadCardId('"a0fc644e"')).toBe('a0fc644e')
    expect(payloadCardId('86beeadc-4fea-4e73-b82e-ec71fccf66d0')).toBe('86beeadc-4fea-4e73-b82e-ec71fccf66d0')
  })

  it('no card named -> null, never a guess', () => {
    for (const p of [null, undefined, '', '   ', '{}', '{"other":"x"}', 'not an id', '12345678901', '["a0fc644e"]', '{"kanban_card_id":42}', '{"kanban_card_id":"  "}', '{"card_id":"not-an-id"}']) {
      expect(payloadCardId(p)).toBeNull()
    }
  })

  it('description fallback prefers the "kanban-azonosító:" label over a commit hash', () => {
    expect(approvalCardId(null, 'commit e417372a landolt. Kártya #359 (kanban-azonosító: 144fe69a, nem git commit)')).toBe('144fe69a')
    expect(approvalCardId('garbage', 'Kártya (fc904177) kész.')).toBe('fc904177')
  })
})

describe('approve -> the card moves to done, for every payload shape', () => {
  beforeEach(() => initDatabase(':memory:'))

  const shapes: Array<[string, string | null, string]> = [
    ['documented JSON', '{"kanban_card_id":"4637b37c"}', 'Kártya kész.'],
    ['bare id', '4637b37c', 'Kártya kész.'],
    ['{"card_id"}', '{"card_id":"4637b37c"}', 'Kártya kész.'],
    ['no payload, labelled description', null, 'Kártya #379 (kanban-azonosító: 4637b37c, nem git commit) kész.'],
  ]
  for (const [name, payload, desc] of shapes) {
    it(name, async () => {
      createKanbanCard({ id: '4637b37c', title: 'Teszt kártya', status: 'waiting' })
      createApproval({ id: 'appr-1', agent_id: 'agent-b', category: 'kanban_done', action_description: desc, action_payload: payload })
      expect(kanbanCardIdFromApproval(getApproval('appr-1')!)).toBe('4637b37c')
      const { ctx, out } = fakePatch('appr-1', { status: 'approved', resolved_by: 'dashboard' })
      expect(await tryHandleApprovals(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(getKanbanCard('4637b37c')!.status).toBe('done')
    })
  }
})

describe('refreshing a pending request keeps a good card payload', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('a card-less payload does not overwrite {"kanban_card_id"}', async () => {
    createKanbanCard({ id: '144fe69a', title: 'Projektek fájlok', status: 'waiting' })
    createApproval({ id: 'appr-2', agent_id: 'agent-b', category: 'kanban_done', action_description: 'auto (144fe69a)', action_payload: '{"kanban_card_id":"144fe69a"}' })
    const { ctx, out } = fakePost('/api/approvals', {
      agent_id: 'agent-b', category: 'kanban_done',
      action_description: 'Kártya #359 (kanban-azonosító: 144fe69a) kész, tesztelve.',
      action_payload: '{"note":"nincs benne kartya"}',
      similar_reviewed: [],
    })
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const a = getApproval('appr-2')!
    expect(a.action_description).toContain('tesztelve')
    expect(a.action_payload).toBe('{"kanban_card_id":"144fe69a"}')
  })

  it('a payload that names the card may replace it', async () => {
    createKanbanCard({ id: '144fe69a', title: 'Projektek fájlok', status: 'waiting' })
    createApproval({ id: 'appr-3', agent_id: 'agent-b', category: 'kanban_done', action_description: 'auto (144fe69a)', action_payload: null })
    const { ctx, out } = fakePost('/api/approvals', {
      agent_id: 'agent-b', category: 'kanban_done',
      action_description: 'Kártya kész.', action_payload: '{"card_id":"144fe69a"}', similar_reviewed: [],
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(getApproval('appr-3')!.action_payload).toBe('{"card_id":"144fe69a"}')
  })
})

describe('the dashboard "open card" button reads the same shapes', () => {
  // The function body is evaluated on its own: it only uses its argument.
  const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
  const start = app.indexOf('function _approvalKanbanCardId(')
  const body = app.slice(start, app.indexOf('\n}\n', start) + 2)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(`${body}; return _approvalKanbanCardId`)() as (a: unknown) => string | null
  it('documented, {"card_id"}, bare, labelled description', () => {
    expect(fn({ action_payload: '{"kanban_card_id":"4637b37c"}', action_description: '' })).toBe('4637b37c')
    expect(fn({ action_payload: '{"card_id":"144fe69a"}', action_description: '' })).toBe('144fe69a')
    expect(fn({ action_payload: 'a0fc644e', action_description: '' })).toBe('a0fc644e')
    expect(fn({ action_payload: null, action_description: 'commit e417372a -- kanban-azonosító: 144fe69a' })).toBe('144fe69a')
    expect(fn({ action_payload: null, action_description: 'Email küldése.' })).toBeNull()
  })
})
