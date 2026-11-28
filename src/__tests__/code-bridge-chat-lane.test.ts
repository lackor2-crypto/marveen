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
  CHAT_LANE_ALIVE_MS, codeTaskQueueAhead, ownerMessagesWaiting, OWNER_LANE_WANTED_MS,
} from '../web/code-bridge-store.js'
import { bridgeStartWaitMs, runCodeBridgeTurn } from '../workbench-agent/code-bridge-turn.js'
import { msg } from '../workbench-agent/messages.js'

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

describe('#998: a chat message does not wait behind development work of the same project', () => {
  function add(origin: 'api' | 'workbench', prompt: string, tab?: string) {
    const r = enqueueCodeTask({ project: 'marveen', prompt, origin, chatId: origin === 'workbench' ? 'chat-1' : undefined, sessionId: tab })
    if (!('task' in r)) throw new Error(r.error)
    return r.task.id
  }

  it('the chat lane starts it while a development task of that project runs and more wait', () => {
    const t0 = Date.now()
    add('api', 'running dev task')
    expect(claimNextCodeTask('windows', t0)?.origin).toBe('api')
    add('api', 'queued dev task')
    expect(claimNextCodeTask('windows', t0, 'chat')).toBeNull() // the idle chat lane shows itself
    const chat = add('workbench', 'chat message')
    expect(codeTaskQueueAhead(chat, t0)).toMatchObject({ running: null, ahead: 0 })
    expect(claimNextCodeTask('windows', t0 + 1, 'chat')?.id).toBe(chat)
  })

  it('a running chat holds back neither the development queue nor another conversation', () => {
    const t0 = Date.now()
    add('workbench', 'first chat')
    expect(claimNextCodeTask('windows', t0, 'chat')?.origin).toBe('workbench')
    const second = add('workbench', 'second chat')
    const dev = add('api', 'dev task')
    expect(codeTaskQueueAhead(second, t0 + 1)).toMatchObject({ running: null, ahead: 0 })
    expect(claimNextCodeTask('windows', t0 + 1, 'chat')?.id).toBe(second)
    expect(codeTaskQueueAhead(dev, t0 + 1)).toMatchObject({ running: null, ahead: 0 })
    expect(claimNextCodeTask('windows', t0 + 2)?.id).toBe(dev)
  })

  it('two processes never write into one conversation', () => {
    const tab = 'cccccccc-0000-4000-8000-000000000003'
    const t0 = Date.now()
    add('workbench', 'chat in a tab', tab)
    expect(claimNextCodeTask('windows', t0, 'chat')?.sessionId).toBe(tab)
    add('api', 'dev for the same tab', tab)
    expect(claimNextCodeTask('windows', t0 + 1)).toBeNull()
  })

  it('a task that never started is not reported as "still working"', async () => {
    const said: string[] = []
    for (const status of ['queued', 'running'] as const) {
      let now = 0
      const turn = runCodeBridgeTurn(
        { message: 'x', lang: 'hu', projectRef: 'marveen', requestedBy: null },
        {
          enqueue: () => ({ ok: true, id: 't1' }),
          getTask: () => ({ status, result: null, summary: null, error: null }),
          now: () => (now += 60_000),
          sleep: async () => {},
          timeoutMs: 120_000,
          backgroundMs: 0,
        },
      )
      for await (const ev of turn) {
        if (ev.type === 'notice' && ev.code.startsWith('code_bridge_timeout')) said.push(ev.message)
      }
    }
    expect(said[0]).toContain('nem indult el')
    expect(said[0]).not.toContain('dolgozik')
    expect(said[1]).toContain('még dolgozik')
  })

  it('the chat status row says "queued", not "working", while the task has not started', () => {
    const web = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf-8')
    expect(web).toContain("ev.code === 'code_bridge_timeout_queued') turn.background = true")
    expect(web).toContain("label = t('workbench.chat.act_bridge_queued')")
    expect(web).toContain('x.bridgeQueued = !!r.data.queued')
  })

  it('a message typed into the code bridge window goes before the queued automatic work', () => {
    const t0 = Date.now()
    add('api', 'running dev task')
    claimNextCodeTask('windows', t0)
    enqueueCodeTask({ project: 'marveen', prompt: 'approval check', origin: 'dashboard', requestedBy: 'usalackor' })
    const typed = enqueueCodeTask({ project: 'marveen', prompt: 'typed', origin: 'dashboard', requestedBy: 'dashboard' })
    if (!('task' in typed)) throw new Error(typed.error)
    expect(claimNextCodeTask('windows', t0 + 1, 'chat')?.id).toBe(typed.task.id)
    expect(claimNextCodeTask('windows', t0 + 2)).toBeNull()
  })

  it('asks for one more lane while a typed message waits', () => {
    const t0 = Date.now()
    add('workbench', 'waiting')
    expect(ownerMessagesWaiting(t0)).toBe(0)
    expect(ownerMessagesWaiting(t0 + OWNER_LANE_WANTED_MS + 1000)).toBe(1)
    claimNextCodeTask('windows', t0 + 1, 'chat')
    expect(ownerMessagesWaiting(t0 + OWNER_LANE_WANTED_MS + 1000)).toBe(0)
  })

  it('the Windows worker opens extra lanes on demand', () => {
    const ps1 = readFileSync(new URL('../../scripts/windows/marvin-code-worker.ps1', import.meta.url), 'utf-8')
    expect(ps1).toContain("'-Lane', 'chat', '-Slot', $n")
    expect(ps1).toContain('Start-ExtraChatLane -Reply $hb')
    expect(ps1).toContain('Start-ExtraChatLane -Reply $claim')
  })

  it('a chat message nobody takes is taken back and handed over, so it can start another way', async () => {
    for (const elsewhere of [true, false]) {
      let now = 0
      const cancelled: string[] = []
      const codes: string[] = []
      const turn = runCodeBridgeTurn(
        { message: 'x', lang: 'hu', projectRef: 'marveen', requestedBy: null },
        {
          enqueue: () => ({ ok: true, id: 't1' }),
          getTask: () => ({ status: 'queued', result: null, summary: null, error: null }),
          now: () => (now += 5_000),
          sleep: async () => {},
          timeoutMs: 120_000,
          backgroundMs: 0,
          startElsewhereAfterMs: 20_000,
          canContinueElsewhere: () => elsewhere,
          cancel: (id) => { cancelled.push(id) },
        },
      )
      for await (const ev of turn) if (ev.type === 'error' || ev.type === 'notice') codes.push(ev.code)
      expect(codes.includes('code_bridge_not_started')).toBe(elsewhere)
      expect(cancelled).toEqual(elsewhere ? ['t1'] : [])
    }
  })

  it('a switched-off bridge is not waited for', async () => {
    expect(bridgeStartWaitMs(true, 20_000)).toBe(20_000)
    let now = 0
    const codes: string[] = []
    const turn = runCodeBridgeTurn(
      { message: 'x', lang: 'hu', projectRef: 'marveen', requestedBy: null },
      {
        enqueue: () => ({ ok: true, id: 't1' }),
        getTask: () => ({ status: 'queued', result: null, summary: null, error: null }),
        now: () => (now += 1),
        sleep: async () => {},
        timeoutMs: 100,
        backgroundMs: 0,
        startElsewhereAfterMs: bridgeStartWaitMs(false, 20_000),
        canContinueElsewhere: () => true,
        cancel: () => {},
      },
    )
    for await (const ev of turn) if (ev.type === 'error') codes.push(ev.code)
    expect(codes).toEqual(['code_bridge_not_started'])
    expect(now).toBeLessThan(10)
  })

  it('the Workbench route continues it in the live session and releases an orphaned queued message', () => {
    const route = readFileSync(new URL('../web/routes/workbench-agent.ts', import.meta.url), 'utf-8')
    expect(route).toContain('startElsewhereAfterMs: bridgeStartWaitMs(codeBridgeEnabled(), BRIDGE_START_WAIT_MS)')
    expect(route).toContain("ev.code === 'code_bridge_not_started' || ev.code === 'code_bridge_enqueue_failed')) {")
    expect(route).toContain('releaseUnstartedBridgeTask(chatSession.id, lang)')
  })

  it('a message the bridge refuses is handed over too, when another way can work', async () => {
    for (const elsewhere of [true, false]) {
      const seen: string[] = []
      const turn = runCodeBridgeTurn(
        { message: 'x', lang: 'hu', projectRef: 'ismeretlen', requestedBy: null },
        {
          enqueue: () => ({ ok: false, message: 'no sessions registered yet' }),
          getTask: () => null,
          now: () => 0,
          sleep: async () => {},
          cancel: () => {},
          canContinueElsewhere: () => elsewhere,
        },
      )
      for await (const ev of turn) seen.push(`${ev.type}:${'code' in ev ? ev.code : ''}`)
      expect(seen).toEqual(elsewhere ? ['error:code_bridge_enqueue_failed'] : ['notice:code_bridge_enqueue_failed', 'done:'])
    }
  })

  it('handing a task over does not claim that somebody is already working on it', () => {
    expect(msg('code_bridge_handed_off', 'hu', { id: 'x' })).not.toMatch(/Dolgozik/i)
    expect(msg('code_bridge_handed_off', 'en', { id: 'x' })).not.toMatch(/working/i)
  })
})
