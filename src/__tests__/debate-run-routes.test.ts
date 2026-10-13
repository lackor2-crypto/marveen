// The write side of the Workbench debate: /api/debate/{models,attachment,run,sessions/:id/state|conclude}
// (src/web/routes/debate-run.ts). The debate engine is stubbed -- its own test is debate-run.test.ts --
// so this file pins what the browser sees: status codes, bilingual messages, and what an attachment
// (uploaded file, project document, work item) turns into.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  secret: 'sk' as string | null,
  run: vi.fn(),
  conclude: vi.fn(),
  load: vi.fn(),
  catalog: vi.fn(),
  lifeRoot: '',
}))

vi.mock('../web/vault.js', () => ({ getSecret: () => h.secret }))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: () => 'openai/gpt-5.5, deepseek/deepseek-v4' }))
vi.mock('../projects.js', () => ({ getProject: (id: string) => (id === 'p1' ? { id: 'p1' } : undefined) }))
vi.mock('../life-explorer.js', () => ({
  resolveLifePath: (rel: string) => (rel.startsWith('Ugyek/') ? join(h.lifeRoot, rel.slice('Ugyek/'.length)) : null),
}))
vi.mock('../workbench.js', () => ({
  getWorkItem: (id: string) => (id === 'i1' ? { id, title: 'Valaszlevel', deleted_at: null } : id === 'img' ? { id, title: 'Kep', deleted_at: null } : undefined),
}))
vi.mock('../workbench-docmodel.js', () => ({
  hasDocModel: (id: string) => id === 'i1',
  documentOutline: () => ({ sections: [
    { title: 'Targy', untitled: false, blocks: [{ text: 'Elso bekezdes.' }, { text: 'Masodik.' }] },
    { title: 'Fejezet 1', untitled: true, blocks: [{ text: 'Cim nelkuli resz.' }] },
  ] }),
}))
vi.mock('../web/openrouter-models.js', () => ({ fetchAllOpenRouterModels: () => h.catalog() }))
vi.mock('../debate-run.js', async (orig) => ({
  ...(await orig<typeof import('../debate-run.js')>()),
  runDebateRound: (...a: unknown[]) => h.run(...a),
  concludeDebate: (...a: unknown[]) => h.conclude(...a),
  loadDebateSession: (...a: unknown[]) => h.load(...a),
}))

const { tryHandleDebateRun } = await import('../web/routes/debate-run.js')
const { DebateKeyMissingError, DebateBusyError, DebateInputError } = await import('../debate-run.js')

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return tryHandleDebateRun({ req, res, path: url.pathname, method, url } as any).then(handled => {
    if (!handled) throw new Error('not handled: ' + path)
    return out
  })
}

beforeEach(() => {
  h.secret = 'sk'
  h.run.mockReset()
  h.conclude.mockReset()
  h.load.mockReset()
  h.catalog.mockReset()
  h.catalog.mockResolvedValue([{ id: 'openai/gpt-5.5', name: 'GPT 5.5', free: false, contextLength: 1, promptPrice: 1, completionPrice: 1 }])
})

describe('GET /api/debate/models', () => {
  it('a beallitott modellek es a katalogus (csak id/nev/ingyenes), kulccsal', async () => {
    const r = await call('GET', '/api/debate/models')
    expect(r.body).toEqual({
      defaults: ['openai/gpt-5.5', 'deepseek/deepseek-v4'],
      catalog: [{ id: 'openai/gpt-5.5', name: 'GPT 5.5', free: false }],
      has_key: true, catalog_error: false,
    })
  })

  it('kulcs nelkul nem hiv katalogust, es jelzi', async () => {
    h.secret = null
    const r = await call('GET', '/api/debate/models')
    expect(r.body).toMatchObject({ catalog: [], has_key: false })
    expect(h.catalog).not.toHaveBeenCalled()
  })

  it('a katalogus hibaja nem viszi el a valaszt: az alap-modellek maradnak, a jelzes igaz', async () => {
    h.catalog.mockRejectedValue(new Error('down'))
    const r = await call('GET', '/api/debate/models')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ defaults: ['openai/gpt-5.5', 'deepseek/deepseek-v4'], catalog: [], catalog_error: true })
  })
})

describe('POST /api/debate/attachment', () => {
  it('feltoltott szovegfajl: a szoveg visszajon (a feltoltes nem marad a lemezen)', async () => {
    const text = 'Kedves Hatosag, az ugyiratszam 123/2026.\nUdvozlettel: Boss'
    const r = await call('POST', '/api/debate/attachment', { name: 'level.txt', data_base64: Buffer.from(text).toString('base64') })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ name: 'level.txt', text, truncated: false })
  })

  it('a hosszu szoveg eleje kerul be, es jelzi', async () => {
    const text = 'szo '.repeat(30_000)
    const r = await call('POST', '/api/debate/attachment', { name: 'hosszu.txt', data_base64: Buffer.from(text).toString('base64') })
    expect(r.body.truncated).toBe(true)
    expect(r.body.text.length).toBeLessThan(text.length)
  })

  it('kep / szoveg nelkuli fajl: ertheto magyar mondat, nem 500', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const hu = await call('POST', '/api/debate/attachment', { name: 'szkenn.png', data_base64: png.toString('base64') })
    expect(hu.status).toBe(422)
    expect(hu.body.error).toBe('no_text')
    expect(hu.body.message).toContain('nem tudtam szöveget kiolvasni')
    const en = await call('POST', '/api/debate/attachment?lang=en', { name: 'szkenn.png', data_base64: png.toString('base64') })
    expect(en.body.message).toContain('could not read any text')
  })

  it('projekt-irat az Eletfabol: a szoveg jon; fan kivuli ut 404', async () => {
    h.lifeRoot = mkdtempSync(join(tmpdir(), 'debate-routes-life-'))
    try {
      writeFileSync(join(h.lifeRoot, 'hatarozat.txt'), 'A hatarozat szovege. Fellebbezni 15 napon belul lehet.')
      const ok = await call('POST', '/api/debate/attachment', { rel: 'Ugyek/hatarozat.txt' })
      expect(ok.body).toMatchObject({ name: 'hatarozat.txt', text: 'A hatarozat szovege. Fellebbezni 15 napon belul lehet.' })
      const out = await call('POST', '/api/debate/attachment', { rel: '../../etc/passwd' })
      expect(out.status).toBe(404)
      expect(out.body.error).toBe('outside')
    } finally {
      rmSync(h.lifeRoot, { recursive: true, force: true })
    }
  })

  it('munkadarab szovege: cim es bekezdesek sorrendben, a cim nelkuli fejezet cime nem kerul be', async () => {
    const r = await call('POST', '/api/debate/attachment', { item: 'i1' })
    expect(r.body.name).toBe('Valaszlevel')
    expect(r.body.text).toBe('## Targy\n\nElso bekezdes.\n\nMasodik.\n\nCim nelkuli resz.')
    const none = await call('POST', '/api/debate/attachment', { item: 'img' })
    expect(none.status).toBe(404)
    expect(none.body.error).toBe('no_item_text')
  })

  it('fajl nelkuli kerés 400', async () => {
    expect((await call('POST', '/api/debate/attachment', {})).status).toBe(400)
  })
})

describe('POST /api/debate/run', () => {
  it('a projektet a szerver ellenorzi: ismeretlen projektbol nem lesz naplozott projekt', async () => {
    h.run.mockResolvedValue({ session: 's', round: 1, responses: [{ model: 'm', ok: true, text: 'x' }] })
    await call('POST', '/api/debate/run', { project: 'ismeretlen', question: 'q', models: ['a', 'b'] })
    expect(h.run.mock.calls[0][0].project).toBeNull()
    await call('POST', '/api/debate/run', { project: 'p1', question: 'q', models: ['a', 'b'] })
    expect(h.run.mock.calls[1][0].project).toBe('p1')
  })

  it('ha egyik modell sem valaszolt: 502, a kor nincs mentve, a valaszok mellekelve', async () => {
    h.run.mockResolvedValue({ session: 's', round: 1, responses: [{ model: 'a', ok: false, error: 'down' }, { model: 'b', ok: false, error: 'down' }] })
    const r = await call('POST', '/api/debate/run', { question: 'q', models: ['a', 'b'] })
    expect(r.status).toBe(502)
    expect(r.body.error).toBe('all_failed')
    expect(r.body.responses).toHaveLength(2)
  })

  it.each([
    [new DebateKeyMissingError(), 409, 'no_key', 'Nincs OpenRouter-kulcs'],
    [new DebateBusyError(), 409, 'busy', 'még fut'],
    [new DebateInputError('question_missing'), 400, 'question_missing', 'Írd be a kérdést'],
    [new DebateInputError('two_models_required'), 400, 'two_models_required', 'két különböző modellt'],
    [new DebateInputError('session_not_found'), 404, 'session_not_found', 'nem található'],
    [new DebateInputError('session_concluded'), 400, 'session_concluded', 'le van zárva'],
  ])('hiba -> allapotkod + magyar uzenet (%#)', async (err, status, code, msg) => {
    h.run.mockRejectedValue(err)
    const r = await call('POST', '/api/debate/run', { question: 'q', models: ['a', 'b'] })
    expect(r.status).toBe(status)
    expect(r.body.error).toBe(code)
    expect(r.body.message).toContain(msg)
  })

  it('a hiba angolul is megy (?lang=en)', async () => {
    h.run.mockRejectedValue(new DebateInputError('two_models_required'))
    const r = await call('POST', '/api/debate/run?lang=en', { question: 'q', models: ['a'] })
    expect(r.body.message).toBe('Pick two different models.')
  })

  it('varatlan hiba 500, a belso uzenet nem szivarog', async () => {
    h.run.mockRejectedValue(new Error('SECRET-INTERNAL'))
    const r = await call('POST', '/api/debate/run', { question: 'q', models: ['a', 'b'] })
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toContain('SECRET-INTERNAL')
  })
})

describe('state es conclude', () => {
  it('a state a csatolt anyagok szoveget NEM adja ki, csak nevet es meretet', async () => {
    h.load.mockReturnValue({ id: 's', models: ['a', 'b'], question: 'q', attachments: [{ name: 'l.txt', text: 'TITOK-SZOVEG' }], rounds: [], concluded: false, consensus: null, summary: null })
    const r = await call('GET', '/api/debate/sessions/s/state')
    expect(r.body.attachments).toEqual([{ name: 'l.txt', chars: 12 }])
    expect(JSON.stringify(r.body)).not.toContain('TITOK-SZOVEG')
  })

  it('ismeretlen vita state-je 404', async () => {
    h.load.mockReturnValue(null)
    expect((await call('GET', '/api/debate/sessions/x/state')).status).toBe(404)
  })

  it('lezaras: ures torzzsel a modell ir osszefoglalot; a hiba 502 es a vita nyitva marad', async () => {
    h.conclude.mockResolvedValue({ consensus: true, summary: 'Kesz' })
    const ok = await call('POST', '/api/debate/sessions/s/conclude')
    expect(ok.body).toEqual({ consensus: true, summary: 'Kesz' })
    expect(h.conclude).toHaveBeenCalledWith('s', {})
    h.conclude.mockRejectedValue(new DebateInputError('summary_failed:boom'))
    const bad = await call('POST', '/api/debate/sessions/s/conclude')
    expect(bad.status).toBe(502)
    expect(bad.body.message).toContain('boom')
    expect(bad.body.message).toContain('nyitva maradt')
  })
})

describe('mas utat nem fog meg', () => {
  it('a meglevo olvaso utak (lista, reszlet, torles) a tryHandleDebate-e marad', async () => {
    const res: any = { writeHead() { return res }, end() {} }
    for (const [m, p] of [['GET', '/api/debate/sessions'], ['GET', '/api/debate/sessions/abc'], ['DELETE', '/api/debate/sessions/abc'], ['GET', '/api/debate/stats']]) {
      const url = new URL('http://x' + p)
      expect(await tryHandleDebateRun({ req: {} as any, res, path: url.pathname, method: m, url } as any)).toBe(false)
    }
  })
})
