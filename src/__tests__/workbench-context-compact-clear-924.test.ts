// #924: the assistant chat header has "Compact" (to a wished size in thousand tokens, the last value remembered) and "Clear".
// The pool part is RUN with a fake process that speaks the stream-json the real CLI spoke when measured (2026-11-16:
// `/compact <text>` in a standing session answers with a compact_boundary {pre_tokens, post_tokens} and one result).
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { LiveSessionPool, type LiveSpawnSpec, type SavedSession, type LiveStartSpec } from '../workbench-agent/live-session.js'
import { sinceContextClear, CONTEXT_CLEARED_MARK, isContextMark } from '../workbench-agent/sessions.js'

const L = (o: unknown): string => JSON.stringify(o)
const root = join(__dirname, '..', '..')

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  received: string[] = []
  killed = false
  constructor(public spec: LiveSpawnSpec, script: (c: FakeChild, m: any) => void) {
    super()
    let buf = ''
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); this.received.push(line); script(this, JSON.parse(line)) }
    })
  }
  out(o: unknown): void { this.stdout.write(L(o) + '\n') }
  kill(): boolean { this.killed = true; setImmediate(() => this.emit('close', null)); return true }
}

const compactScript = (c: FakeChild, m: any): void => {
  const text = String(m.message.content)
  setImmediate(() => {
    if (text.startsWith('/compact')) {
      c.out({ type: 'system', subtype: 'status' })
      c.out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 16390, post_tokens: 3474 } })
      c.out({ type: 'result', subtype: 'success', result: '', session_id: 'sid-c' })
    } else {
      c.out({ type: 'system', subtype: 'init', session_id: 'sid-c', model: 'm' })
      c.out({ type: 'result', subtype: 'success', result: 'ok', session_id: 'sid-c' })
    }
  })
}

function harness(initial: Record<string, SavedSession> = {}) {
  const spawned: FakeChild[] = []
  let ids = initial
  const pool = new LiveSessionPool({
    spawn: (spec) => { const c = new FakeChild(spec, compactScript); spawned.push(c); return c as unknown as ChildProcess },
    now: () => Date.now(),
    loadIds: () => ids,
    saveIds: (x) => { ids = JSON.parse(JSON.stringify(x)) },
  })
  return { pool, spawned, ids: () => ids }
}
const spec = (over: Partial<LiveStartSpec> = {}): LiveStartSpec => ({
  key: 'k1', bin: 'claude', configDir: '/cfg', cwd: '/p', env: {}, baseArgs: ['-p'], ...over,
})
const saved: Record<string, SavedSession> = { k1: { sessionId: 'sid-c', configDir: '/cfg', cwd: '/p' } }

describe('Compact in the standing session (#924)', () => {
  it('resumes the saved session, sends /compact with the wish, and reports the measured sizes', async () => {
    const h = harness(saved)
    const r = await h.pool.compact(spec(), 'Summarize in at most 20 thousand tokens.')
    expect(r).toEqual({ ok: true, pre: 16390, post: 3474 })
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].spec.args).toContain('--resume')
    expect(JSON.parse(h.spawned[0].received[0]).message.content).toBe('/compact Summarize in at most 20 thousand tokens.')
  })

  it('says "nothing to compact" when no session with a context exists (no empty process is left running)', async () => {
    const h = harness({})
    expect(await h.pool.compact(spec(), 'x')).toEqual({ ok: false, code: 'nothing' })
    expect(h.spawned.every((c) => c.killed) || h.spawned.length === 0).toBe(true)
  })

  it('refuses while a turn is running in that session', async () => {
    const h = harness(saved)
    let release: () => void = () => {}
    const slow = new LiveSessionPool({
      spawn: (s) => { const c = new FakeChild(s, () => { /* never answers: the turn stays open */ }); h.spawned.push(c); return c as unknown as ChildProcess },
      now: () => Date.now(), loadIds: () => saved, saveIds: () => {},
    })
    const it = slow.turn(spec(), () => 'hello', 'hu')[Symbol.asyncIterator]()
    const first = it.next()
    await new Promise((r) => setTimeout(r, 20))
    expect(await slow.compact(spec(), 'x')).toEqual({ ok: false, code: 'busy' })
    release()
    void first
  })
})

describe('Clear (#924)', () => {
  it('reset() stops the process AND forgets the saved session, so the next message starts empty', async () => {
    const h = harness(saved)
    await h.pool.compact(spec(), 'x')
    expect(h.pool.has('k1')).toBe(true)
    expect(h.pool.reset('k1')).toBe(true)
    expect(h.pool.has('k1')).toBe(false)
    expect(h.ids()).toEqual({})
    expect(h.pool.reset('k1')).toBe(false)
  })

  it('what the model is told starts after the last "cleared" marker; the marker rows are recognised', () => {
    const rows = [
      { role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' },
      { role: 'system', content: CONTEXT_CLEARED_MARK },
      { role: 'user', content: 'new question' },
    ]
    expect(sinceContextClear(rows).map((r) => r.content)).toEqual(['new question'])
    expect(sinceContextClear(rows.slice(0, 2))).toHaveLength(2)
    expect(isContextMark(CONTEXT_CLEARED_MARK)).toBe(true)
    expect(isContextMark('[[context:compacted:16390:3474:20]]')).toBe(true)
    expect(isContextMark('normal text')).toBe(false)
  })
})

describe('the screen and the wiring (#924)', () => {
  const js = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')
  const route = readFileSync(join(root, 'src', 'web', 'routes', 'workbench-agent.ts'), 'utf8')
  const hu = readFileSync(join(root, 'web', 'lang', 'hu.js'), 'utf8')
  const en = readFileSync(join(root, 'web', 'lang', 'en.js'), 'utf8')

  it('the header carries the two buttons and a number field whose last value is remembered', () => {
    expect(js).toContain('data-wb-act="chat-ctx-compact"')
    expect(js).toContain('data-wb-act="chat-ctx-clear"')
    expect(js).toContain('id="wbChatCtxMax"')
    expect(js).toContain("var CTX_MAX_KEY = 'marveen.workbench.ctxMaxK'")
    expect(js).toContain('writePref(CTX_MAX_KEY, WB.chatCtxMax)')
    expect(js).toMatch(/window\.confirm\(t\('workbench\.ctx\.clear_confirm'\)\)/)
  })

  it('every new text exists in Hungarian AND English', () => {
    const keys = [...new Set([...js.matchAll(/'(workbench\.ctx\.[a-z_]+)'/g)].map((m) => m[1]))]
    expect(keys.length).toBeGreaterThan(10)
    for (const k of keys) { expect(hu, k).toContain(`"${k}"`); expect(en, k).toContain(`"${k}"`) }
  })

  it('the server takes the turn lock, and every place that builds the model history uses the cleared view', () => {
    expect(route).toContain("'/api/workbench/agent/context-clear'")
    expect(route).toContain("'/api/workbench/agent/context-compact'")
    expect(route).toMatch(/claimTurn\(key\)\) return fail\(res, 409, 'context_busy'/)
    expect(route.match(/listContextMessages\(session\.id\)/g)?.length).toBe(2)
    const orch = readFileSync(join(root, 'src', 'workbench-agent', 'orchestrator.ts'), 'utf8')
    expect(orch).toContain('historyMessages(listContextMessages(session.id))')
  })
})
