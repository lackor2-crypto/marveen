// The debate templates (#597, phase 6): the store file and /api/debate/templates. The file is a real one in a temp folder.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const h = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (orig) => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  h.dir = mkdtempSync(join(tmpdir(), 'debate-templates-test-'))
  return { ...(await orig<typeof import('../config.js')>()), STORE_DIR: h.dir }
})

const { DEBATE_TEMPLATES_PATH, loadTemplates, saveTemplate, deleteTemplate, templatesForPanel, sanitizeTemplate, TEMPLATES_MAX } = await import('../debate-template-store.js')
const { saveStoredMode, deleteStoredMode } = await import('../debate-mode-store.js')
const { DEBATE_MODES_PATH } = await import('../debate-mode-store.js')
const { tryHandleDebateTemplates } = await import('../web/routes/debate-templates.js')

const TPL = { name: 'Jogi atnezes', mode: 'critic', strength: 'hard', swapRoles: true, models: ['openai/gpt-5.5', 'anthropic/claude-opus-4.1'], judge: 'google/gemini-3-pro' }

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req: any = { on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && bodyStr) cb(Buffer.from(bodyStr)); if (ev === 'end') cb() } }
  return tryHandleDebateTemplates({ req, res, path: url.pathname, method, url } as any).then(handled => {
    if (!handled) throw new Error(`not handled: ${method} ${path}`)
    return out
  })
}

beforeEach(() => { rmSync(DEBATE_TEMPLATES_PATH, { force: true }); rmSync(DEBATE_MODES_PATH, { force: true }) })
afterAll(() => { rmSync(h.dir, { recursive: true, force: true }) })

describe('sablonok tarolasa', () => {
  it('ures telepitesen nincs fajl es nincs sablon', () => {
    expect(existsSync(DEBATE_TEMPLATES_PATH)).toBe(false)
    expect(loadTemplates()).toEqual([])
  })

  it('mentes: uj azonositot kap, a fajl olvashato JSON, nem marad .tmp', () => {
    const r = saveTemplate(TPL)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.template.id).toMatch(/^t-[0-9a-f]{8}$/)
    expect(JSON.parse(readFileSync(DEBATE_TEMPLATES_PATH, 'utf-8'))).toMatchObject({ version: 1, templates: [{ name: 'Jogi atnezes', strength: 'hard', swapRoles: true }] })
    expect(readdirSync(h.dir).filter(f => f.endsWith('.tmp'))).toEqual([])
    expect(loadTemplates()[0]).toEqual(r.template)
  })

  it('azonos nevvel (kis-nagybetutol fuggetlenul) mentve felulirja, nem duplazza; azonositoval is', () => {
    const a = saveTemplate(TPL)
    if (!a.ok) throw new Error('save')
    const b = saveTemplate({ ...TPL, name: 'JOGI ATNEZES', judge: 'x/y' })
    expect(b).toMatchObject({ ok: true, template: { id: a.template.id, judge: 'x/y' } })
    expect(loadTemplates()).toHaveLength(1)
    const c = saveTemplate({ ...TPL, id: a.template.id, name: 'Atnevezve' })
    expect(c).toMatchObject({ ok: true, template: { id: a.template.id, name: 'Atnevezve' } })
    expect(loadTemplates()).toHaveLength(1)
    expect(saveTemplate({ ...TPL, name: 'Masik' }).ok).toBe(true)
    expect(loadTemplates()).toHaveLength(2)
  })

  it('ellenorzes: nev, mod es legalabb egy modell kell; a hibas mentes nem ir semmit', () => {
    expect(saveTemplate({ ...TPL, name: '  ' })).toEqual({ ok: false, error: 'name_missing' })
    expect(saveTemplate({ ...TPL, mode: '' })).toEqual({ ok: false, error: 'mode_missing' })
    expect(saveTemplate({ ...TPL, models: ['', ' '] })).toEqual({ ok: false, error: 'models_missing' })
    expect(saveTemplate('nem objektum')).toEqual({ ok: false, error: 'bad_input' })
    expect(existsSync(DEBATE_TEMPLATES_PATH)).toBe(false)
  })

  it('a tulhosszu nev es modell levagva; ismeretlen erosseg / szerepcsere "a mod sajatja" (null)', () => {
    const r = sanitizeTemplate({ ...TPL, name: 'n'.repeat(200), strength: 'extreme', swapRoles: 'igen', models: ['m'.repeat(500), 'b', 'c', 'd'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.template.name).toHaveLength(60)
    expect(r.template.strength).toBeNull()
    expect(r.template.swapRoles).toBeNull()
    expect(r.template.models).toHaveLength(3)
    expect(r.template.models[0]).toHaveLength(200)
  })

  it('legfeljebb annyi sablon, amennyit a hatar enged; egy meglevo szerkesztese meg megy', () => {
    for (let i = 0; i < TEMPLATES_MAX; i++) expect(saveTemplate({ ...TPL, name: `S${i}` }).ok).toBe(true)
    expect(saveTemplate({ ...TPL, name: 'tul sok' })).toEqual({ ok: false, error: 'too_many' })
    expect(saveTemplate({ ...TPL, name: 'S0', judge: 'uj' }).ok).toBe(true)
  })

  it('torles; ismeretlen azonosito false', () => {
    const a = saveTemplate(TPL)
    if (!a.ok) throw new Error('save')
    expect(deleteTemplate('t-nincs0000')).toBe(false)
    expect(deleteTemplate(a.template.id)).toBe(true)
    expect(loadTemplates()).toEqual([])
  })

  it('kezzel elrontott fajl nem tori el a panelt: sorok kimaradnak, a tobbi marad', () => {
    writeFileSync(DEBATE_TEMPLATES_PATH, '{ nem json')
    expect(loadTemplates()).toEqual([])
    writeFileSync(DEBATE_TEMPLATES_PATH, JSON.stringify({ templates: [{ name: 'azonosito nelkul', mode: 'peer', models: ['a'] }, { id: 't-abcdef12', name: 'jo', mode: 'peer', models: ['a'] }, 7, null] }))
    expect(loadTemplates().map(t => t.name)).toEqual(['jo'])
  })

  it('a torolt sajat modra mutato sablon betoltheto, de "modeMissing" jelzest kap', () => {
    const m = saveStoredMode({ name: 'Sajat', base: 'critic' })
    if (!m.ok) throw new Error('mod')
    saveTemplate({ ...TPL, name: 'sajat modos', mode: m.mode.id })
    saveTemplate({ ...TPL, name: 'beepitett modos', mode: 'premortem' })
    expect(templatesForPanel().map(t => [t.name, t.modeMissing])).toEqual([['sajat modos', false], ['beepitett modos', false]])
    deleteStoredMode(m.mode.id)
    expect(templatesForPanel().map(t => [t.name, t.modeMissing])).toEqual([['sajat modos', true], ['beepitett modos', false]])
  })
})

describe('/api/debate/templates', () => {
  it('ures telepitesen ures lista es a hatarok', async () => {
    const r = await call('GET', '/api/debate/templates')
    expect(r.status).toBe(200)
    expect(r.body.templates).toEqual([])
    expect(r.body.limits).toMatchObject({ templates: 50, name: 60 })
  })

  it('mentes -> megjelenik; ugyanazzal a nevvel felulirja; torles; ismeretlen torles 404', async () => {
    const a = await call('POST', '/api/debate/templates', TPL)
    expect(a.status).toBe(200)
    expect(a.body.templates).toHaveLength(1)
    const again = await call('POST', '/api/debate/templates', { ...TPL, judge: 'masik/biro' })
    expect(again.body.template.id).toBe(a.body.template.id)
    expect((await call('GET', '/api/debate/templates')).body.templates).toHaveLength(1)
    expect((await call('DELETE', `/api/debate/templates/${a.body.template.id}`)).status).toBe(200)
    expect((await call('GET', '/api/debate/templates')).body.templates).toEqual([])
    expect((await call('DELETE', `/api/debate/templates/${a.body.template.id}`)).status).toBe(404)
  })

  it('hibas mentes: 400, a hiba a kert nyelven, semmi nem kerul a fajlba', async () => {
    const hu = await call('POST', '/api/debate/templates', { ...TPL, name: '' })
    expect(hu.status).toBe(400)
    expect(hu.body.error).toBe('name_missing')
    expect(hu.body.message).toBe('Adj nevet a sablonnak.')
    const en = await call('POST', '/api/debate/templates?lang=en', { ...TPL, name: '' })
    expect(en.body.message).toBe('Give the template a name.')
    expect((await call('POST', '/api/debate/templates', '{ nem json')).status).toBe(400)
    expect(existsSync(DEBATE_TEMPLATES_PATH)).toBe(false)
  })

  it('mas utvonalat nem kezel', async () => {
    await expect(call('GET', '/api/debate/nincs')).rejects.toThrow('not handled')
  })
})
