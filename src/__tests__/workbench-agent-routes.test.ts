// AI Munkapad (kanban #336, 2. fazis): az agent-vegpontok a VALODI
// utvonalkezelon at -- beleertve a STREAMELT (SSE) valaszt.
//
// Amit oriz:
//   1. az allapot-vegpont megkulonbozteti a "nincs szolgaltato" es a "nincs
//      meres" allapotot a "minden nulla"-tol;
//   2. a streamelés MEGKEZDESE ELOTT rendes HTTP-hiba jon, hogy a felulet ki
//      tudja irni (nem fel-elkuldott SSE);
//   3. a valasz tenylegesen SSE-esemenyekkent erkezik;
//   4. minden hiba ember-nyelvu mondatot visz, a keres nyelven.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'

// A vegpont bejegyzi a VALODI Anthropic-szolgaltatot. Ezen a gepen lehet
// bejelentkezett Claude-fiok -- egy teszt SOSE inditson valodi modell-hivast,
// es az eredmenye se fuggjon attol, hogy a fejlesztogepen van-e login. Ezert
// a szolgaltato ket forrasat (beallitasok, fiok-konyvtar) itt determinisztikusan
// "nincs beallitva" allapotba tesszuk: ez EGYBEN a friss telepites allapota.
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return { ...actual, getEffectiveSettingValue: (k: string) => (k.startsWith('WORKBENCH_') ? '' : actual.getEffectiveSettingValue(k)) }
})
vi.mock('../web/claude-plans.js', async (orig) => {
  const actual = await orig<typeof import('../web/claude-plans.js')>()
  return { ...actual, resolveAgentConfigDir: () => ({ configDir: '/nincs/ilyen/claude/konyvtar' }) }
})
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { resetRunningForTest } from '../workbench-agent/orchestrator.js'
import { setUsageSnapshotReader, resetUsageManagerForTest } from '../workbench-agent/usage-manager.js'
import { setAuditWriterForTest } from '../workbench-agent/audit.js'
import { clearAIProvidersForTest, registerAIProvider, type AIChunk, type AIProvider } from '../workbench-agent/provider.js'
import { resetWorkbenchAgentForTest } from '../workbench-agent/index.js'
import { tryHandleWorkbenchAgent } from '../web/routes/workbench-agent.js'
import type { RouteContext } from '../web/routes/types.js'

interface Out { status: number; headers: Record<string, string>; body: any; raw: string }

function ctxFor(path: string, method: string, body?: unknown) {
  const out: Out = { status: 200, headers: {}, body: null, raw: '' }
  const res: any = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status
      if (headers) Object.assign(out.headers, headers)
      return res
    },
    setHeader(k: string, v: string) { out.headers[k] = v; return res },
    write(chunk: string) { out.raw += chunk; return true },
    end(chunk?: string) { if (chunk) { out.raw += chunk; try { out.body = JSON.parse(chunk) } catch { /* SSE */ } } },
    on() { return res },
  }
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req: any = Readable.from([Buffer.from(raw, 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  req.on = req.on.bind(req)
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url, auth: { kind: 'session' as const, user: 'teszt' } } as unknown as RouteContext,
    out,
  }
}

async function call(path: string, method: string, body?: unknown) {
  const { ctx, out } = ctxFor(path, method, body)
  const handled = await tryHandleWorkbenchAgent(ctx)
  return { handled, ...out }
}

/** Az SSE-folyam esemenyei. */
function sseEvents(raw: string): { event: string; data: any }[] {
  return raw.split('\n\n').filter(Boolean).map((block) => {
    const ev = /^event: (.+)$/m.exec(block)?.[1] ?? ''
    const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}'
    return { event: ev, data: JSON.parse(data) }
  })
}

function fakeProvider(text: string, available = true): AIProvider {
  return {
    id: 'teszt',
    model: () => 'teszt-modell',
    availability: () => (available ? { available: true } : { available: false, reason: 'not_configured' }),
    async *stream() {
      yield { kind: 'text', text } as AIChunk
      yield { kind: 'done', model: 'teszt-modell' } as AIChunk
    },
  }
}

let projectId = ''
let workItemId = ''

beforeEach(() => {
  initDatabase(':memory:')
  resetRunningForTest()
  resetUsageManagerForTest()
  clearAIProvidersForTest()
  resetWorkbenchAgentForTest()
  setAuditWriterForTest(() => { /* a teszt nem ir a valodi naploba */ })
  setUsageSnapshotReader(() => ({ fiveHour: { usedPct: 12, resetsAt: null }, measuredAt: Date.now(), updatedAt: Date.now() }))
  const p = createProject({ name: 'Teszt projekt' })
  if (!p.ok) throw new Error('projekt')
  projectId = p.project.id
  const w = createWorkItem({ project_id: projectId, title: 'Ajánlat', type: 'document' })
  if (!w.ok) throw new Error('munkadarab')
  workItemId = w.item.id
})

afterEach(() => {
  setAuditWriterForTest(null)
  setUsageSnapshotReader(null)
  clearAIProvidersForTest()
  resetWorkbenchAgentForTest()
  vi.restoreAllMocks()
})

describe('utvonal-hatar', () => {
  it('a Munkapad-agenten kivuli utakhoz hozza sem nyul', async () => {
    expect((await call('/api/workbench/items', 'GET')).handled).toBe(false)
    expect((await call('/api/projects', 'GET')).handled).toBe(false)
  })
})

describe('GET /api/workbench/agent/status', () => {
  it('FRISS TELEPITES: nincs szolgaltato -> available false + emberi mondat', async () => {
    // A valodi Anthropic-szolgaltato bejegyzodik, de se kulcs, se bejelentkezes
    // (lasd a fenti mockokat) -- pontosan a friss telepites allapota.
    const r = await call('/api/workbench/agent/status', 'GET')
    expect(r.status).toBe(200)
    expect(r.body.provider.available).toBe(false)
    expect(r.body.provider.id).toBeNull()
    expect(r.body.provider.model).toBeNull()
    expect(r.body.provider.message).toMatch(/nincs beállítva AI-szolgáltató/i)
    // ...es ettol a Munkapad tobbi resze meg mukodik: a valasz 200, nem hiba.
    expect(r.body.tools.length).toBeGreaterThan(0)
  })

  it('a mert keret es az eszkoz-lista is latszik', async () => {
    const r = await call('/api/workbench/agent/status', 'GET')
    expect(r.body.usage.usedPct).toBe(12)
    expect(r.body.usage.measured).toBe(true)
    expect(r.body.allowed).toBe(true)
    // Minden eszkoz viszi a spec 0.3 metaadatait.
    expect(r.body.tools.length).toBeGreaterThan(0)
    for (const t of r.body.tools) {
      expect(t).toHaveProperty('destructive')
      expect(t).toHaveProperty('reversible')
      expect(t).toHaveProperty('external_effect')
    }
  })

  it('NINCS meres: a valasz kimondja, hogy nem latunk oda -- nem 0%-ot mutat', async () => {
    setUsageSnapshotReader(() => null)
    const r = await call('/api/workbench/agent/status', 'GET')
    expect(r.body.usage.usedPct).toBeNull()
    expect(r.body.usage.measured).toBe(false)
    expect(r.body.usage.message).toMatch(/nem látok oda/i)
    // Es ettol meg szabad hivni.
    expect(r.body.allowed).toBe(true)
  })

  it('betelt keret: allowed false, megnevezett okkal', async () => {
    setUsageSnapshotReader(() => ({ fiveHour: { usedPct: 99, resetsAt: null }, measuredAt: Date.now(), updatedAt: Date.now() }))
    const r = await call('/api/workbench/agent/status', 'GET')
    expect(r.body.allowed).toBe(false)
    expect(r.body.blockedReason).toBe('limit_critical')
  })

  it('angol nyelven a mondatok is angolul jonnek', async () => {
    setUsageSnapshotReader(() => null)
    const r = await call('/api/workbench/agent/status?lang=en', 'GET')
    expect(r.body.usage.message).toMatch(/cannot see it/i)
  })
})

describe('POST /api/workbench/agent/message -- elozetes ellenorzes', () => {
  it('ures uzenet: 400 + emberi mondat, MEG a stream elott', async () => {
    const r = await call('/api/workbench/agent/message', 'POST', { project_id: projectId, work_item_id: workItemId, message: '  ' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('message_required')
    expect(r.body.message).toMatch(/[áéíóöőúüű]/i)
    expect(r.headers['Content-Type']).not.toBe('text/event-stream')
  })

  it('ismeretlen projekt: 404', async () => {
    const r = await call('/api/workbench/agent/message', 'POST', { project_id: 'nincsilyen', message: 'szia' })
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('project_not_found')
  })

  it('ismeretlen munkadarab: 404, emberi mondattal', async () => {
    const r = await call('/api/workbench/agent/message', 'POST', { project_id: projectId, work_item_id: 'nincsilyen', message: 'szia' })
    expect(r.status).toBe(404)
    expect(r.body.message.length).toBeGreaterThan(10)
  })

  it('ertelmezhetetlen torzs: 400', async () => {
    const r = await call('/api/workbench/agent/message', 'POST', 'nem json')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('bad_json')
  })
})

describe('POST /api/workbench/agent/message -- a streamelt valasz', () => {
  it('SSE-esemenyekkent erkezik: session -> text -> done', async () => {
    registerAIProvider(fakeProvider('Ez a válasz.'))
    const r = await call('/api/workbench/agent/message', 'POST', {
      project_id: projectId, work_item_id: workItemId, message: 'Mit gondolsz?',
    })
    expect(r.status).toBe(200)
    expect(r.headers['Content-Type']).toBe('text/event-stream')
    const evs = sseEvents(r.raw)
    expect(evs.map((e) => e.event)).toEqual(['session', 'text', 'done'])
    expect(evs[1].data.text).toBe('Ez a válasz.')
  })

  it('FRISS TELEPITES: szolgaltato nelkul is 200 + emberi "notice", nem osszeomlas', async () => {
    registerAIProvider(fakeProvider('soha', false))
    const r = await call('/api/workbench/agent/message', 'POST', {
      project_id: projectId, work_item_id: workItemId, message: 'Szia',
    })
    expect(r.status).toBe(200)
    const evs = sseEvents(r.raw)
    const notice = evs.find((e) => e.event === 'notice')
    expect(notice?.data.code).toBe('no_provider')
    expect(notice?.data.message).toMatch(/nincs beállítva AI-szolgáltató/i)
    expect(evs.at(-1)?.event).toBe('done')
  })

  it('betelt kozos keret: a stream megmondja, nem inditunk hivast', async () => {
    registerAIProvider(fakeProvider('soha'))
    setUsageSnapshotReader(() => ({ fiveHour: { usedPct: 99, resetsAt: null }, measuredAt: Date.now(), updatedAt: Date.now() }))
    const r = await call('/api/workbench/agent/message', 'POST', {
      project_id: projectId, work_item_id: workItemId, message: 'Szia',
    })
    const notice = sseEvents(r.raw).find((e) => e.event === 'notice')
    expect(notice?.data.code).toBe('limit_critical')
  })
})

describe('GET /api/workbench/agent/session', () => {
  it('megadott munkadarab nelkul: emberi hiba', async () => {
    const r = await call('/api/workbench/agent/session', 'GET')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('work_item_required')
  })

  it('ismeretlen munkadarab: 404', async () => {
    const r = await call('/api/workbench/agent/session?workItem=nincsilyen', 'GET')
    expect(r.status).toBe(404)
  })

  it('uj munkadarab: ures beszelgetes, nem hiba', async () => {
    const r = await call(`/api/workbench/agent/session?workItem=${workItemId}`, 'GET')
    expect(r.status).toBe(200)
    expect(r.body.messages).toEqual([])
    expect(r.body.toolCalls).toEqual([])
    expect(r.body.session.work_item_id).toBe(workItemId)
  })

  it('egy fordulo utan a beszelgetes visszaolvashato', async () => {
    registerAIProvider(fakeProvider('Válasz.'))
    await call('/api/workbench/agent/message', 'POST', { project_id: projectId, work_item_id: workItemId, message: 'Kérdés?' })
    const r = await call(`/api/workbench/agent/session?workItem=${workItemId}`, 'GET')
    expect(r.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant'])
    expect(r.body.messages[0].content).toBe('Kérdés?')
  })

  // A MUNKADARAB NELKULI beszelgetes (3. fazis): a Munkapadon akkor is lehet
  // irni, ha meg nincs munkadarab -- eppen abbol szuletik az elso. Ezt is
  // vissza kell tudni olvasni, kulonben egy oldalfrissites utan a mar
  // lefolytatott beszelgetes URESNEK latszana, holott ott all az adatbazisban.
  it('projekt-szintu beszelgetes: ures, de nem hiba', async () => {
    const r = await call(`/api/workbench/agent/session?project=${projectId}`, 'GET')
    expect(r.status).toBe(200)
    expect(r.body.messages).toEqual([])
    expect(r.body.session.project_id).toBe(projectId)
  })

  it('projekt-szintu fordulo utan UGYANAZ a beszelgetes jon vissza', async () => {
    registerAIProvider(fakeProvider('Rendben.'))
    await call('/api/workbench/agent/message', 'POST', { project_id: projectId, work_item_id: null, message: 'Csinálj egy posztot.' })
    const r = await call(`/api/workbench/agent/session?project=${projectId}`, 'GET')
    expect(r.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant'])
    expect(r.body.messages[0].content).toBe('Csinálj egy posztot.')
    // ...es NEM keveredik ossze a munkadarabehoz tartozoval.
    const item = await call(`/api/workbench/agent/session?workItem=${workItemId}`, 'GET')
    expect(item.body.messages).toEqual([])
  })

  it('ismeretlen projekt: 404, nem ures beszelgetes', async () => {
    const r = await call('/api/workbench/agent/session?project=nincsilyen', 'GET')
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('project_not_found')
  })
})
