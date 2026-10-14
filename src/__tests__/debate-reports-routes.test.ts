// The report and analysis routes (#597, phase 6). The debate session is a stand-in (debate-run.test.ts has the real one);
// the project and the new document are real, in an in-memory database.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ session: null as unknown, all: [] as unknown[] }))

vi.mock('../debate-run.js', async (orig) => ({
  ...(await orig<typeof import('../debate-run.js')>()),
  loadDebateSession: () => h.session,
  loadAllDebateSessions: () => h.all,
}))

const { initDatabase } = await import('../db.js')
const { createProject, setProjectArchived } = await import('../projects.js')
const { getWorkItem, listWorkItems } = await import('../workbench.js')
const { documentOutline, hasDocModel } = await import('../workbench-docmodel.js')
const { parseObjections, parseReplies } = await import('../debate-modes.js')
const { buildObjectionBoard, summarizeBoard } = await import('../debate-board.js')
const { tryHandleDebateReports } = await import('../web/routes/debate-reports.js')

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = { on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && bodyStr) cb(Buffer.from(bodyStr)); if (ev === 'end') cb() } }
  return tryHandleDebateReports({ req, res, path: url.pathname, method, url, auth: { kind: 'session', user: 'boss' } } as any).then(handled => {
    if (!handled) throw new Error(`not handled: ${method} ${path}`)
    return out
  })
}

const OBJ = 'K1 [accuracy]\nQUOTE: "30 nap"\nOBJECTION: 15 nap a helyes.'
const REP = 'K1: ACCEPT\nREASON: igaz, a torveny 15 napot mond\nREWRITE: 15 nap'

function state(project: string | null): any {
  const rounds = [{ round: 1, prompt: 'Jo a level?', responses: [
    { model: 'a/crit', ok: true, role: 'critic', text: OBJ, objections: parseObjections(OBJ) },
    { model: 'b/def', ok: true, role: 'defender', text: REP, replies: parseReplies(REP) },
  ] }]
  const board = buildObjectionBoard(rounds)
  return {
    id: 's1', project, mode: 'critic', modeName: null, maxRounds: 6, strength: 'medium', swapRoles: false, judge: null, models: ['a/crit', 'b/def'],
    question: 'Jo a level?', attachments: [], rounds, concluded: true, consensus: true, summary: 'Rendben.', summaryBy: 'a/crit', orderCheck: null,
    board, boardSummary: summarizeBoard(board), advice: { stop: false }, conformity: { suspicious: false },
  }
}

let projectId = ''
beforeEach(() => {
  initDatabase(':memory:')
  const p = createProject({ name: 'Iroda' })
  if (!p.ok) throw new Error('projekt')
  projectId = p.project.id
  h.session = state(projectId)
  h.all = [state(projectId), state(null)]
})

describe('GET /api/debate/sessions/:id/export', () => {
  it('Markdown szoveg + fajlnev + cim; a "full" kapcsolo a teljes menetet is hozza', async () => {
    const r = await call('GET', '/api/debate/sessions/s1/export')
    expect(r.status).toBe(200)
    expect(r.body.name).toBe('Jo-a-level-vita.md')
    expect(r.body.title).toBe('Vitáztatás jelentés: Jo a level?')
    expect(r.body.markdown).toContain('## Kifogás-tábla')
    expect(r.body.markdown).not.toContain('## 1. kör')
    const full = await call('GET', '/api/debate/sessions/s1/export?full=1&lang=en')
    expect(full.body.markdown).toContain('## Round 1')
    expect(full.body.markdown).toContain('## Objection board')
  })

  it('ismeretlen vita: 404 a kert nyelven', async () => {
    h.session = null
    const r = await call('GET', '/api/debate/sessions/nincs/export?lang=en')
    expect(r.status).toBe(404)
    expect(r.body.message).toBe('This debate was not found.')
  })
})

describe('POST /api/debate/sessions/:id/document', () => {
  it('uj dokumentum munkadarab a vita projektjeben: van szerkesztheto szovege, a szakaszok a jelentes szakaszai', async () => {
    const r = await call('POST', '/api/debate/sessions/s1/document', {})
    expect(r.status).toBe(201)
    const id = r.body.item.id
    expect(r.body.item).toMatchObject({ title: 'Vitáztatás jelentés: Jo a level?', project_id: projectId })
    const item = getWorkItem(id)!
    expect(item.type).toBe('document')
    expect(item.created_by).toBe('boss')
    expect(hasDocModel(id)).toBe(true)
    const outline = documentOutline(id).sections
    expect(outline.map(s => s.title)).toEqual(['Kérdés vagy feladat', 'A vita beállításai', 'Eredmény', 'Kifogás-tábla'])
    expect(outline[3].blocks.map(b => b.text)).toContain('K1 [pontosság] – elfogadva')
    expect(listWorkItems(projectId).map(i => i.id)).toContain(id)
  })

  it('teljes menettel tobb szakasz; a vita nem valtozik (csak olvassuk)', async () => {
    const r = await call('POST', '/api/debate/sessions/s1/document', { full: true })
    expect(documentOutline(r.body.item.id).sections.map(s => s.title)).toContain('1. kör')
  })

  it('projekt nelkuli vita: 409, nem keszul munkadarab', async () => {
    h.session = state(null)
    const r = await call('POST', '/api/debate/sessions/s1/document', {})
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('no_project')
    expect(listWorkItems(projectId)).toEqual([])
  })

  it('archivalt projekt: 409, nem keszul munkadarab', async () => {
    setProjectArchived(projectId, true)
    const r = await call('POST', '/api/debate/sessions/s1/document', {})
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('project_archived')
    expect(listWorkItems(projectId)).toEqual([])
  })

  it('ismeretlen vita 404; hibas JSON 400', async () => {
    h.session = null
    expect((await call('POST', '/api/debate/sessions/x/document', {})).status).toBe(404)
  })
})

describe('GET /api/debate/analysis', () => {
  it('minden vita; a projekt-szuro; a hatar a valaszban', async () => {
    const all = await call('GET', '/api/debate/analysis')
    expect(all.status).toBe(200)
    expect(all.body.totals.debates).toBe(2)
    expect(all.body.min_debates).toBe(3)
    expect(all.body.rows[0]).toMatchObject({ mode: 'critic', first: 'a/crit', second: 'b/def', debates: 2, accepted: 2 })
    const one = await call('GET', `/api/debate/analysis?project=${projectId}`)
    expect(one.body.totals.debates).toBe(1)
    expect((await call('GET', '/api/debate/analysis?project=none')).body.totals.debates).toBe(1)
  })

  it('ures naplo: ures sorok, nem hiba', async () => {
    h.all = []
    const r = await call('GET', '/api/debate/analysis')
    expect(r.status).toBe(200)
    expect(r.body.rows).toEqual([])
  })
})
