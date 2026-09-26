// #404: a comment for a card id that does not exist (a typo such as
// `cd19e75c-`) used to be stored "successfully" against no card at all --
// invisible on the board, while the sender believed it was there.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, getDb } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function call(method: string, path: string, body: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const buf = Buffer.from(JSON.stringify(body))
  const req: any = {
    headers: { 'content-length': String(buf.length) },
    on(event: string, cb: (chunk?: Buffer) => void) { if (event === 'data') cb(buf); if (event === 'end') cb(); return req },
    destroy() { /* no socket */ },
  }
  const url = new URL('http://localhost:3420' + path)
  return tryHandleKanban({ req, res, path: url.pathname, method, url } as RouteContext).then(() => out)
}

beforeEach(() => { initDatabase(':memory:') })

describe('komment nem letezo kartyara', () => {
  it('404, es semmi nem kerul az adatbazisba', async () => {
    const id = 'abcd1234'
    createKanbanCard({ id, title: 'Valodi kartya' })
    const bad = await call('POST', `/api/kanban/${id}-/comments`, { author: 'teszt', content: 'x' })
    expect(bad.status).toBe(404)
    const n = (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_comments').get() as { n: number }).n
    expect(n).toBe(0)
    const ok = await call('POST', `/api/kanban/${id}/comments`, { author: 'teszt', content: 'x' })
    expect(ok.body.card_id).toBe(id)
  })
})
