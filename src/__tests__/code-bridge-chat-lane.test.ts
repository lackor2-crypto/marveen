// #433 -- a Workbench chat message must not wait behind a long development task.
//
// One Windows worker ran one task at a time, so a chat message of project
// `tozsde` queued 42 minutes behind a 24-minute task of project `marveen`
// (measured 2026-09-30). The chat lane is a second worker process that claims
// only `origin = 'workbench'` tasks; the main lane leaves those to it while it
// is alive and takes them back when it is silent.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeWorkerSeen, recordCodeCandidates,
  _resetCodeCandidates, enqueueCodeTask, claimNextCodeTask, chatLaneAlive, resetChatLaneForTest,
  CHAT_LANE_ALIVE_MS,
} from '../web/code-bridge-store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MARVEEN = { project: 'marveen', workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }
const TOZSDE = { project: 'tozsde', workspacePath: 'C:\\Users\\boss\\tozsde', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
  resetChatLaneForTest()
  upsertCodeSession(MARVEEN)
  upsertCodeSession(TOZSDE)
  recordCodeWorkerSeen('windows', 'discovery', 1)
  recordCodeCandidates('windows', [])
})

function queue(project: string, origin: 'api' | 'workbench', prompt: string) {
  const r = enqueueCodeTask({ project, prompt, origin, chatId: origin === 'workbench' ? 'chat-1' : undefined })
  expect('task' in r).toBe(true)
}

describe('#433: chat lane', () => {
  it('the chat lane takes the chat task WHILE the main lane is busy with a development task', () => {
    queue('marveen', 'api', 'long dev task')
    const dev = claimNextCodeTask('windows')
    expect(dev?.project).toBe('marveen')
    queue('tozsde', 'workbench', 'chat message')
    const chat = claimNextCodeTask('windows', Date.now(), 'chat')
    expect(chat?.project).toBe('tozsde')
    expect(chat?.origin).toBe('workbench')
  })

  it('the chat lane never takes a development task', () => {
    queue('marveen', 'api', 'dev')
    expect(claimNextCodeTask('windows', Date.now(), 'chat')).toBeNull()
  })

  it('while the chat lane is alive the main lane leaves chat tasks to it', () => {
    const t0 = Date.now()
    expect(claimNextCodeTask('windows', t0, 'chat')).toBeNull() // idle claim = liveness
    queue('tozsde', 'workbench', 'chat message')
    queue('marveen', 'api', 'dev')
    const main = claimNextCodeTask('windows', t0 + 1000)
    expect(main?.origin).toBe('api')
    expect(claimNextCodeTask('windows', t0 + 2000)).toBeNull()
  })

  it('a silent chat lane is not waited for: the main lane takes the chat task back', () => {
    const t0 = Date.now()
    claimNextCodeTask('windows', t0, 'chat')
    expect(chatLaneAlive(t0 + CHAT_LANE_ALIVE_MS)).toBe(true)
    expect(chatLaneAlive(t0 + CHAT_LANE_ALIVE_MS + 1)).toBe(false)
    queue('tozsde', 'workbench', 'chat message')
    expect(claimNextCodeTask('windows', t0 + CHAT_LANE_ALIVE_MS + 1)?.origin).toBe('workbench')
  })

  it('with no chat lane at all nothing changes: the main lane takes chat tasks', () => {
    queue('tozsde', 'workbench', 'chat message')
    expect(claimNextCodeTask('windows')?.origin).toBe('workbench')
  })

  it('the claim route forwards only the literal chat lane', () => {
    const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'code.ts'), 'utf8')
    expect(route).toMatch(/body\.lane === 'chat'/)
    expect(route).toMatch(/claimNextCodeTask\(host, Date\.now\(\), lane\)/)
  })

  it('the Windows worker has a chat lane: own mutex, own alive file, no discovery, started by the main worker', () => {
    const ps = readFileSync(join(ROOT, 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8')
    expect(ps).toMatch(/\[string\]\$Lane = ''/)
    expect(ps).toContain("'Global\\MarvinCodeWorker.chat'")
    expect(ps).toContain("'alive-chat.txt'")
    expect(ps).toMatch(/\$claimBody\['lane'\] = 'chat'/)
    expect(ps).toMatch(/if \(\(-not \$script:IsChatLane\) -and \(-not \$claim/)
    expect(ps).toMatch(/function Start-ChatLane/)
    expect(ps).toMatch(/'-Lane', 'chat'/)
  })
})
