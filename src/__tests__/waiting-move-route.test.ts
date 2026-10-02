// #464 follow-up: the waiting guard measured THROUGH the route, per caller kind.
//
// The guard landed with a unit test of the pure function only; the HTTP round
// was not measured. Two things fell through that gap:
//   1. a dashboard opened with the access token (every fresh install until a
//      password is set) or a device key is a Bearer caller, i.e. "agent" to the
//      server -- its drag to waiting was refused and the card snapped back with
//      no question and no reason. The person must be able to answer;
//   2. the texts a code-bridge session reads (the task preface, the
//      card-done-to-waiting skill) still showed a move body the server refuses.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, createKanbanCard, getKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { buildCodeTaskPreamble } from '../web/code-task-preamble.js'
import type { RouteContext } from '../web/routes/types.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
type Auth = RouteContext['auth']
const TOKEN: Auth = { kind: 'token' }
const SESSION: Auth = { kind: 'session', user: 'owner' }
const DEVICE: Auth = { kind: 'device', device: 'phone' }

async function call(method: 'POST' | 'PUT', id: string, payload: unknown, auth: Auth): Promise<{ status: number; body: any }> {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL(`http://localhost:3420/api/kanban/${encodeURIComponent(id)}${method === 'POST' ? '/move' : ''}`)
  expect(await tryHandleKanban({ req, res, path: url.pathname, method, url, auth } as RouteContext)).toBe(true)
  return out
}
const move = (id: string, payload: Record<string, unknown>, auth: Auth) => call('POST', id, { sort_order: 0, ...payload }, auth)

describe('POST /api/kanban/:id/move into waiting -- who is asked for what (#464)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createKanbanCard({ id: 'aaaa0001', title: 'Parent', status: 'in_progress' })
  })

  it('a fleet token without the statement is refused, and the card does not move', async () => {
    const out = await move('aaaa0001', { status: 'waiting', actor: 'agent' }, TOKEN)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('completion_unconfirmed')
    expect(out.body.message).toContain('all_points_done')
    expect(getKanbanCard('aaaa0001')!.status).toBe('in_progress')
  })

  it('the same call with the statement goes through', async () => {
    const out = await move('aaaa0001', { status: 'waiting', actor: 'agent', all_points_done: true }, TOKEN)
    expect(out.status).toBe(200)
    expect(getKanbanCard('aaaa0001')!.status).toBe('waiting')
  })

  it('a password session is not asked', async () => {
    expect((await move('aaaa0001', { status: 'waiting' }, SESSION)).status).toBe(200)
    expect(getKanbanCard('aaaa0001')!.status).toBe('waiting')
  })

  it('a device key (the dashboard on a phone) is asked like a token, and can answer', async () => {
    const refused = await move('aaaa0001', { status: 'waiting' }, DEVICE)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('completion_unconfirmed')
    expect((await move('aaaa0001', { status: 'waiting', all_points_done: true }, DEVICE)).status).toBe(200)
    expect(getKanbanCard('aaaa0001')!.status).toBe('waiting')
  })

  it('other moves are untouched by the guard', async () => {
    expect((await move('aaaa0001', { status: 'testing', actor: 'agent' }, TOKEN)).status).toBe(200)
    expect(getKanbanCard('aaaa0001')!.status).toBe('testing')
  })

  describe('with an open sub-card', () => {
    beforeEach(() => {
      createKanbanCard({ id: 'bbbb0002', title: 'Open step', status: 'in_progress', parent_id: 'aaaa0001' })
      createKanbanCard({ id: 'cccc0003', title: 'Finished step', status: 'waiting', parent_id: 'aaaa0001' })
    })

    it('an agent stating "all done" is still refused, and is told which sub-card is open', async () => {
      const out = await move('aaaa0001', { status: 'waiting', actor: 'agent', all_points_done: true }, TOKEN)
      expect(out.status).toBe(409)
      expect(out.body.error).toBe('open_subtasks')
      expect(out.body.open.map((c: { title: string }) => c.title)).toEqual(['Open step'])
      expect(getKanbanCard('aaaa0001')!.status).toBe('in_progress')
    })

    it('the person in a password session may override it', async () => {
      expect((await move('aaaa0001', { status: 'waiting' }, SESSION)).body.error).toBe('open_subtasks')
      expect((await move('aaaa0001', { status: 'waiting', confirm_open_parts: true }, SESSION)).status).toBe(200)
      expect(getKanbanCard('aaaa0001')!.status).toBe('waiting')
    })

    it('the same override from a token-mode dashboard is ONE question, not two', async () => {
      // The person just confirmed "open, move it anyway". Demanding "all points
      // done" on top of that would contradict the answer they gave.
      const out = await move('aaaa0001', { status: 'waiting', confirm_open_parts: true }, TOKEN)
      expect(out.status).toBe(200)
      expect(getKanbanCard('aaaa0001')!.status).toBe('waiting')
    })
  })

  it('the bare override field on a card with nothing open does not replace the statement', async () => {
    const out = await move('aaaa0001', { status: 'waiting', confirm_open_parts: true }, TOKEN)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('completion_unconfirmed')
  })
})

describe('PUT /api/kanban/:id with status waiting -- the same guard, and the statement is an accepted key', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createKanbanCard({ id: 'aaaa0001', title: 'Parent', status: 'in_progress' })
  })

  it('refuses without the statement', async () => {
    const out = await call('PUT', 'aaaa0001', { status: 'waiting' }, TOKEN)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('completion_unconfirmed')
    expect(getKanbanCard('aaaa0001')!.status).toBe('in_progress')
  })

  it('accepts it with the statement (not a 400 unknown_field)', async () => {
    const out = await call('PUT', 'aaaa0001', { status: 'waiting', all_points_done: true }, TOKEN)
    expect(out.status).toBe(200)
    expect(getKanbanCard('aaaa0001')!.status).toBe('waiting')
  })

  it('a text edit of a card already in waiting is not asked anything', async () => {
    await call('PUT', 'aaaa0001', { status: 'waiting', all_points_done: true }, TOKEN)
    const out = await call('PUT', 'aaaa0001', { status: 'waiting', title: 'Parent, renamed' }, TOKEN)
    expect(out.status).toBe(200)
    expect(getKanbanCard('aaaa0001')!.title).toBe('Parent, renamed')
  })
})

// The dashboard's own half: web/app.js turns each refusal into a question for the
// person and resends with the answer. Run for real against a scripted server.
function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() not found in web/app.js`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() is not brace-balanced`)
}

type Reply = { status: number; body?: unknown }
function dashboard(replies: Reply[], answers: boolean[]) {
  const app = readFileSync(join(REPO, 'web', 'app.js'), 'utf-8')
  const sent: Record<string, unknown>[] = []
  const questions: string[] = []
  const fetchFn = async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body))
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!
    const self = { status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => reply.body, clone: () => self }
    return self
  }
  const win = { confirm: (text: string) => { questions.push(text); return answers.shift() ?? false } }
  const t = (key: string, params: Record<string, unknown> = {}) => `${key} ${JSON.stringify(params)}`
  const request = new Function(
    'fetch', 'window', 't',
    `${extractFn(app, 'kanbanWaitingQuestion')}\n${extractFn(app, 'kanbanMoveRequest')}\nreturn kanbanMoveRequest`,
  )(fetchFn, win, t) as (id: string, status: string, sort: number) => Promise<{ ok: boolean; cancelled?: boolean; status: number }>
  return { request, sent, questions }
}

const UNCONFIRMED: Reply = { status: 409, body: { error: 'completion_unconfirmed', message: 'x' } }
const OPEN: Reply = { status: 409, body: { error: 'open_subtasks', message: 'x', open: [{ seq: 465, title: 'Open step', status: 'in_progress' }] } }
const OK: Reply = { status: 200, body: { ok: true } }

describe('dashboard: a refused move to waiting becomes a question (web/app.js kanbanMoveRequest)', () => {
  it('an ordinary move asks nothing and sends no statement', async () => {
    const d = dashboard([OK], [])
    expect((await d.request('aaaa0001', 'testing', 2)).ok).toBe(true)
    expect(d.sent).toEqual([{ status: 'testing', sort_order: 2 }])
    expect(d.questions).toHaveLength(0)
  })

  it('token-mode dashboard: asks "is every point done?", yes resends with the statement', async () => {
    const d = dashboard([UNCONFIRMED, OK], [true])
    expect((await d.request('aaaa0001', 'waiting', 0)).ok).toBe(true)
    expect(d.questions).toHaveLength(1)
    expect(d.questions[0]).toContain('kanban.waiting.all_done_question')
    expect(d.sent[1]).toEqual({ status: 'waiting', sort_order: 0, all_points_done: true })
  })

  it('the answer "no" sends nothing more and is reported as cancelled, not as a failure', async () => {
    const d = dashboard([UNCONFIRMED, OK], [false])
    const r = await d.request('aaaa0001', 'waiting', 0)
    expect(r.cancelled).toBe(true)
    expect(r.ok).toBe(false)
    expect(d.sent).toHaveLength(1)
  })

  it('open sub-cards: the question names them, yes resends with the override', async () => {
    const d = dashboard([OPEN, OK], [true])
    expect((await d.request('aaaa0001', 'waiting', 0)).ok).toBe(true)
    expect(d.questions[0]).toContain('kanban.waiting.open_parts_question')
    expect(d.questions[0]).toContain('#465 Open step')
    expect(d.sent[1]).toEqual({ status: 'waiting', sort_order: 0, confirm_open_parts: true })
  })

  it('never asks the same question twice: a server that keeps refusing ends the loop', async () => {
    const d = dashboard([UNCONFIRMED], [true, true, true])
    const r = await d.request('aaaa0001', 'waiting', 0)
    expect(r.status).toBe(409)
    expect(r.cancelled).toBeUndefined()
    expect(d.questions).toHaveLength(1)
    expect(d.sent).toHaveLength(2)
  })

  it('a 409 that is not about waiting is handed back untouched', async () => {
    const d = dashboard([{ status: 409, body: { error: 'something_else' } }], [true])
    expect((await d.request('aaaa0001', 'waiting', 0)).status).toBe(409)
    expect(d.questions).toHaveLength(0)
    expect(d.sent).toHaveLength(1)
  })

  it('both questions exist in both languages, with the placeholders the code fills', () => {
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(REPO, 'web', 'lang', `${lang}.js`), 'utf-8')
      const line = (key: string) => src.split('\n').find((l) => l.includes(`'${key}'`)) ?? ''
      expect(line('kanban.waiting.open_parts_question')).toMatch(/\{n\}.*\{list\}.*\{col\}/)
      expect(line('kanban.waiting.all_done_question')).toContain('{col}')
    }
  })
})

describe('the texts a code-bridge session reads name the statement (#464)', () => {
  it('the task preface, in both languages', () => {
    for (const lang of ['hu', 'en'] as const) {
      const text = buildCodeTaskPreamble({ workspacePath: REPO, hostKind: 'unix', projectRoot: REPO, lang, webPort: 4999 })
      expect(text).toContain('"all_points_done":true')
      expect(text).toContain('409')
    }
    const hu = buildCodeTaskPreamble({ workspacePath: REPO, hostKind: 'unix', projectRoot: REPO, lang: 'hu', webPort: 4999 })
    expect(hu).toContain('CSAK az a kartya mehet, aminek MINDEN pontja kesz')
    expect(hu).toContain('a kartya NEM megy "waiting"-be')
    const en = buildCodeTaskPreamble({ workspacePath: REPO, hostKind: 'unix', projectRoot: REPO, lang: 'en', webPort: 4999 })
    expect(en).toContain('ONLY for a card whose EVERY point is done')
    expect(en).toContain('the card does NOT go to "waiting"')
  })

  it('the card-done-to-waiting skill shows a waiting move the server accepts', () => {
    const skill = readFileSync(join(REPO, 'seed-skills', 'card-done-to-waiting', 'SKILL.md'), 'utf-8')
    expect(skill).toMatch(/"status":"waiting"[^\n]*"all_points_done":true/)
    expect(skill).toContain('409 completion_unconfirmed')
    expect(skill).toContain('409 open_subtasks')
  })
})
