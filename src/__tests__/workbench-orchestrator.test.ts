// AI Munkapad (kanban #336, 2. fazis): az ORCHESTRATOR loop, mockolt modellel.
//
// Amit oriz:
//   1. a teljes ut: user uzenet -> kontextus -> modell -> valasz -> mentes;
//   2. a tool-kor: a modell tool-hivasa lefut, az eredmeny visszamegy hozza,
//      es a NYERS JSON SOSE kerul a felhasznalo ele;
//   3. a jovahagyas-koteles tool a MEGLEVO /api/approvals jegyet szuli, nem
//      egy uj mechanizmust;
//   4. FRISS TELEPITES: szolgaltato nelkul az agens nem nemul el es nem dob,
//      hanem ember-nyelvu (HU/EN) mondatot ad;
//   5. a kozos 5 oras keret kimerulesenel nem indul hivas;
//   6. minden lepes nyomot hagy a KOZOS auditban.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, createApproval, listApprovals, resolveApproval } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, listWorkItems } from '../workbench.js'
import { runTurn, validateTurn, parseToolCall, mayBeToolCall, resetRunningForTest, MESSAGE_MAX_CHARS } from '../workbench-agent/orchestrator.js'
import { listAgentMessages, listToolCalls, openSessionForWorkItem } from '../workbench-agent/sessions.js'
import { setAuditWriterForTest, type AuditEntry } from '../workbench-agent/audit.js'
import { setUsageSnapshotReader, resetUsageManagerForTest } from '../workbench-agent/usage-manager.js'
import { setAutonomyLoaderForTest } from '../workbench-agent/tools.js'
import type { AIChunk, AICallRequest, AIProvider } from '../workbench-agent/provider.js'
import type { OrchestratorEvent } from '../workbench-agent/orchestrator.js'

// ---------------------------------------------------------------------------
// Mockolt szolgaltato: elore megadott valaszokat ad, korrol korre.
// ---------------------------------------------------------------------------
function fakeProvider(replies: string[], opts: { available?: boolean; fail?: AIChunk } = {}): AIProvider & { seen: AICallRequest[] } {
  const seen: AICallRequest[] = []
  let i = 0
  return {
    id: 'teszt',
    seen,
    model: () => 'teszt-modell',
    availability: () => (opts.available === false
      ? { available: false, reason: 'not_configured' as const }
      : { available: true }),
    async *stream(req: AICallRequest): AsyncIterable<AIChunk> {
      seen.push(req)
      if (opts.fail) { yield opts.fail; return }
      const text = replies[i++] ?? 'nincs tobb valasz'
      // Darabokban, hogy a streamelés is meg legyen merve.
      for (const part of text.match(/[\s\S]{1,17}/g) ?? []) yield { kind: 'text', text: part }
      yield { kind: 'done', model: 'teszt-modell' }
    },
  }
}

async function collect(gen: AsyncGenerator<OrchestratorEvent>): Promise<OrchestratorEvent[]> {
  const out: OrchestratorEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

const textOf = (evs: OrchestratorEvent[]): string =>
  evs.filter((e): e is Extract<OrchestratorEvent, { type: 'text' }> => e.type === 'text').map((e) => e.text).join('')

let projectId = ''
let workItemId = ''
let audit: AuditEntry[] = []

beforeEach(() => {
  initDatabase(':memory:')
  resetRunningForTest()
  resetUsageManagerForTest()
  // Mert, bo keret: a kapu ne ezen buktassa a tobbi tesztet.
  setUsageSnapshotReader(() => ({ fiveHour: { usedPct: 10, resetsAt: null }, measuredAt: Date.now(), updatedAt: Date.now() }))
  audit = []
  setAuditWriterForTest((_p, line) => { audit.push(JSON.parse(line)) })
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
  resetUsageManagerForTest()
})

function turn(message: string, provider: AIProvider, lang: 'hu' | 'en' = 'hu') {
  return collect(runTurn({ projectId, workItemId, message, lang, actor: 'teszt-felhasznalo' }, provider))
}

describe('tiszta logika', () => {
  it('a tool-hivast csak a TELJES JSON valasz jelenti', () => {
    expect(parseToolCall('{"tool":"project.get","input":{}}')).toEqual({ tool: 'project.get', input: {} })
    expect(parseToolCall('```json\n{"tool":"file.read","input":{"path":"a.txt"}}\n```')).toEqual({ tool: 'file.read', input: { path: 'a.txt' } })
    // Prozai valasz, amiben JSON is van -> NEM tool-hivas.
    expect(parseToolCall('Ezt így hívnád: {"tool":"project.get"} — de most nem kell.')).toBeNull()
    expect(parseToolCall('Szia!')).toBeNull()
    expect(parseToolCall('{"nem_tool":1}')).toBeNull()
  })

  it('amig tool-hivas is lehet, nem kuldjuk ki a szoveget', () => {
    expect(mayBeToolCall('')).toBe(true)
    expect(mayBeToolCall('{')).toBe(true)
    expect(mayBeToolCall('{"tool"')).toBe(true)
    expect(mayBeToolCall('Szia')).toBe(false)
  })

  it('az elozetes ellenorzes emberi mondatot ad', () => {
    const base = { projectId, workItemId, lang: 'hu' as const, actor: 'x' }
    const empty = validateTurn({ ...base, message: '   ' })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.message).toMatch(/[áéíóöőúüű]/i)
    const long = validateTurn({ ...base, message: 'x'.repeat(MESSAGE_MAX_CHARS + 1) })
    expect(long.ok).toBe(false)
    expect(validateTurn({ ...base, message: 'jó' }).ok).toBe(true)
  })
})

describe('a teljes fordulo', () => {
  it('prozai valasz: streamel, ment, auditol', async () => {
    const p = fakeProvider(['Szerintem a második bekezdés túl hosszú.'])
    const evs = await turn('Mit gondolsz erről?', p)
    expect(textOf(evs)).toBe('Szerintem a második bekezdés túl hosszú.')
    expect(evs.some((e) => e.type === 'session')).toBe(true)
    expect(evs.at(-1)).toMatchObject({ type: 'done', model: 'teszt-modell' })

    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    const msgs = listAgentMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toContain('túl hosszú')

    expect(audit.map((a) => a.op)).toEqual(['user-message', 'agent-answer'])
    expect(audit[0]).toMatchObject({ agent: 'teszt-felhasznalo', target: workItemId })
  })

  it('a modell a MERT tenyeket kapja meg, es tilos kitalalnia', async () => {
    const p = fakeProvider(['Rendben.'])
    await turn('Hol tartunk?', p)
    const req = p.seen[0]
    expect(req.system).toContain('Never invent')
    expect(req.system).toContain('I cannot see it from here')
    const firstUser = req.messages[0].content
    expect(firstUser).toContain('CONTEXT (measured facts')
    expect(firstUser).toContain('Teszt projekt')
    expect(firstUser).toContain('Ajánlat')
  })

  it('a masodik fordulo latja az elso valaszat', async () => {
    await turn('Első kérdés', fakeProvider(['Első válasz']))
    const p2 = fakeProvider(['Második válasz'])
    await turn('Második kérdés', p2)
    const contents = p2.seen[0].messages.map((m) => m.content).join('\n')
    expect(contents).toContain('Első kérdés')
    expect(contents).toContain('Első válasz')
  })
})

describe('tool-kor', () => {
  it('a tool lefut, az eredmeny visszamegy a modellhez, a JSON nem latszik', async () => {
    const p = fakeProvider([
      '{"tool":"project.get","input":{}}',
      'A projekt neve: Teszt projekt.',
    ])
    const evs = await turn('Mi ennek a projektnek a neve?', p)
    // A felhasznalo SOSE latja a nyers tool-hivast.
    expect(textOf(evs)).toBe('A projekt neve: Teszt projekt.')
    expect(textOf(evs)).not.toContain('"tool"')
    const tools = evs.filter((e) => e.type === 'tool')
    expect(tools.map((t: any) => t.status)).toEqual(['running', 'ok'])
    // A masodik korben a modell megkapta az eredmenyt.
    expect(p.seen[1].messages.map((m) => m.content).join('\n')).toContain('TOOL RESULT (project.get)')
    // A tool-hivas el van mentve.
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    const calls = listToolCalls(session.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ tool_name: 'project.get', status: 'ok' })
    expect(JSON.parse(calls[0].output_json || '{}').name).toBe('Teszt projekt')
  })

  it('ismeretlen tool: nem fut le, es a modell megtudja', async () => {
    const p = fakeProvider(['{"tool":"rakéta.indit","input":{}}', 'Bocsánat, azt nem tudom.'])
    const evs = await turn('Indíts rakétát', p)
    const tool = evs.find((e) => e.type === 'tool') as any
    expect(tool.status).toBe('error')
    expect(tool.detail).toContain('rakéta.indit')
    expect(p.seen[1].messages.map((m) => m.content).join('\n')).toContain('no such tool')
  })

  it('a tool hibaja NEM valik kitalalt valassza: a modell megkapja, mi hianyzik', async () => {
    const p = fakeProvider([
      '{"tool":"file.read","input":{"path":"nincs-ilyen.txt"}}',
      'Ezt a fájlt nem érem el.',
    ])
    const evs = await turn('Olvasd el a fájlt', p)
    const tool = evs.filter((e) => e.type === 'tool').at(-1) as any
    expect(tool.status).toBe('error')
    const followUp = p.seen[1].messages.map((m) => m.content).join('\n')
    expect(followUp).toContain('TOOL RESULT (file.read): error')
    expect(followUp).toContain('Do not invent the answer')
  })
})

describe('jovahagyas -- a MEGLEVO rendszeren at', () => {
  afterEach(() => { setAutonomyLoaderForTest(null) })

  const configWith = (level: number) => () => ({
    version: 1, updated_at: 0,
    categories: [{ key: 'marveen_selfdev', label: 'teszt', level, locked: false, maxLevel: 3 }],
  })

  it('jovahagyas-koteles (2-es szint): /api/approvals jegy szuletik, a tool NEM fut le', async () => {
    setAutonomyLoaderForTest(configWith(2))
    const p = fakeProvider([
      '{"tool":"workItem.create","input":{"title":"Új ajánlat","type":"document"}}',
      'Kértem rá jóváhagyást.',
    ])
    const evs = await turn('Csinálj egy új ajánlatot', p)
    const tool = evs.filter((e) => e.type === 'tool').at(-1) as any
    expect(tool.status).toBe('needs_approval')
    expect(tool.approvalId).toBeTruthy()
    expect(tool.detail).toMatch(/jóváhagyás/i)

    // A jegy a MEGLEVO listaban van, a Munkapad forrasmegjelolesevel.
    const pending = listApprovals({ status: 'pending', limit: 10 })
    expect(pending).toHaveLength(1)
    expect(pending[0].agent_id).toBe('teszt-felhasznalo')
    expect(pending[0].category).toBe('marveen_selfdev')
    const payload = JSON.parse(pending[0].action_payload || '{}')
    expect(payload).toMatchObject({ source: 'workbench', tool: 'workItem.create', project: projectId })

    // A tool tenylegesen NEM futott le: uj munkadarab nem keletkezett.
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    expect(listToolCalls(session.id).at(-1)).toMatchObject({ tool_name: 'workItem.create', status: 'needs_approval' })
    expect(listWorkItems(projectId)).toHaveLength(1)
    expect(audit.some((a) => a.op === 'approval-request')).toBe(true)
  })

  // A tulajdonos "igen"-je utan a kovetkezo keres tenylegesen fusson le -- es
  // ne a kozben szuletett tobbi jegy szamatol fuggjon, hogy eszrevesszuk-e.
  it('a mar JOVAHAGYOTT jegy utan a tool lefut, ujabb kerdes nelkul', async () => {
    setAutonomyLoaderForTest(configWith(2))
    await turn('Csinálj egy új ajánlatot', fakeProvider([
      '{"tool":"workItem.create","input":{"title":"Új ajánlat","type":"document"}}',
      'Kértem rá jóváhagyást.',
    ]))
    const ticket = listApprovals({ status: 'pending', limit: 10 })[0]
    resolveApproval(ticket.id, 'approved', 'teszt')
    // Zaj: sok ujabb jegy, hogy a meretkorlatos lista ne szamitson.
    for (let i = 0; i < 60; i++) {
      const id = `zaj-${i}`
      createApproval({ id, agent_id: 'mas', category: 'marveen_selfdev', action_description: 'zaj', action_payload: '{}' })
      resolveApproval(id, 'approved', 'teszt')
    }

    const evs = await turn('Akkor csináld meg', fakeProvider([
      '{"tool":"workItem.create","input":{"title":"Új ajánlat","type":"document"}}',
      'Kész, létrehoztam.',
    ]))
    expect((evs.filter((e) => e.type === 'tool').at(-1) as any).status).toBe('ok')
    expect(listWorkItems(projectId)).toHaveLength(2)
    // Ujabb kerdes NEM szuletett.
    expect(listApprovals({ status: 'pending', limit: 10 })).toHaveLength(0)
  })

  it('3-as szinten a tool onalloan fut, jegy nelkul', async () => {
    setAutonomyLoaderForTest(configWith(3))
    const p = fakeProvider([
      '{"tool":"workItem.create","input":{"title":"Új jegyzet","type":"note"}}',
      'Kész, létrehoztam.',
    ])
    const evs = await turn('Csinálj egy jegyzetet', p)
    expect((evs.filter((e) => e.type === 'tool').at(-1) as any).status).toBe('ok')
    expect(listApprovals({ status: 'pending', limit: 10 })).toHaveLength(0)
    expect(listWorkItems(projectId).map((i) => i.title)).toContain('Új jegyzet')
  })

  it('1-es szinten meg kerdezni sem lehet: a tool blokkolt', async () => {
    setAutonomyLoaderForTest(configWith(1))
    const p = fakeProvider([
      '{"tool":"workItem.create","input":{"title":"Nem lesz","type":"note"}}',
      'Ezt a beállításaid nem engedik.',
    ])
    const evs = await turn('Csinálj egy jegyzetet', p)
    const tool = evs.filter((e) => e.type === 'tool').at(-1) as any
    expect(tool.status).toBe('blocked')
    expect(listApprovals({ status: 'pending', limit: 10 })).toHaveLength(0)
    expect(listWorkItems(projectId)).toHaveLength(1)
  })

  it('hianyzo beallitas-fajl (friss telepites) NEM ad jogot: jovahagyast ker', async () => {
    setAutonomyLoaderForTest(() => { throw new Error('autonomy-config.json not found') })
    const p = fakeProvider(['{"tool":"workItem.update","input":{"status":"review"}}', 'Kértem jóváhagyást.'])
    const evs = await turn('Tedd átnézésre', p)
    expect((evs.filter((e) => e.type === 'tool').at(-1) as any).status).toBe('needs_approval')
  })

  it('a tiszta olvaso toolok SOSE kernek jovahagyast', async () => {
    setAutonomyLoaderForTest(() => { throw new Error('nincs config') })
    const p = fakeProvider(['{"tool":"project.get","input":{}}', 'A projekt: Teszt projekt.'])
    const evs = await turn('Mi a projekt neve?', p)
    expect((evs.filter((e) => e.type === 'tool').at(-1) as any).status).toBe('ok')
    expect(listApprovals({ status: 'pending', limit: 10 })).toHaveLength(0)
  })
})

describe('friss telepites es keret-hatar', () => {
  it('NINCS szolgaltato: nem dob es nem nemul el, hanem megmondja magyarul', async () => {
    const evs = await turn('Szia', fakeProvider([], { available: false }))
    const notice = evs.find((e) => e.type === 'notice') as any
    expect(notice.code).toBe('no_provider')
    expect(notice.message).toMatch(/nincs beállítva AI-szolgáltató/i)
    expect(evs.at(-1)).toMatchObject({ type: 'done', model: null })
    // A kozles a beszelgetesbe is bekerul, hogy kesobb is latszodjon.
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    expect(listAgentMessages(session.id).some((m) => m.role === 'system')).toBe(true)
  })

  it('NINCS szolgaltato, angol felulet: angol mondat', async () => {
    const evs = await collect(runTurn(
      { projectId, workItemId, message: 'Hi', lang: 'en', actor: 'x' },
      fakeProvider([], { available: false }),
    ))
    const notice = evs.find((e) => e.type === 'notice') as any
    expect(notice.message).toMatch(/No AI provider is set up/i)
  })

  it('a kozos 5 oras keret betelt: nem indul hivas', async () => {
    setUsageSnapshotReader(() => ({ fiveHour: { usedPct: 99, resetsAt: null }, measuredAt: Date.now(), updatedAt: Date.now() }))
    const p = fakeProvider(['Ez sosem hangzik el'])
    const evs = await turn('Szia', p)
    const notice = evs.find((e) => e.type === 'notice') as any
    expect(notice.code).toBe('limit_critical')
    expect(notice.message).toMatch(/5 órás/i)
    // A modellt MEG SEM hivtuk.
    expect(p.seen).toHaveLength(0)
  })

  it('a szolgaltato sajat keret-hibaja is emberi mondat lesz', async () => {
    const p = fakeProvider([], { fail: { kind: 'error', code: 'limit', detail: 'usage limit reached' } })
    const evs = await turn('Szia', p)
    const notice = evs.find((e) => e.type === 'notice') as any
    expect(notice.code).toBe('limit_critical')
  })

  it('a szolgaltato hibajanak OKA a valodi hibauzenetbol jon, nem talalgatasbol', async () => {
    const p = fakeProvider([], { fail: { kind: 'error', code: 'failed', detail: 'ECONNREFUSED 127.0.0.1:1234' } })
    const evs = await turn('Szia', p)
    const notice = evs.find((e) => e.type === 'notice') as any
    expect(notice.message).toContain('ECONNREFUSED 127.0.0.1:1234')
  })
})

describe('parhuzamossag', () => {
  it('egy munkadarabhoz egyszerre egy fordulo fut', async () => {
    const slow: AIProvider = {
      id: 'lassu',
      model: () => 'm',
      availability: () => ({ available: true }),
      async *stream() {
        await new Promise((r) => setTimeout(r, 30))
        yield { kind: 'text', text: 'kész' } as AIChunk
        yield { kind: 'done', model: 'm' } as AIChunk
      },
    }
    const first = collect(runTurn({ projectId, workItemId, message: 'egy', lang: 'hu', actor: 'x' }, slow))
    // A masodik MEG a futas kozben indul.
    await new Promise((r) => setTimeout(r, 5))
    const second = await collect(runTurn({ projectId, workItemId, message: 'kettő', lang: 'hu', actor: 'x' }, slow))
    expect((second[0] as any).code).toBe('busy')
    await first
  })
})

describe('ismeretlen cel', () => {
  it('ismeretlen projekt: emberi hiba, nem osszeomlas', async () => {
    const evs = await collect(runTurn(
      { projectId: 'nincsilyen', workItemId: null, message: 'szia', lang: 'hu', actor: 'x' },
      fakeProvider(['soha']),
    ))
    expect(evs[0]).toMatchObject({ type: 'error', code: 'project_not_found' })
  })

  it('masik projekt munkadarabja nem nyithato meg innen', async () => {
    const other = createProject({ name: 'Másik' })
    if (!other.ok) throw new Error('projekt')
    const evs = await collect(runTurn(
      { projectId: other.project.id, workItemId, message: 'szia', lang: 'hu', actor: 'x' },
      fakeProvider(['soha']),
    ))
    expect(evs[0]).toMatchObject({ type: 'error', code: 'work_item_not_found' })
  })
})
