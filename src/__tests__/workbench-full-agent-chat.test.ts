// #433 (B opcio) a VALODI utvonalkezelon at: a Munkapad chat teljes erteku
// modban a kod-hidra megy. Merve (2026-09-28): a kod-hid eddig CSAK a puszta
// utolso mondatot kapta ("na most meg tudod csinalni?"), a fordulo nem kerult
// a beszelgetesbe, es a "mar fut" zar sem vonatkozott ra. Itt a kod-hid-tarolo
// es a beallitas mockolt: valodi worker es valodi Claude-hivas nelkul.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'

const enqueued: { project: string; prompt: string }[] = []
let taskState: { status: string; result: string | null; summary: string | null; error: string | null } = { status: 'done', result: 'Kész: végigolvastam.', summary: null, error: null }

vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return { ...actual, getEffectiveSettingValue: (k: string) => (k === 'WORKBENCH_FULL_AGENT' ? '1' : k.startsWith('WORKBENCH_') ? '' : actual.getEffectiveSettingValue(k)) }
})
vi.mock('../web/code-bridge-store.js', async (orig) => {
  const actual = await orig<typeof import('../web/code-bridge-store.js')>()
  return {
    ...actual,
    codeBridgeHealth: () => ({ workerOnline: true }) as unknown as ReturnType<typeof actual.codeBridgeHealth>,
    enqueueCodeTask: (i: { project: string; prompt: string }) => { enqueued.push({ project: i.project, prompt: i.prompt }); return { task: { id: 'task-1' } } },
    getCodeTask: () => ({ id: 'task-1', ...taskState }),
    cancelCodeTask: () => null,
  }
})

import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { resetRunningForTest, claimTurn, releaseTurn, turnKey, isTurnRunning } from '../workbench-agent/orchestrator.js'
import { openSessionForWorkItem, addAgentMessage, listAgentMessages } from '../workbench-agent/sessions.js'
import { resetWorkbenchAgentForTest } from '../workbench-agent/index.js'
import { setAuditWriterForTest } from '../workbench-agent/audit.js'
import { tryHandleWorkbenchAgent } from '../web/routes/workbench-agent.js'
import type { RouteContext } from '../web/routes/types.js'

async function post(path: string, body: unknown): Promise<{ status: number; raw: string }> {
  const out = { status: 200, raw: '' }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    write(chunk: string) { out.raw += chunk; return true },
    end(chunk?: string) { if (chunk) out.raw += chunk },
    on() { return res },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost:3420${path}`)
  await tryHandleWorkbenchAgent({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'session', user: 'teszt' } } as unknown as RouteContext)
  return out
}

let projectId = ''
let workItemId = ''

beforeEach(() => {
  initDatabase(':memory:')
  resetRunningForTest()
  resetWorkbenchAgentForTest()
  setAuditWriterForTest(() => { /* nem ir valodi naploba */ })
  enqueued.length = 0
  taskState = { status: 'done', result: 'Kész: végigolvastam.', summary: null, error: null }
  const p = createProject({ name: 'Iroda fejlesztese' })
  if (!p.ok) throw new Error('projekt')
  projectId = p.project.id
  const w = createWorkItem({ project_id: projectId, title: 'Vélemény az MD-tervről', type: 'document' })
  if (!w.ok) throw new Error('munkadarab')
  workItemId = w.item.id
})

afterEach(() => {
  setAuditWriterForTest(null)
  resetWorkbenchAgentForTest()
})

describe('Munkapad chat teljes erteku modban (kod-hid)', () => {
  it('a kod-hid a beszelgetes elozmenyet es a munkadarabot is megkapja, nem csak az utolso mondatot', async () => {
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    addAgentMessage(session.id, 'user', 'Véleményezd az MD-tervet, vitatkozz a ChatGPT-vel.')
    addAgentMessage(session.id, 'assistant', 'A 6-8. fejezetet nem láttam, és a kódba nem látok bele.')

    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'na most meg tudod csinalni?' })
    expect(r.status).toBe(200)
    expect(enqueued).toHaveLength(1)
    const prompt = enqueued[0].prompt
    expect(prompt).toContain('Iroda fejlesztese')
    expect(prompt).toContain('Vélemény az MD-tervről')
    expect(prompt).toContain('OWNER: Véleményezd az MD-tervet')
    expect(prompt).toContain('ASSISTANT: A 6-8. fejezetet nem láttam')
    expect(prompt.trimEnd().endsWith('na most meg tudod csinalni?')).toBe(true)
  })

  it('a kerdes es a valasz a beszelgetesbe kerul (ujratoltes utan is latszik)', async () => {
    await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'olvasd el a tervet' })
    const msgs = listAgentMessages(openSessionForWorkItem(projectId, workItemId, 'hu').id)
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'olvasd el a tervet'],
      ['assistant', 'Kész: végigolvastam.'],
    ])
    expect(isTurnRunning(turnKey(projectId, workItemId))).toBe(false)
  })

  it('a hiba valodi oka a chatbe es a naploba is bekerul', async () => {
    taskState = { status: 'error', result: "You've hit your session limit · resets 2:10am (Europe/Budapest)", summary: null, error: 'Claude Code reported an error' }
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'szia' })
    expect(r.raw).toContain('session limit')
    const msgs = listAgentMessages(openSessionForWorkItem(projectId, workItemId, 'hu').id)
    expect(msgs.at(-1)?.role).toBe('system')
    expect(msgs.at(-1)?.content).toContain('session limit')
  })

  it('ugyanaz a "mar fut" zar vonatkozik ra, mint a projekt-asszisztensre', async () => {
    expect(claimTurn(turnKey(projectId, workItemId))).toBe(true)
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'masodik' })
    expect(r.raw).toContain('"code":"busy"')
    expect(enqueued).toHaveLength(0)
    releaseTurn(turnKey(projectId, workItemId))
  })
})
