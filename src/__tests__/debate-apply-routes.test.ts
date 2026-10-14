// The routes behind the Workbench "Apply" button and the cost estimate (#597, phase 4): /api/debate/sessions/:id/apply[-preview]
// and /api/debate/estimate. The debate session is a stand-in (its own tests are debate-run.test.ts); the project, the work
// item and the document are real, in an in-memory database, so what is written is what the document really holds.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ session: null as unknown, estimate: vi.fn() }))

vi.mock('../debate-run.js', async (orig) => ({
  ...(await orig<typeof import('../debate-run.js')>()),
  loadDebateSession: () => h.session,
  estimateNextRound: (...a: unknown[]) => h.estimate(...a),
}))
vi.mock('../web/openrouter-models.js', () => ({
  fetchAllOpenRouterModels: async () => [],
  openRouterModelsWithin: async () => [{ id: 'openai/gpt-5.5', name: 'x', contextLength: 1, promptPrice: 2, completionPrice: 10, free: false }],
}))

const { initDatabase, getDb } = await import('../db.js')
const { createProject } = await import('../projects.js')
const { createWorkItem } = await import('../workbench.js')
const { addSection, addBlock, listBlocks } = await import('../workbench-docmodel.js')
const { docHistoryState } = await import('../workbench-dochistory.js')
const { parseObjections, parseReplies } = await import('../debate-modes.js')
const { buildObjectionBoard } = await import('../debate-board.js')
const { tryHandleDebateRun } = await import('../web/routes/debate-run.js')

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = { on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && bodyStr) cb(Buffer.from(bodyStr)); if (ev === 'end') cb() } }
  return tryHandleDebateRun({ req, res, path: url.pathname, method, url } as any).then(handled => {
    if (!handled) throw new Error(`not handled: ${method} ${path}`)
    return out
  })
}

const OBJECTIONS = [
  'K1 [accuracy]\nQUOTE: "30 nap"\nOBJECTION: 15 nap a helyes.',
  'K2 [wording]\nQUOTE: "kerjuk szepen"\nOBJECTION: hang.',
  'K3 [wording]\nQUOTE: "ez nincs a szovegben"\nOBJECTION: x.',
].join('\n\n')
const REPLIES = 'K1: ACCEPT\nREASON: igaz\nREWRITE: 15 nap\n\nK2: REJECT\nREASON: nem\n\nK3: ACCEPT\nREASON: ok\nREWRITE: valami'

function session(over: Record<string, unknown>) {
  const rounds = [{ round: 1, prompt: 'q', responses: [
    { model: 'a', ok: true, role: 'critic', objections: parseObjections(OBJECTIONS) },
    { model: 'b', ok: true, role: 'defender', replies: parseReplies(REPLIES) },
  ] }]
  return { id: 's1', project: '', concluded: true, rounds, board: buildObjectionBoard(rounds), ...over }
}

let projectId = ''
let itemId = ''
let sectionId = ''
const texts = () => listBlocks(itemId).map(b => b.text)

beforeEach(() => {
  initDatabase(':memory:')
  const p = createProject({ name: 'Iroda' })
  if (!p.ok) throw new Error('projekt')
  projectId = p.project.id
  const w = createWorkItem({ project_id: projectId, title: 'Level', type: 'document' })
  if (!w.ok) throw new Error('munkadarab')
  itemId = w.item.id
  const s = addSection(itemId, 'Fejezet')
  if (!s.ok) throw new Error('fejezet')
  sectionId = s.section.id
  addBlock(itemId, sectionId, { text: 'A hatarido 30 nap, kerjuk szepen.', author: 'owner' })
  h.session = session({ project: projectId })
  h.estimate.mockReset()
})

describe('POST /api/debate/sessions/:id/apply-preview es /apply', () => {
  it('nem lezart vitan se elonezet, se beiras: 409 not_concluded, a dokumentum erintetlen', async () => {
    h.session = session({ project: projectId, concluded: false })
    const r = await call('POST', '/api/debate/sessions/s1/apply', { item: itemId, ids: ['K1'] })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('not_concluded')
    expect((await call('POST', '/api/debate/sessions/s1/apply-preview', { item: itemId })).status).toBe(409)
    expect(texts()).toEqual(['A hatarido 30 nap, kerjuk szepen.'])
  })

  it('elonezet: csak az elfogadott, idezettel es uj szoveggel biro kifogasok; mindegyiknek allapota (kesz / nincs meg az idezet); a dokumentum nem valtozik', async () => {
    const r = await call('POST', '/api/debate/sessions/s1/apply-preview', { item: itemId })
    expect(r.status).toBe(200)
    expect(r.body.item).toEqual({ id: itemId, title: 'Level' })
    expect(r.body.changes.map((c: any) => [c.id, c.state])).toEqual([['K1', 'ready'], ['K3', 'not_found']])
    expect(r.body.changes[0]).toMatchObject({ old: '30 nap', new: '15 nap', ctxAfter: ', kerjuk szepen.' })
    expect(texts()).toEqual(['A hatarido 30 nap, kerjuk szepen.'])
    expect(docHistoryState(itemId).can_undo).toBe(false)
  })

  it('beiras: csak a bepipalt; uj lepes az elozmenyben (debate_apply); a valaszban az uj allapot', async () => {
    const r = await call('POST', '/api/debate/sessions/s1/apply', { item: itemId, ids: ['K1'] })
    expect(r.status).toBe(200)
    expect(r.body.applied).toEqual(['K1'])
    expect(r.body.skipped.map((s: any) => [s.id, s.reason])).toEqual([['K3', 'not_ticked']])
    expect(r.body.history).toMatchObject({ can_undo: true, undo: 'debate_apply' })
    expect(r.body.changes.find((c: any) => c.id === 'K1').state).toBe('not_found')
    expect(texts()).toEqual(['A hatarido 15 nap, kerjuk szepen.'])
  })

  it('bepipalas nelkul nem ir semmit', async () => {
    const r = await call('POST', '/api/debate/sessions/s1/apply', { item: itemId, ids: [] })
    expect(r.status).toBe(200)
    expect(r.body.applied).toEqual([])
    expect(texts()).toEqual(['A hatarido 30 nap, kerjuk szepen.'])
  })

  it('hibak: nincs vita, nincs munkadarab, ismeretlen munkadarab, nem dokumentum, masik projekt, archivalt projekt, nincs mit beirni', async () => {
    h.session = null
    expect((await call('POST', '/api/debate/sessions/x/apply', { item: itemId })).status).toBe(404)
    h.session = session({ project: projectId })
    expect((await call('POST', '/api/debate/sessions/s1/apply', {})).body.error).toBe('item_missing')
    expect((await call('POST', '/api/debate/sessions/s1/apply', { item: 'nincs' })).body.error).toBe('item_not_found')

    const video = createWorkItem({ project_id: projectId, title: 'Video', type: 'video' })
    if (!video.ok) throw new Error('video')
    expect((await call('POST', '/api/debate/sessions/s1/apply', { item: video.item.id })).body.error).toBe('item_not_document')

    const other = createProject({ name: 'Masik' })
    if (!other.ok) throw new Error('projekt')
    h.session = session({ project: other.project.id })
    expect((await call('POST', '/api/debate/sessions/s1/apply', { item: itemId })).body.error).toBe('item_other_project')

    h.session = session({ project: projectId })
    getDb().prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), projectId)
    const arch = await call('POST', '/api/debate/sessions/s1/apply', { item: itemId, ids: ['K1'] })
    expect(arch.body.error).toBe('project_archived')
    expect(texts()).toEqual(['A hatarido 30 nap, kerjuk szepen.'])

    getDb().prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(projectId)
    h.session = session({ project: projectId, board: [] })
    const none = await call('POST', '/api/debate/sessions/s1/apply', { item: itemId, ids: ['K1'] })
    expect(none.status).toBe(409)
    expect(none.body.error).toBe('nothing_to_apply')
  })

  it('az uzenet a kert nyelven jon', async () => {
    h.session = session({ project: projectId, concluded: false })
    const r = await call('POST', '/api/debate/sessions/s1/apply?lang=en', { item: itemId })
    expect(r.body.message).toMatch(/closed debate/)
  })
})

describe('POST /api/debate/estimate', () => {
  it('az arakat a katalogusbol adja a szamitasnak; a valasz jelzi, hogy voltak-e arak', async () => {
    h.estimate.mockReturnValue({ round: 1, next: { calls: [], usd: 0.01, unpriced: [], webSearch: [], free: false }, conclude: null })
    const r = await call('POST', '/api/debate/estimate', { question: 'q', models: ['openai/gpt-5.5', 'x/y'], mode: 'critic' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ round: 1, prices_known: true })
    const [input, prices] = h.estimate.mock.calls[0]
    expect(input).toMatchObject({ mode: 'critic' })
    expect(prices.get('openai/gpt-5.5')).toEqual({ promptPrice: 2, completionPrice: 10 })
  })

  it('a hiba a futtatasi hibakkal egyezik (ismeretlen mod 400, nincs vita 404)', async () => {
    const { DebateInputError } = await import('../debate-run.js')
    h.estimate.mockImplementation(() => { throw new DebateInputError('mode_unknown') })
    expect((await call('POST', '/api/debate/estimate', { models: ['a', 'b'] })).status).toBe(400)
    h.estimate.mockImplementation(() => { throw new DebateInputError('session_not_found') })
    expect((await call('POST', '/api/debate/estimate', { session: 'x' })).status).toBe(404)
  })
})
