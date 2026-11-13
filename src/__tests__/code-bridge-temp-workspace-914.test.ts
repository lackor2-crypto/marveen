// #914 -- a temporary folder never becomes a project card by itself.
//
// MEASURED CASE (2026-11-13). An isolated test instance's Workbench chat opened a Claude
// conversation in its throw-away depot (`/tmp/.../scratchpad/depot-bl/Projektek/teszt`).
// The worker's discovery reported that folder like any other, the server registered it as
// the project "teszt", the owner saw a second "WSL" external-programmer card nobody asked
// for -- and, being the most recently active WSL session, it was picked as the fallback for
// two of the owner's real Workbench chats, which then ran inside the scratch folder.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, getCodeSession, listCodeSessions, pickFallbackSession,
} from '../web/code-bridge-store.js'
import { isTempWorkspacePath, tryHandleCode } from '../web/routes/code.js'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

async function report(sessions: unknown[]): Promise<{ status: number; body: any }> {
  const req = Readable.from([Buffer.from(JSON.stringify({ host: 'w', sessions }))]) as unknown as http.IncomingMessage
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  ;(req as any).headers = { 'content-type': 'application/json' }
  let status = 0
  let raw = ''
  const res = {
    writeHead(s: number) { status = s; return res },
    setHeader() { return res },
    end(chunk?: unknown) { if (chunk) raw += String(chunk) },
  } as unknown as http.ServerResponse
  const handled = await tryHandleCode({
    req, res, path: '/api/code/sessions', method: 'POST',
    url: new URL('http://127.0.0.1:3420/api/code/sessions'),
  } as any)
  expect(handled).toBe(true)
  let body: any = null
  try { body = JSON.parse(raw) } catch { /* not needed by every case */ }
  return { status, body }
}

const SCRATCH_UNC = '\\\\wsl.localhost\\Ubuntu\\tmp\\claude-1000\\-home-x-agents-a\\31e03e74\\scratchpad\\depot-bl\\Projektek\\teszt'
const REAL = { project: 'marveen', workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\x\\marveen', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

describe('isTempWorkspacePath', () => {
  it('knows the temporary places of both sides', () => {
    expect(isTempWorkspacePath('/tmp/claude-1000/x/scratchpad/depot/Projektek/teszt')).toBe(true)
    expect(isTempWorkspacePath(SCRATCH_UNC)).toBe(true)
    expect(isTempWorkspacePath('/var/tmp/proba')).toBe(true)
    expect(isTempWorkspacePath(`${tmpdir()}/valami`)).toBe(true)
    expect(isTempWorkspacePath('C:\\Users\\Valaki\\AppData\\Local\\Temp\\proba')).toBe(true)
    expect(isTempWorkspacePath('C:\\Windows\\Temp\\proba')).toBe(true)
  })

  it('leaves real folders alone, also the ones that only sound temporary', () => {
    expect(isTempWorkspacePath('/home/x/marveen')).toBe(false)
    expect(isTempWorkspacePath('/home/x/tmp-projekt')).toBe(false)
    expect(isTempWorkspacePath('/home/x/munka/tmp/projekt')).toBe(false)
    expect(isTempWorkspacePath('f:\\Marveen\\Projektek\\Temp')).toBe(false)
    expect(isTempWorkspacePath('/tmpfile')).toBe(false)
    expect(isTempWorkspacePath('')).toBe(false)
  })
})

describe('discovery: a temporary folder', () => {
  it('registers NO project card (the measured case)', async () => {
    upsertCodeSession(REAL)
    await report([
      { workspacePath: REAL.workspacePath, sessionId: REAL.sessionId, mtime: 1000 },
      { workspacePath: SCRATCH_UNC, sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', mtime: 2000 },
    ])
    expect(listCodeSessions().map((s) => s.project)).toEqual(['marveen'])
  })

  it('so the owner\'s chat falls back to the real session, not to the scratch folder', async () => {
    upsertCodeSession(REAL)
    await report([
      { workspacePath: REAL.workspacePath, sessionId: REAL.sessionId, mtime: 1000 },
      // newer than the real one: this is what made it win the fallback pick
      { workspacePath: SCRATCH_UNC, sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', mtime: 9_999_999_999_999 },
    ])
    expect(pickFallbackSession('wsl')?.project).toBe('marveen')
  })

  it('removes a card that discovery made of it earlier', async () => {
    upsertCodeSession({ project: 'teszt', workspacePath: SCRATCH_UNC, sessionId: 'cccccccc-0000-4000-8000-000000000003' }, { fromDiscovery: true })
    expect(getCodeSession('teszt')).toBeTruthy()
    await report([{ workspacePath: SCRATCH_UNC, sessionId: 'cccccccc-0000-4000-8000-000000000003' }])
    expect(getCodeSession('teszt')).toBeFalsy()
  })

  it('stays, when the OWNER connected it by hand (no hidden limit)', async () => {
    upsertCodeSession({ project: 'teszt', workspacePath: SCRATCH_UNC, sessionId: 'dddddddd-0000-4000-8000-000000000004', pinned: true })
    await report([{ workspacePath: SCRATCH_UNC, sessionId: 'dddddddd-0000-4000-8000-000000000004', mtime: 5 }])
    expect(getCodeSession('teszt')?.pinned).toBe(true)
  })

  it('does not touch a same-named project that lives in a real folder', async () => {
    upsertCodeSession({ project: 'teszt', workspacePath: '/home/x/teszt', sessionId: 'eeeeeeee-0000-4000-8000-000000000005' })
    await report([
      { workspacePath: '/home/x/teszt', sessionId: 'eeeeeeee-0000-4000-8000-000000000005' },
      { workspacePath: SCRATCH_UNC, sessionId: 'ffffffff-0000-4000-8000-000000000006' },
    ])
    expect(getCodeSession('teszt')?.workspacePath).toBe('/home/x/teszt')
  })
})
