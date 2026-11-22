// #959 follow-up: the SAME bare "Szerver hiba" (HTTP 500, SQLITE_CONSTRAINT_CHECK) came from
// POST /api/kanban/:id/move with an unknown or missing status. Drives the real routes (not a source grep).
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

async function call(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  expect(await tryHandleKanban({ req, res, path: url.pathname, method, url } as RouteContext)).toBe(true)
  return out
}

const ID = 'MOVE0959'
const readCard = (): any => getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get(ID)

describe('#959 an unknown/missing kanban status or priority is a clear 400 on every write route', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare('INSERT INTO kanban_cards (id, title, description, status, priority, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(ID, 'Card', 'brief', 'planned', 'low', 0, now, now)
  })

  it('move with an unknown status: 400 naming the accepted values, card unchanged', async () => {
    const out = await call(`/api/kanban/${ID}/move`, 'POST', { status: 'blocked', actor: 'teszt' })
    expect(out.status).toBe(400)
    expect(out.body.message).toContain('Ismeretlen állapot: blocked')
    expect(out.body.message).toContain('planned, in_progress, testing, waiting, done')
    expect(readCard().status).toBe('planned')
  })

  it('move with NO status: 400, not a NOT NULL 500', async () => {
    const out = await call(`/api/kanban/${ID}/move`, 'POST', { actor: 'teszt' })
    expect(out.status).toBe(400)
    expect(readCard().status).toBe('planned')
  })

  it('NEGATIVE: a valid move still works', async () => {
    const out = await call(`/api/kanban/${ID}/move`, 'POST', { status: 'testing', actor: 'teszt' })
    expect(out.status).toBe(200)
    expect(readCard().status).toBe('testing')
  })

  it('PUT with an unknown priority/status: 400, card unchanged', async () => {
    const p = await call(`/api/kanban/${ID}`, 'PUT', { priority: 'medium', actor: 'teszt' })
    expect(p.status).toBe(400)
    expect(p.body.message).toContain('Ismeretlen prioritás: medium')
    const s = await call(`/api/kanban/${ID}`, 'PUT', { status: 'blocked', actor: 'teszt' })
    expect(s.status).toBe(400)
    expect(readCard().priority).toBe('low')
    expect(readCard().status).toBe('planned')
  })

  it('POST create with an unknown priority: 400, no card created', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) c FROM kanban_cards').get() as any).c
    const out = await call('/api/kanban', 'POST', { title: 'x', priority: 'medium' })
    expect(out.status).toBe(400)
    expect(out.body.error).toContain('medium')
    expect((getDb().prepare('SELECT COUNT(*) c FROM kanban_cards').get() as any).c).toBe(before)
  })
})
