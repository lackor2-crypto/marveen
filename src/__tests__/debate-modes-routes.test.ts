// The debate mode editor's routes (#597, phase 3): /api/debate/modes. The store file is a real one in a temp folder.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'

const h = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (orig) => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  h.dir = mkdtempSync(join(tmpdir(), 'debate-modes-routes-'))
  return { ...(await orig<typeof import('../config.js')>()), STORE_DIR: h.dir }
})

const { tryHandleDebateModes } = await import('../web/routes/debate-modes.js')
const { DEBATE_MODES_PATH } = await import('../debate-mode-store.js')

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req: any = { on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && bodyStr) cb(Buffer.from(bodyStr)); if (ev === 'end') cb() } }
  return tryHandleDebateModes({ req, res, path: url.pathname, method, url } as any).then(handled => {
    if (!handled) throw new Error(`not handled: ${method} ${path}`)
    return out
  })
}

beforeEach(() => { rmSync(DEBATE_MODES_PATH, { force: true }) })
afterAll(() => { rmSync(h.dir, { recursive: true, force: true }) })

describe('/api/debate/modes', () => {
  it('uj telepitesen a beepitettek (mintakent masolhatok) es az alapertelmezett szovegek jonnek, sajat mod nelkul', async () => {
    const r = await call('GET', '/api/debate/modes')
    expect(r.status).toBe(200)
    expect(r.body.custom).toEqual([])
    expect(r.body.builtin.map((m: any) => [m.id, m.base])).toEqual([['peer', 'peer'], ['critic', 'critic'], ['assumptions', 'critic'], ['premortem', 'critic']])
    expect(r.body.builtin[1]).toMatchObject({ strength: 'medium', swapRoles: false, maxRounds: 6 })
    expect(r.body.defaults.critic).toContain('CRITIC')
    expect(r.body.defaults.defender).toContain('DEFENDER')
    expect(r.body.strengths).toEqual(['mild', 'medium', 'hard'])
    expect(r.body.limits).toMatchObject({ modes: 30, max_rounds: 12 })
  })

  it('mentes -> megjelenik a listaban; szerkesztes ugyanazzal az azonositoval; torles', async () => {
    const a = await call('POST', '/api/debate/modes', { name: 'Szigoru', base: 'critic', strength: 'hard', maxRounds: 3 })
    expect(a.status).toBe(200)
    const id = a.body.mode.id
    expect((await call('GET', '/api/debate/modes')).body.custom.map((m: any) => m.name)).toEqual(['Szigoru'])
    const b = await call('POST', '/api/debate/modes', { id, name: 'Szigorubb', base: 'critic' })
    expect(b.body.mode.id).toBe(id)
    expect((await call('GET', '/api/debate/modes')).body.custom).toHaveLength(1)
    expect((await call('DELETE', `/api/debate/modes/${id}`)).status).toBe(200)
    expect((await call('GET', '/api/debate/modes')).body.custom).toEqual([])
    expect((await call('DELETE', `/api/debate/modes/${id}`)).status).toBe(404)
  })

  it('hibas mentes: 400, a hiba a kert nyelven, semmi nem kerul a fajlba', async () => {
    const hu = await call('POST', '/api/debate/modes', { name: '', base: 'critic' })
    expect(hu.status).toBe(400)
    expect(hu.body).toMatchObject({ error: 'name_missing', message: 'Adj nevet a módnak.' })
    const en = await call('POST', '/api/debate/modes?lang=en', { name: 'x', base: 'bird' })
    expect(en.body).toMatchObject({ error: 'base_unknown' })
    expect(en.body.message).toMatch(/kind of the mode/)
    expect((await call('POST', '/api/debate/modes', 'nem json')).status).toBe(400)
    expect((await call('GET', '/api/debate/modes')).body.custom).toEqual([])
  })

  it('a hataron kivuli korszam hiba; mas utvonalat nem kezel', async () => {
    expect((await call('POST', '/api/debate/modes', { name: 'x', base: 'critic', maxRounds: 99 })).body.error).toBe('max_rounds_bad')
    const url = new URL('http://localhost:3420/api/debate/models')
    expect(await tryHandleDebateModes({ req: {}, res: {}, path: url.pathname, method: 'GET', url } as any)).toBe(false)
  })
})

describe('/api/debate/modes/export es /import (#597, 7. fazis)', () => {
  const MODE = { name: 'Szigoru', base: 'critic', strength: 'hard', maxRounds: 3, description: 'leiras' }

  it('export: nincs sajat mod -> 404; van -> fajl a formatummal, azonosito nelkul; ids= szuri', async () => {
    expect((await call('GET', '/api/debate/modes/export')).status).toBe(404)
    const a = (await call('POST', '/api/debate/modes', MODE)).body.mode
    const b = (await call('POST', '/api/debate/modes', { ...MODE, name: 'Masik' })).body.mode
    const all = await call('GET', '/api/debate/modes/export')
    expect(all.status).toBe(200)
    expect(all.body.count).toBe(2)
    expect(all.body.name).toMatch(/^marveen-vita-modok-\d{4}-\d{2}-\d{2}-2\.json$/)
    expect(all.body.file).toMatchObject({ format: 'marveen-debate-modes', version: 1 })
    expect(JSON.stringify(all.body.file)).not.toContain(a.id)
    const one = await call('GET', `/api/debate/modes/export?ids=${b.id}`)
    expect(one.body.file.modes.map((m: any) => m.name)).toEqual(['Masik'])
  })

  it('import: az elonezet (dry_run) nem ir; az igazi beolvasas uj modokat ad, a foglalt nev sorszamot kap; export->import kor', async () => {
    await call('POST', '/api/debate/modes', MODE)
    const file = (await call('GET', '/api/debate/modes/export')).body.file
    const dry = await call('POST', '/api/debate/modes/import', { content: JSON.stringify(file), dry_run: true })
    expect(dry.status).toBe(200)
    expect(dry.body).toMatchObject({ dry_run: true, imported: [{ id: null, name: 'Szigoru (2)', base: 'critic' }], renamed: [{ from: 'Szigoru', to: 'Szigoru (2)' }] })
    expect((await call('GET', '/api/debate/modes')).body.custom).toHaveLength(1)
    const real = await call('POST', '/api/debate/modes/import', { content: JSON.stringify(file) })
    expect(real.body.imported[0].id).toMatch(/^m-/)
    const list = (await call('GET', '/api/debate/modes')).body.custom
    expect(list.map((m: any) => m.name)).toEqual(['Szigoru', 'Szigoru (2)'])
    expect(list[0].id).not.toBe(list[1].id)
    expect(list[1]).toMatchObject({ strength: 'hard', maxRounds: 3, description: 'leiras' })
  })

  it('import hibak: 400 a kert nyelven, semmi nem kerul a fajlba', async () => {
    const bad = await call('POST', '/api/debate/modes/import', { content: '{ nem json' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('bad_json')
    const notMode = await call('POST', '/api/debate/modes/import?lang=en', { content: JSON.stringify({ valami: 1 }) })
    expect(notMode.body.error).toBe('not_a_mode_file')
    expect(notMode.body.message).toMatch(/not a debate mode file/)
    expect((await call('POST', '/api/debate/modes/import', '{ nem json')).status).toBe(400)
    expect((await call('GET', '/api/debate/modes')).body.custom).toEqual([])
  })

  it('import: a hibas bejegyzes kimarad az okkal, a jo bekerul; csupa hibas -> nincs iras', async () => {
    const content = { format: 'marveen-debate-modes', version: 1, modes: [{ name: 'Jo', base: 'peer' }, { name: '', base: 'peer' }] }
    const r = await call('POST', '/api/debate/modes/import', { content })
    expect(r.body.imported.map((m: any) => m.name)).toEqual(['Jo'])
    expect(r.body.skipped).toEqual([{ name: '', reason: 'name_missing' }])
    const none = await call('POST', '/api/debate/modes/import', { content: { ...content, modes: [{ base: 'x' }] } })
    expect(none.body.imported).toEqual([])
    expect((await call('GET', '/api/debate/modes')).body.custom).toHaveLength(1)
  })
})
