// #774 (Boss TG 10319): taking back a review must STOP the VS Code run behind it, not just forget it.
// The owner's words: "a futo ellenorzes LEALL ... a VS Code programozo felszabadul". A running task is
// asked to stop, the worker reads that on its next heartbeat and kills claude.exe, and whatever it still
// reports closes the task as 'cancelled' -- never re-queued, never announced as finished.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask, getCodeTask,
  requestStopCodeTask, completeCodeTaskDetailed, reapExpiredCodeLeases, LEASE_MS,
} from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'

const PS1 = readFileSync(join(__dirname, '..', '..', 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8').replace(/\r\n/g, '\n')

function runningTask(): string {
  upsertCodeSession({ project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
  enqueueCodeTask({ project: 'marvin', prompt: 'review approval x' })
  return claimNextCodeTask('w', 1000)!.id
}

async function heartbeat(id: string): Promise<{ status: number; body: any }> {
  const req = Readable.from([Buffer.from(JSON.stringify({ host: 'w' }))]) as unknown as http.IncomingMessage
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  ;(req as any).headers = { 'content-type': 'application/json' }
  const out = { status: 0, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() { return res },
    end(b?: string) { out.body = b ? JSON.parse(b) : null },
  } as unknown as http.ServerResponse
  const path = `/api/code/tasks/${id}/heartbeat`
  await tryHandleCode({ req, res, path, method: 'POST', url: new URL(`http://127.0.0.1:3420${path}`) } as any)
  return out
}

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

describe('#774: stopping a running VS Code task', () => {
  it('only a running task can be asked to stop; the row stays running until the worker answers', () => {
    const id = runningTask()
    expect(requestStopCodeTask(id, 5000)).toBe(true)
    expect(getCodeTask(id)).toMatchObject({ status: 'running', stopRequestedAt: 5000 })
    const queued = enqueueCodeTask({ project: 'marvin', prompt: 'another' })
    if (!('task' in queued)) throw new Error('enqueue failed')
    expect(requestStopCodeTask(queued.task.id)).toBe(false)
    expect(getCodeTask(queued.task.id)).toMatchObject({ status: 'queued', stopRequestedAt: null })
  })

  it('the heartbeat tells the worker to stop -- and only after a stop was asked', async () => {
    const id = runningTask()
    expect((await heartbeat(id)).body).toEqual({ ok: true })
    requestStopCodeTask(id)
    expect(await heartbeat(id)).toEqual({ status: 200, body: { ok: true, stop: true } })
  })

  it('the answer that still comes in closes the task as cancelled, not done or re-queued', () => {
    const id = runningTask()
    requestStopCodeTask(id)
    const out = completeCodeTaskDetailed(id, { ok: false, error: 'stopped by the owner (taken back on the dashboard)' }, 9000, 'w')
    expect(out.outcome).toBe('cancelled')
    expect(getCodeTask(id)).toMatchObject({ status: 'cancelled', finishedAt: 9000, leaseExpiresAt: null })
  })

  it('a stopped task whose worker went silent is cancelled by the reaper, not started again', () => {
    const id = runningTask()
    requestStopCodeTask(id)
    const { requeued } = reapExpiredCodeLeases(1000 + LEASE_MS + 1)
    expect(requeued).toEqual([])
    expect(getCodeTask(id)!.status).toBe('cancelled')
  })
})

describe('#774: the worker script obeys the stop', () => {
  it('both heartbeat paths read `stop` from the reply', () => {
    expect(PS1).toMatch(/if \(\$hb -and \$hb\.stop\) \{ \$script:StopTaskRequested = \$true \}/)
    expect(PS1).toMatch(/-match '"stop"\\s\*:\\s\*true'\) \{ \$L\.StopTask = \$true \}/)
  })

  it('the run loop kills claude.exe when a stop was asked, and the flag is reset per task', () => {
    const loop = PS1.slice(PS1.indexOf('while (-not $proc.HasExited)'), PS1.indexOf('$proc.WaitForExit(15000)'))
    expect(loop).toMatch(/if \(\$script:StopTaskRequested -or \(\$script:Life -and \$script:Life\.StopTask\)\) \{\s*#[^\n]*\n\s*\$timedOut = \$true/)
    expect(loop).toMatch(/\$proc\.Kill\(\)/)
    expect(PS1).toMatch(/\$script:StopTaskRequested = \$false\n\s*if \(\$script:Life\) \{ \$script:Life\.StopTask = \$false; \$script:Life\.RunSession/)
  })
})
