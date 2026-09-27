// #413: POST /api/kanban with a caller-supplied id. Here the id is resolved in
// src/kanban-create.ts, which also applies the labels -- to the GENERATED id,
// so a slug card lost its label as well. The upstream echo test
// (kanban-create-id-echo, kept byte-identical) does not cover labels.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, createLabel, getLabelsForCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function postCtx(payload: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL('http://localhost:3420/api/kanban')
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

describe('POST /api/kanban -- labels follow the stored id', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the labels land on the stored (supplied) id, not on a phantom one', async () => {
    createLabel({ id: 'lbl-x', name: 'teszt_cimke', color: '#888888' })
    const { ctx, out } = postCtx({ id: 'slug-with-label', title: 'Labelled slug card', labels: ['lbl-x'] })
    await tryHandleKanban(ctx)
    expect(out.body.id).toBe('slug-with-label')
    expect(getLabelsForCard('slug-with-label').map((l) => l.id)).toEqual(['lbl-x'])
  })
})
