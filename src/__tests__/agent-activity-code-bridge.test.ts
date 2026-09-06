// Kartya #213 (83321629): a VS Code kulso programozo (kod-hid) sehol nem
// szamitott bele a "hany agens dolgozik eppen" jelvenybe/listaba, mert a
// GET /api/agents/activity -- amibol a jelveny es az Aktivitas lap is dolgozik
// -- soha nem sorolta fel. Ez a teszt azt rogziti, hogy a hid megjelenik
// benne, csendben marad amig nincs bekotott mappa (friss telepites), es a
// state 'working'-re vált, amikor tenylegesen fut egy feladat.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeWorkerSeen,
  enqueueCodeTask, claimNextCodeTask,
} from '../web/code-bridge-store.js'
import { tryHandleAgents } from '../web/routes/agents.js'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

interface Captured { status: number; body: any }

async function callActivity(): Promise<Captured> {
  const req = Readable.from([Buffer.from('')]) as unknown as http.IncomingMessage
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  ;(req as any).headers = {}
  const out: Captured = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status || 200; return res },
    setHeader() { return res },
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(String(chunk)) } catch { out.body = String(chunk) } } },
  } as unknown as http.ServerResponse
  const handled = await tryHandleAgents({ req, res, path: '/api/agents/activity', method: 'GET' } as any, process.cwd())
  if (!handled) throw new Error('route did not handle /api/agents/activity')
  return out
}

describe('GET /api/agents/activity -- code-bridge entry (card 83321629)', () => {
  it('stays silent on a fresh install with no bound folder', async () => {
    const { body } = await callActivity()
    expect(Array.isArray(body)).toBe(true)
    expect(body.some((e: any) => e.name === 'code-bridge')).toBe(false)
  })

  it('shows as stopped when a session exists but no worker has reported in', async () => {
    upsertCodeSession({ project: 'fejlesztes', workspacePath: 'D:\\proj', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
    const { body } = await callActivity()
    const entry = body.find((e: any) => e.name === 'code-bridge')
    expect(entry).toBeDefined()
    expect(entry.state).toBe('stopped')
  })

  it('shows as idle when the worker is online but no task is running', async () => {
    upsertCodeSession({ project: 'fejlesztes', workspacePath: 'D:\\proj', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
    recordCodeWorkerSeen('WINPC', 'poll')
    const { body } = await callActivity()
    const entry = body.find((e: any) => e.name === 'code-bridge')
    expect(entry.state).toBe('idle')
  })

  it('flips to working while a task is actually running, and never reports an openable terminal', async () => {
    upsertCodeSession({ project: 'fejlesztes', workspacePath: 'D:\\proj', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
    recordCodeWorkerSeen('WINPC', 'poll')
    const enqueued = enqueueCodeTask({ project: 'fejlesztes', prompt: 'do the thing' })
    expect('error' in enqueued).toBe(false)
    claimNextCodeTask('WINPC')
    const { body } = await callActivity()
    const entry = body.find((e: any) => e.name === 'code-bridge')
    expect(entry.state).toBe('working')
    expect(entry.running).toBe(false)
  })
})
