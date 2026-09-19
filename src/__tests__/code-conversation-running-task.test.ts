// Boss, 2026-09-19: "nem tudok belenezni a chat ablakba, hogy mit dolgozik a
// Marvin VS Code". A "dolgozik" gomb a futo feladat friss beszelgeteset
// (`run_session_id`) nyitja, de a worker ciklusa a feladat alatt all, tehat a
// fult csak a feladat VEGEN jelenti -- addig "nem latok oda" (no-session).
// Ez a keszlet a ket javitast vedi: (1) a szerver a futo feladatbol es a helyi
// naplobol megtalalja a beszelgetest; (2) a worker a futas alatt is jelent.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask,
  heartbeatCodeTask, findRunningTaskByRunSession, completeCodeTaskDetailed,
} from '../web/code-bridge-store.js'
import { locateLocalTranscript, readCodeConversation } from '../web/code-conversation.js'

const OLD = 'aaaaaaaa-0000-4000-8000-000000000001'
const RUN = 'eeeeeeee-0000-4000-8000-00000000000a'

let root: string

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  upsertCodeSession({ project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: OLD })
  root = mkdtempSync(join(tmpdir(), 'conv-run-'))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function runningFresh() {
  enqueueCodeTask({ project: 'marvin', prompt: 'csinald meg' })
  const t = claimNextCodeTask('w')!
  heartbeatCodeTask(t.id, 'w', Date.now(), RUN)
  return t
}

describe('futo feladat beszelgetese a worker jelentese elott', () => {
  it('a futo feladat megnevezi a beszelgeteset', () => {
    const t = runningFresh()
    expect(findRunningTaskByRunSession(RUN)).toMatchObject({ id: t.id, project: 'marvin' })
  })

  it('befejezett feladatra nem valaszol (onnantol a worker jelentese a forras)', () => {
    const t = runningFresh()
    completeCodeTaskDetailed(t.id, { ok: true, result: 'kesz' }, Date.now(), 'w')
    expect(findRunningTaskByRunSession(RUN)).toBeNull()
  })

  it('ervenytelen vagy ismeretlen azonositora null', () => {
    runningFresh()
    expect(findRunningTaskByRunSession('nem-uuid')).toBeNull()
    expect(findRunningTaskByRunSession(OLD)).toBeNull()
  })

  it('a helyi naplot PONTOS fajlnevvel talalja meg, es olvashato', () => {
    const projects = join(root, '.claude', 'projects')
    mkdirSync(join(projects, '-home-x-other'), { recursive: true })
    mkdirSync(join(projects, '-home-x-wt'), { recursive: true })
    const p = join(projects, '-home-x-wt', `${RUN}.jsonl`)
    writeFileSync(p, JSON.stringify({
      type: 'user', timestamp: '2026-09-19T08:47:00Z',
      message: { role: 'user', content: 'folytasd a felbehagyott munkadat!' },
    }) + '\n')
    expect(locateLocalTranscript(RUN, [projects])).toBe(p)
    const conv = readCodeConversation(p, RUN, { limit: 50, offset: 0 })
    expect(conv.reason).toBeNull()
    expect(conv.entries.some((e) => e.text.includes('folytasd'))).toBe(true)
  })

  it('nincs meg = null, nem ures beszelgetes (a nulla nem "nincs benne semmi")', () => {
    const projects = join(root, '.claude', 'projects')
    mkdirSync(join(projects, '-home-x-wt'), { recursive: true })
    expect(locateLocalTranscript(RUN, [projects])).toBeNull()
    expect(locateLocalTranscript(RUN, [join(root, 'nincs-ilyen')])).toBeNull()
    expect(locateLocalTranscript('nem-uuid', [projects])).toBeNull()
  })
})

describe('worker: a session-jelentes a futas alatt is megy', () => {
  const ps1 = readFileSync(join(__dirname, '..', '..', 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8')
    .replace(/\r\n/g, '\n')

  it('az Invoke-CodeTask varakozo ciklusa hivja a Publish-Sessions-t', () => {
    const start = ps1.indexOf('function Invoke-CodeTask')
    expect(start).toBeGreaterThan(-1)
    const body = ps1.slice(start)
    const loop = body.slice(body.indexOf('while (-not $proc.HasExited)'))
    const loopEnd = loop.indexOf('$proc.WaitForExit(15000)')
    expect(loop.slice(0, loopEnd)).toContain('Publish-Sessions')
  })
})
