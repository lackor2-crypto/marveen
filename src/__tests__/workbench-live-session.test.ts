import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import {
  mapStreamLine, newStreamState, toolDetail, LiveSessionPool, guardSettingsJson,
  type LiveSpawnSpec, type SavedSession, type LiveStartSpec,
} from '../workbench-agent/live-session.js'
import type { OrchestratorEvent } from '../workbench-agent/orchestrator.js'
import { decideWorkbenchBackend } from '../workbench-agent/backend-router.js'

const L = (o: unknown): string => JSON.stringify(o)

describe('mapStreamLine -- stream-json -> chat events', () => {
  it('streams text deltas and takes the session id / model from init', () => {
    const st = newStreamState()
    expect(mapStreamLine(L({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x' }), st).events).toEqual([])
    expect(st.sessionId).toBe('s1')
    const r = mapStreamLine(L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Szia' } } }), st)
    expect(r.events).toEqual([{ type: 'text', text: 'Szia' }])
  })

  it('does NOT repeat the text of the full assistant message (no doubled answer)', () => {
    const st = newStreamState()
    const r = mapStreamLine(L({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'Szia' }] } }), st)
    expect(r.events).toEqual([])
  })

  it('separates text blocks around tool calls with a paragraph break', () => {
    const st = newStreamState()
    mapStreamLine(L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } } }), st)
    const r = mapStreamLine(L({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }), st)
    expect(r.events).toEqual([{ type: 'text', text: '\n\n' }])
  })

  it('maps tool_use -> running and tool_result -> ok/error by id', () => {
    const st = newStreamState()
    const a = mapStreamLine(L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/a.md' } }] } }), st)
    expect(a.events).toEqual([{ type: 'tool', name: 'Read', status: 'running', detail: '/x/a.md' }])
    const b = mapStreamLine(L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }), st)
    expect(b.events).toEqual([{ type: 'tool', name: 'Read', status: 'error' }])
    // unknown id: nothing (never a guessed tool name)
    expect(mapStreamLine(L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'zz' }] } }), st).events).toEqual([])
  })

  it('ends the turn on result; an error result carries the CLI own words', () => {
    const st = newStreamState()
    expect(mapStreamLine(L({ type: 'result', subtype: 'success', result: 'x', session_id: 's2' }), st).end).toEqual({ ok: true })
    expect(st.sessionId).toBe('s2')
    const e = mapStreamLine(L({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit" }), newStreamState())
    expect(e.end).toEqual({ ok: false, detail: "You've hit your limit" })
  })

  it('falls back to the final result text when nothing streamed', () => {
    const st = newStreamState()
    expect(mapStreamLine(L({ type: 'result', subtype: 'success', result: 'kesz' }), st).events).toEqual([{ type: 'text', text: 'kesz' }])
  })

  it('ignores garbage and blank lines', () => {
    expect(mapStreamLine('not json', newStreamState()).events).toEqual([])
    expect(mapStreamLine('   ', newStreamState()).events).toEqual([])
  })

  it('toolDetail names what the tool touches, shortened', () => {
    expect(toolDetail('Bash', { command: 'npm test', description: 'Run tests' })).toBe('Run tests')
    expect(toolDetail('Grep', { pattern: 'foo' })).toBe('foo')
    expect(toolDetail('Bash', { command: 'x'.repeat(300) }).length).toBe(140)
  })
})

// --- a fake `claude` process ------------------------------------------------

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  received: string[] = []
  constructor(public spec: LiveSpawnSpec, script: (c: FakeChild, msg: any) => void) {
    super()
    let buf = ''
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        this.received.push(line)
        script(this, JSON.parse(line))
      }
    })
  }
  out(o: unknown): void { this.stdout.write(L(o) + '\n') }
  kill(): boolean { this.killed = true; setImmediate(() => this.emit('close', null)); return true }
}

/** Answers every user message with "echo:<n>" in the same session. */
const echoScript = (sid: string) => (c: FakeChild, m: any): void => {
  const n = c.received.length
  setImmediate(() => {
    if (n === 1) c.out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-test' })
    c.out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `echo:${n}:${String(m.message.content).slice(0, 40)}` } } })
    c.out({ type: 'result', subtype: 'success', result: 'x', session_id: sid })
  })
}

function harness(script: (spec: LiveSpawnSpec) => (c: FakeChild, m: any) => void) {
  const spawned: FakeChild[] = []
  let ids: Record<string, SavedSession> = {}
  const pool = new LiveSessionPool({
    spawn: (spec) => { const c = new FakeChild(spec, script(spec)); spawned.push(c); return c as unknown as ChildProcess },
    now: () => Date.now(),
    loadIds: () => ids,
    saveIds: (x) => { ids = JSON.parse(JSON.stringify(x)) },
  })
  return { pool, spawned, ids: () => ids, setIds: (x: Record<string, SavedSession>) => { ids = x } }
}

const spec = (over: Partial<LiveStartSpec> = {}): LiveStartSpec => ({
  key: 'p1::', bin: 'claude', configDir: '/cfg/a', cwd: '/proj', env: {}, baseArgs: ['-p', '--input-format', 'stream-json'], ...over,
})

async function collect(it: AsyncIterable<OrchestratorEvent>): Promise<OrchestratorEvent[]> {
  const out: OrchestratorEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('LiveSessionPool -- one standing process per conversation', () => {
  it('two turns go into the SAME process; only the first carries the history prompt', async () => {
    const h = harness(() => echoScript('sid-1'))
    const prompts: boolean[] = []
    const build = (fresh: boolean): string => { prompts.push(fresh); return fresh ? 'HISTORY+hello' : 'second' }
    const a = await collect(h.pool.turn(spec(), build, 'hu'))
    const b = await collect(h.pool.turn(spec(), build, 'hu'))
    expect(h.spawned).toHaveLength(1)
    expect(prompts).toEqual([true, false])
    expect(a).toEqual([{ type: 'text', text: 'echo:1:HISTORY+hello' }, { type: 'done', model: 'claude-test', via: null }])
    expect(b[0]).toEqual({ type: 'text', text: 'echo:2:second' })
    // the session id is kept for a later resume
    expect(h.ids()['p1::']).toEqual({ sessionId: 'sid-1', configDir: '/cfg/a', cwd: '/proj' })
  })

  it('after the process is gone the next turn RESUMES the saved session without re-sending history', async () => {
    const h = harness(() => echoScript('sid-9'))
    h.setIds({ 'p1::': { sessionId: 'sid-9', configDir: '/cfg/a', cwd: '/proj' } })
    const fresh: boolean[] = []
    await collect(h.pool.turn(spec(), (f) => { fresh.push(f); return 'm' }, 'hu'))
    expect(h.spawned[0].spec.args).toContain('--resume')
    expect(h.spawned[0].spec.args).toContain('sid-9')
    expect(fresh).toEqual([false])
  })

  it('a saved session of ANOTHER account/folder is not resumed (the CLI could not find it)', async () => {
    const h = harness(() => echoScript('sid-2'))
    h.setIds({ 'p1::': { sessionId: 'old', configDir: '/cfg/OTHER', cwd: '/proj' } })
    await collect(h.pool.turn(spec(), () => 'm', 'hu'))
    expect(h.spawned[0].spec.args).not.toContain('--resume')
  })

  it('a resumed process that dies before answering is restarted ONCE, fresh, with history', async () => {
    let n = 0
    const h = harness(() => {
      n++
      if (n === 1) return (c) => { setImmediate(() => { c.stderr.write('No conversation found'); c.emit('close', 1) }) }
      return echoScript('sid-new')
    })
    h.setIds({ 'p1::': { sessionId: 'stale', configDir: '/cfg/a', cwd: '/proj' } })
    const fresh: boolean[] = []
    const ev = await collect(h.pool.turn(spec(), (f) => { fresh.push(f); return f ? 'HIST' : 'm' }, 'hu'))
    expect(h.spawned).toHaveLength(2)
    expect(h.spawned[1].spec.args).not.toContain('--resume')
    expect(fresh).toEqual([false, true])
    expect(ev.at(-1)).toMatchObject({ type: 'done' })
  })

  it('a fresh process that dies reports the real stderr, never a guess', async () => {
    const h = harness(() => (c) => { setImmediate(() => { c.stderr.write('Invalid API key'); c.emit('close', 1) }) })
    const ev = await collect(h.pool.turn(spec(), () => 'm', 'en'))
    expect(h.spawned).toHaveLength(1)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ type: 'error', code: 'live_failed' })
    expect((ev[0] as { message: string }).message).toContain('Invalid API key')
  })

  it('an error result is shown with the CLI own words and the process stays for the next turn', async () => {
    const h = harness(() => (c) => { setImmediate(() => c.out({ type: 'result', is_error: true, subtype: 'success', result: 'limit reached' })) })
    const ev = await collect(h.pool.turn(spec(), () => 'm', 'en'))
    expect((ev.at(-1) as { message: string }).message).toContain('limit reached')
    expect(h.pool.has('p1::')).toBe(true)
  })

  it('abort (Stop button) kills the process and ends the turn silently', async () => {
    const h = harness(() => () => { /* never answers */ })
    const ac = new AbortController()
    const p = collect(h.pool.turn(spec(), () => 'm', 'hu', ac.signal))
    await new Promise((r) => setImmediate(r))
    ac.abort()
    expect(await p).toEqual([])
    expect(h.spawned[0].killed).toBe(true)
    expect(h.pool.has('p1::')).toBe(false)
  })

  it('stop() ends the standing process', async () => {
    const h = harness(() => echoScript('s'))
    await collect(h.pool.turn(spec(), () => 'm', 'hu'))
    expect(h.pool.stop('p1::')).toBe(true)
    expect(h.spawned[0].killed).toBe(true)
    expect(h.pool.stop('p1::')).toBe(false)
  })
})

describe('guardSettingsJson -- only the fleet guard hooks, never the channel hooks', () => {
  it('keeps PreToolUse guards with the install path and drops Stop/UserPromptSubmit/PostToolUse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-guard-'))
    const tpl = join(dir, 't.json')
    writeFileSync(tpl, L({
      permissions: { defaultMode: 'bypassPermissions' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/no-live-tree-commit.py' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'channel-inbox-stop-drain.py' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'channel-inbox-drain.py' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'ledger-outbound.py' }] }],
      },
      enabledPlugins: { 'telegram@x': true },
    }))
    const g = JSON.parse(guardSettingsJson(tpl, '/inst'))
    expect(Object.keys(g.hooks)).toEqual(['PreToolUse'])
    expect(g.hooks.PreToolUse[0].hooks[0].command).toBe('python3 /inst/scripts/hooks/no-live-tree-commit.py')
    expect(g.enabledPlugins).toBeUndefined()
    expect(g.permissions).toEqual({ defaultMode: 'bypassPermissions' })
  })

  it('the real template gives the guards and no channel hook at all', () => {
    const g = guardSettingsJson(join(process.cwd(), 'templates', 'settings.json.template'), '/inst')
    expect(g).toContain('no-live-tree-commit.py')
    expect(g).toContain('free-agent-read-only.py')
    expect(g).not.toMatch(/inbox|telegram_progress|ledger-outbound|{{/)
    expect(readFileSync(join(process.cwd(), 'templates', 'settings.json.template'), 'utf-8')).toContain('channel-inbox-drain')
  })
})

describe('decideWorkbenchBackend -- the live session comes first in full mode', () => {
  it('full mode + local CLI/account -> live-session, even without a worker', () => {
    expect(decideWorkbenchBackend({ fullAgentEnabled: true, workerOnline: false, liveAvailable: true }).backend).toBe('live-session')
  })
  it('full mode without local CLI falls back to the code bridge / assistant as before', () => {
    expect(decideWorkbenchBackend({ fullAgentEnabled: true, workerOnline: true, liveAvailable: false }).backend).toBe('code-bridge')
    expect(decideWorkbenchBackend({ fullAgentEnabled: true, workerOnline: false }).backend).toBe('workbench-agent')
  })
  it('bridgeFirst (auto account, bridge not limited) -> an online code bridge beats the live session', () => {
    expect(decideWorkbenchBackend({ fullAgentEnabled: true, workerOnline: true, liveAvailable: true, bridgeFirst: true }).backend).toBe('code-bridge')
    expect(decideWorkbenchBackend({ fullAgentEnabled: true, workerOnline: true, liveAvailable: true, bridgeFirst: false }).backend).toBe('live-session')
    expect(decideWorkbenchBackend({ fullAgentEnabled: true, workerOnline: false, liveAvailable: true, bridgeFirst: true }).backend).toBe('live-session')
  })
  it('switch off -> the project assistant, whatever is available', () => {
    expect(decideWorkbenchBackend({ fullAgentEnabled: false, workerOnline: true, liveAvailable: true }).backend).toBe('workbench-agent')
  })
})
