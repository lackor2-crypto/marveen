import { describe, it, expect } from 'vitest'
import { runCodeBridgeTurn, type CodeBridgeTurnDeps, type CodeBridgeTaskView, type CodeBridgeStatus } from '../workbench-agent/code-bridge-turn.js'
import type { OrchestratorEvent } from '../workbench-agent/orchestrator.js'

/** A generator osszes esemenye egy tombbe. */
async function collect(gen: AsyncGenerator<OrchestratorEvent>): Promise<OrchestratorEvent[]> {
  const out: OrchestratorEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

/** Fake ora, ami minden sleep-nel elorehalad -- igy a timeout determinisztikus. */
function fakeClock(stepMs: number): { now(): number; sleep(ms: number): Promise<void> } {
  let t = 0
  return {
    now: () => t,
    sleep: async () => { t += stepMs },
  }
}

/** Fake feladatsor: statuszok listaja, minden getTask a kovetkezot adja. */
function fakeTasks(states: CodeBridgeTaskView[]): { getTask(): CodeBridgeTaskView | null } {
  let i = 0
  return {
    getTask: () => {
      const s = states[Math.min(i, states.length - 1)] ?? null
      i++
      return s
    },
  }
}

const task = (status: CodeBridgeStatus, extra: Partial<CodeBridgeTaskView> = {}): CodeBridgeTaskView => ({
  status, result: null, summary: null, error: null, ...extra,
})

const baseInput = { projectRef: 'p1', message: 'olvasd el a fajlt', lang: 'hu' as const, requestedBy: 'boss' }

describe('runCodeBridgeTurn -- Munkapad chat a kod-hidon (#433, B opcio)', () => {
  it('sikeres futas: atadas -> fut -> kesz, a result szovegkent jon vissza', async () => {
    const clock = fakeClock(1000)
    const tasks = fakeTasks([task('queued'), task('running'), task('done', { result: 'Kesz, elolvastam az egeszet.' })])
    const deps: CodeBridgeTurnDeps = {
      enqueue: () => ({ ok: true, id: 'task-1' }),
      getTask: tasks.getTask,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 10,
    }
    const evs = await collect(runCodeBridgeTurn(baseInput, deps))
    const types = evs.map((e) => e.type)
    expect(types).toContain('notice') // handed_off
    expect(evs.find((e) => e.type === 'notice')).toMatchObject({ code: 'code_bridge_handed_off' })
    const text = evs.find((e) => e.type === 'text') as Extract<OrchestratorEvent, { type: 'text' }> | undefined
    expect(text?.text).toBe('Kesz, elolvastam az egeszet.')
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('ures valasz: kesz, de nincs result -> nem hallgat el, notice megy', async () => {
    const clock = fakeClock(1000)
    const tasks = fakeTasks([task('done', { result: '   ', summary: '' })])
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
    }))
    expect(evs.some((e) => e.type === 'text')).toBe(false)
    expect(evs.some((e) => e.type === 'notice' && (e as { code: string }).code === 'code_bridge_done_empty')).toBe(true)
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('hiba: a feladat error -> a tenyleges hibaszoveg megy ki (nem talalgatunk)', async () => {
    const clock = fakeClock(1000)
    const tasks = fakeTasks([task('error', { error: 'tsc failed: 3 errors' })])
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
    }))
    const err = evs.find((e) => e.type === 'error') as Extract<OrchestratorEvent, { type: 'error' }> | undefined
    expect(err?.message).toBe('tsc failed: 3 errors')
    expect(evs.some((e) => e.type === 'done')).toBe(false) // error zar, nincs kulon done
  })

  it('enqueue-hiba: a chat nem hal meg, notice + done', async () => {
    const clock = fakeClock(1000)
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: false, message: 'nincs elerheto session' }),
      getTask: () => null, now: clock.now, sleep: clock.sleep,
    }))
    const notice = evs.find((e) => e.type === 'notice') as Extract<OrchestratorEvent, { type: 'notice' }> | undefined
    expect(notice?.code).toBe('code_bridge_enqueue_failed')
    expect(notice?.message).toContain('nincs elerheto session')
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('megszakitas: abort utan cancelled notice + done, nem var tovabb', async () => {
    const clock = fakeClock(1000)
    const ac = new AbortController()
    ac.abort()
    const tasks = fakeTasks([task('running')])
    const evs = await collect(runCodeBridgeTurn({ ...baseInput, signal: ac.signal }, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
    }))
    expect(evs.some((e) => e.type === 'notice' && (e as { code: string }).code === 'code_bridge_cancelled')).toBe(true)
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('idotullepes: sokaig fut -> timeout notice + done (a hattérnek engedjuk)', async () => {
    const clock = fakeClock(60_000) // minden poll +1 perc
    const tasks = fakeTasks([task('running')]) // sosem fejezodik be
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
      pollMs: 1, timeoutMs: 5 * 60_000,
    }))
    expect(evs.some((e) => e.type === 'notice' && (e as { code: string }).code === 'code_bridge_timeout')).toBe(true)
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('elveszett feladat: getTask null futas kozben -> error, nem vegtelen ciklus', async () => {
    const clock = fakeClock(1000)
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: () => null, now: clock.now, sleep: clock.sleep,
    }))
    expect(evs.some((e) => e.type === 'error' && (e as { code: string }).code === 'code_bridge_lost')).toBe(true)
  })
})
