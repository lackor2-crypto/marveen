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
  runningTaskTabCandidates, recordCodeCandidates, _resetCodeCandidates,
} from '../web/code-bridge-store.js'
import { locateLocalTranscript, readCodeConversation, readTranscriptTailMeta } from '../web/code-conversation.js'

const OLD = 'aaaaaaaa-0000-4000-8000-000000000001'
const RUN = 'eeeeeeee-0000-4000-8000-00000000000a'

let root: string

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
  upsertCodeSession({ project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: OLD })
  root = mkdtempSync(join(tmpdir(), 'conv-run-'))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function runningFresh() {
  enqueueCodeTask({ project: 'marvin', prompt: '\n  csinald meg a kartyat\nmasodik sor' })
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

// Boss, 2026-09-19 (msg 1120): "a kartya feluleten is meg kene jelennie ennek a
// csetnek es a csetnek a cimenek" -- the card's tab list must show the running
// chat even when the worker cannot report (blocked in the task / restart).
describe('futo feladat fule a kartyan, worker-jelentes nelkul', () => {
  function transcript(): string {
    const p = join(root, `${RUN}.jsonl`)
    writeFileSync(p, [
      JSON.stringify({ type: 'user', timestamp: '2026-09-19T08:47:00Z', message: { role: 'user', content: 'x' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-09-19T09:06:10Z', message: { model: 'claude-opus-5', usage: { input_tokens: 2, cache_creation_input_tokens: 1266, cache_read_input_tokens: 280116, output_tokens: 5 } } }),
      JSON.stringify({ type: 'attachment', timestamp: '2026-09-19T09:06:11Z' }),
    ].join('\n') + '\n')
    return p
  }

  it('a napló vegebol meri a kontextust, a modellt es az utolso tevekenyseget', () => {
    const m = readTranscriptTailMeta(transcript())
    expect(m.contextTokens).toBe(2 + 1266 + 280116)
    expect(m.model).toBe('claude-opus-5')
    expect(m.lastActivity).toBe(Date.parse('2026-09-19T09:06:11Z'))
  })

  it('olvashatatlan napló = null, nem 0', () => {
    const m = readTranscriptTailMeta(join(root, 'nincs.jsonl'))
    expect(m).toEqual({ contextTokens: null, model: null, lastActivity: null, mtime: null })
  })

  it('a futo feladat fulkent megjelenik a bekotott projekt alatt, cimmel', () => {
    runningFresh()
    const p = transcript()
    const cands = runningTaskTabCandidates([], (sid) => (sid === RUN ? p : null))
    expect(cands).toHaveLength(1)
    expect(cands[0]).toMatchObject({
      sessionId: RUN, workspacePath: 'C:\\ws\\marvin', title: 'csinald meg a kartyat',
      live: true, contextTokens: 281384, model: 'claude-opus-5', pid: null, transcriptPath: p,
    })
  })

  it('amit a worker mar jelentett, azt nem duplazza', () => {
    runningFresh()
    const p = transcript()
    recordCodeCandidates('w', [{ workspacePath: 'C:\\ws\\marvin', sessionId: RUN, live: true, contextTokens: 5 }])
    expect(runningTaskTabCandidates([{ sessionId: RUN } as never], () => p)).toEqual([])
  })

  it('nem talalt napló = nincs ful (nem talalunk ki szamokat)', () => {
    runningFresh()
    expect(runningTaskTabCandidates([], () => null)).toEqual([])
  })

  it('befejezett feladatbol nem lesz ful', () => {
    const t = runningFresh()
    const p = transcript()
    completeCodeTaskDetailed(t.id, { ok: true, result: 'kesz' }, Date.now(), 'w')
    expect(runningTaskTabCandidates([], () => p)).toEqual([])
  })
})
