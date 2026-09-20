// AI Munkapad (kanban #336, 2. fazis): a modell/API-kulcs vegpont.
//
// Amit oriz -- a TITKOS kulcs ket iranyu szabalyat:
//   1. a kulcs ERTEKE sosem hagyja el a szervert (a GET csak azt mondja meg,
//      VAN-E kulcs), mert egy maszkolt ertek is elarulna, hogy be van allitva;
//   2. a kulcs MEGIS beallithato a feluletrol -- kulonben a `secret: true`
//      jeloles egyszeruen konfiguralhatatlanna tenne (terminal/fajl kellene,
//      amit a friss-telepites szabaly kifejezetten tilt);
//   3. az ERINTETLEN mezo (ures string) NEM torli a mar beallitott kulcsot --
//      a torles kimondott szandek (`null`).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

// Egy szimulalt beallitas-tar: igy a teszt nem fugg a gep valodi store-jatol.
const store = new Map<string, string>()
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (k: string) => (store.has(k) ? store.get(k) : ''),
    setOverride: (k: string, v: unknown) => { store.set(k, String(v)); return { ok: true as const } },
  }
})
import { initDatabase } from '../db.js'
import { tryHandleWorkbenchAgent } from '../web/routes/workbench-agent.js'
import type { RouteContext } from '../web/routes/types.js'

function call(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any; raw: string } = { status: 200, body: null, raw: '' }
  const res: any = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() { return res },
    write(c: string) { out.raw += c; return true },
    end(c?: string) { if (c) { out.raw += c; try { out.body = JSON.parse(c) } catch { /* SSE */ } } },
    on() { return res },
  }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from([Buffer.from(raw, 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: 'session' as const, user: 'teszt' } } as unknown as RouteContext
  return tryHandleWorkbenchAgent(ctx).then(() => out)
}

describe('workbench agent config endpoint', () => {
  beforeEach(() => { initDatabase(':memory:'); store.clear() })

  it('friss telepitesen: nincs kulcs, es ezt KIMONDJA (nem hallgat)', async () => {
    const out = await call('/api/workbench/agent/config', 'GET')
    expect(out.status).toBe(200)
    expect(out.body.keyConfigured).toBe(false)
    expect(out.body.WORKBENCH_MODEL).toBe('')
  })

  it('a kulcs beallithato a feluletrol, de az erteke SOSE jon vissza', async () => {
    const saved = await call('/api/workbench/agent/config', 'POST', { WORKBENCH_ANTHROPIC_API_KEY: 'sk-titkos-ertek' })
    expect(saved.status).toBe(200)
    expect(saved.body.saved).toContain('WORKBENCH_ANTHROPIC_API_KEY')
    // A mentes valasza sem visszhangozza a kulcsot.
    expect(saved.raw).not.toContain('sk-titkos-ertek')

    const out = await call('/api/workbench/agent/config', 'GET')
    expect(out.body.keyConfigured).toBe(true)
    // SEM nyersen, SEM maszkolva, SEM reszletben.
    expect(out.raw).not.toContain('sk-titkos-ertek')
    expect(JSON.stringify(out.body)).not.toContain('sk-titkos')
  })

  it('az ERINTETLEN (ures) mezo nem torli a mar beallitott kulcsot', async () => {
    await call('/api/workbench/agent/config', 'POST', { WORKBENCH_ANTHROPIC_API_KEY: 'sk-megvan' })
    // A felulet a modellt allitja at; a kulcs-mezo uresen posztol vissza.
    await call('/api/workbench/agent/config', 'POST', { WORKBENCH_MODEL: 'claude-sonnet-5', WORKBENCH_ANTHROPIC_API_KEY: '' })
    const out = await call('/api/workbench/agent/config', 'GET')
    expect(out.body.keyConfigured).toBe(true)
    expect(out.body.WORKBENCH_MODEL).toBe('claude-sonnet-5')
  })

  it('a torles KIMONDOTT szandek: null toroli a kulcsot', async () => {
    await call('/api/workbench/agent/config', 'POST', { WORKBENCH_ANTHROPIC_API_KEY: 'sk-megvan' })
    await call('/api/workbench/agent/config', 'POST', { WORKBENCH_ANTHROPIC_API_KEY: null })
    const out = await call('/api/workbench/agent/config', 'GET')
    expect(out.body.keyConfigured).toBe(false)
  })

  it('ismeretlen mezore ember-nyelvu hibat ad, nem csendes sikert', async () => {
    const out = await call('/api/workbench/agent/config', 'POST', { VALAMI_MAS: 'x' })
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('no_known_settings')
    expect(out.body.message).toMatch(/beállítást|setting/)
  })
})
