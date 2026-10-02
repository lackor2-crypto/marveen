// #433 (B opcio) a VALODI utvonalkezelon at: a Munkapad chat teljes erteku
// modban a kod-hidra megy. Merve (2026-09-28): a kod-hid eddig CSAK a puszta
// utolso mondatot kapta ("na most meg tudod csinalni?"), a fordulo nem kerult
// a beszelgetesbe, es a "mar fut" zar sem vonatkozott ra. Itt a kod-hid-tarolo
// es a beallitas mockolt: valodi worker es valodi Claude-hivas nelkul.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'

const enqueued: { project: string; prompt: string; origin?: string; chatId?: string | null }[] = []
let workerOnline = true
/** The code project's folder and the WORKBENCH_WINDOWS_BRIDGE setting (Boss, 2026-10-02). */
let codeProjectPath = '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen'
let windowsBridgeSetting = ''
/** Melyik beszelgetesen dolgozik meg egy korabbi kod-hid feladat (a hatterben). */
let bgChatId: string | null = null
const cancelledIds: string[] = []
/** A kod-hid futasanak transzkriptje ezen a gepen (#434: egyenkenti eszkozfutasok). */
let localTranscript: string | null = null
let taskState: { status: string; result: string | null; summary: string | null; error: string | null; startedAt?: number; runSessionId?: string } = { status: 'done', result: 'Kész: végigolvastam. [MINDEN_KESZ]', summary: null, error: null }

vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return { ...actual, getEffectiveSettingValue: (k: string) => (k === 'WORKBENCH_FULL_AGENT' ? '1' : k === 'WORKBENCH_WINDOWS_BRIDGE' ? windowsBridgeSetting : k.startsWith('WORKBENCH_') ? '' : actual.getEffectiveSettingValue(k)) }
})
vi.mock('../web/code-conversation.js', async (orig) => {
  const actual = await orig<typeof import('../web/code-conversation.js')>()
  return { ...actual, locateLocalTranscript: () => localTranscript }
})
vi.mock('../web/code-bridge-store.js', async (orig) => {
  const actual = await orig<typeof import('../web/code-bridge-store.js')>()
  return {
    ...actual,
    resolveProject: () => ({ session: { workspacePath: codeProjectPath } }) as unknown as ReturnType<typeof actual.resolveProject>,
    codeBridgeHealth: () => ({ workerOnline }) as unknown as ReturnType<typeof actual.codeBridgeHealth>,
    enqueueCodeTask: (i: { project: string; prompt: string; origin?: string; chatId?: string | null }) => { enqueued.push({ project: i.project, prompt: i.prompt, origin: i.origin, chatId: i.chatId }); return { task: { id: 'task-1' } } },
    getCodeTask: () => ({ id: 'task-1', ...taskState }),
    cancelCodeTask: (id: string) => { cancelledIds.push(id); return null },
    activeWorkbenchTaskForChat: (chatId: string) => (bgChatId === chatId ? { id: 'bg-1', status: 'running' } : null),
  }
})

import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { resetRunningForTest, claimTurn, releaseTurn, turnKey, isTurnRunning } from '../workbench-agent/orchestrator.js'
import { openSessionForWorkItem, addAgentMessage, listAgentMessages, listToolCalls } from '../workbench-agent/sessions.js'
import { resetWorkbenchAgentForTest } from '../workbench-agent/index.js'
import { setAuditWriterForTest } from '../workbench-agent/audit.js'
import { tryHandleWorkbenchAgent, SSE_PING_MS, setWorkbenchLiveResolverForTest, setWorkbenchLivePoolForTest, resetWorkbenchBridgeLimitForTest, setWorkbenchInflightFileForTest, resumeInterruptedWorkbenchTurns } from '../web/routes/workbench-agent.js'
import { LiveSessionPool, type SavedSession } from '../workbench-agent/live-session.js'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

async function post(path: string, body: unknown): Promise<{ status: number; raw: string }> {
  const out = { status: 200, raw: '' }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    write(chunk: string) { out.raw += chunk; return true },
    end(chunk?: string) { if (chunk) out.raw += chunk },
    on() { return res },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost:3420${path}`)
  await tryHandleWorkbenchAgent({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'session', user: 'teszt' } } as unknown as RouteContext)
  return out
}

async function get(path: string): Promise<any> {
  let raw = ''
  const res: any = {
    writeHead() { return res }, setHeader() { return res }, on() { return res },
    write(c: string) { raw += c; return true }, end(c?: string) { if (c) raw += c },
  }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  await tryHandleWorkbenchAgent({ req, res, path: url.pathname, method: 'GET', url, auth: { kind: 'session', user: 'teszt' } } as unknown as RouteContext)
  return JSON.parse(raw)
}

let projectId = ''
let workItemId = ''

beforeEach(() => {
  initDatabase(':memory:')
  resetRunningForTest()
  resetWorkbenchAgentForTest()
  setAuditWriterForTest(() => { /* nem ir valodi naploba */ })
  // A kod-hid utjat teszteljuk: a helyi allo munkamenet (#434 C) itt nem
  // indulhat -- kulonben egy valodi `claude` folyamat futna a teszt alatt.
  setWorkbenchLiveResolverForTest(() => null)
  enqueued.length = 0
  bgChatId = null
  localTranscript = null
  cancelledIds.length = 0
  workerOnline = true
  resetWorkbenchBridgeLimitForTest()
  taskState = { status: 'done', result: 'Kész: végigolvastam. [MINDEN_KESZ]', summary: null, error: null }
  const p = createProject({ name: 'Iroda fejlesztese' })
  if (!p.ok) throw new Error('projekt')
  projectId = p.project.id
  const w = createWorkItem({ project_id: projectId, title: 'Vélemény az MD-tervről', type: 'document' })
  if (!w.ok) throw new Error('munkadarab')
  workItemId = w.item.id
})

afterEach(() => {
  setWorkbenchLiveResolverForTest(null)
  setWorkbenchLivePoolForTest(null)
  setAuditWriterForTest(null)
  resetWorkbenchAgentForTest()
})

describe('Munkapad chat teljes erteku modban (kod-hid)', () => {
  it('a kod-hid a beszelgetes elozmenyet es a munkadarabot is megkapja, nem csak az utolso mondatot', async () => {
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    addAgentMessage(session.id, 'user', 'Véleményezd az MD-tervet, vitatkozz a ChatGPT-vel.')
    addAgentMessage(session.id, 'assistant', 'A 6-8. fejezetet nem láttam, és a kódba nem látok bele.')

    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'na most meg tudod csinalni?' })
    expect(r.status).toBe(200)
    expect(enqueued).toHaveLength(1)
    const prompt = enqueued[0].prompt
    expect(prompt).toContain('Iroda fejlesztese')
    expect(prompt).toContain('Vélemény az MD-tervről')
    expect(prompt).toContain('OWNER: Véleményezd az MD-tervet')
    expect(prompt).toContain('ASSISTANT: A 6-8. fejezetet nem láttam')
    expect(prompt.trimEnd().endsWith('na most meg tudod csinalni?')).toBe(true)
  })

  it('a kerdes es a valasz a beszelgetesbe kerul (ujratoltes utan is latszik)', async () => {
    await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'olvasd el a tervet' })
    const msgs = listAgentMessages(openSessionForWorkItem(projectId, workItemId, 'hu').id)
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'olvasd el a tervet'],
      ['assistant', 'Kész: végigolvastam.'],
    ])
    expect(isTurnRunning(turnKey(projectId, workItemId))).toBe(false)
  })

  it('#434: a kod-hid egyes parancsai is a Parancsfutasok savba kerulnek, es F5 utan is ott vannak', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-tr-'))
    localTranscript = join(dir, '11111111-2222-3333-4444-555555555555.jsonl')
    const started = Date.parse('2026-09-29T10:00:00Z')
    const row = (ts: string, type: string, content: unknown[]): string => JSON.stringify({ type, timestamp: ts, message: { role: type, content } })
    writeFileSync(localTranscript, [
      row('2026-09-29T08:00:00Z', 'assistant', [{ type: 'tool_use', id: 'x', name: 'Write', input: { file_path: '/elozo-feladat.md' } }]),
      row('2026-09-29T10:00:01Z', 'assistant', [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/p/terv.md' } }]),
      row('2026-09-29T10:00:02Z', 'user', [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }]),
      '',
    ].join('\n'))
    taskState = { ...taskState, startedAt: started, runSessionId: '11111111-2222-3333-4444-555555555555' }
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'olvasd el a tervet' })
    expect(r.raw).toContain('"name":"Read"')
    expect(r.raw).toContain('/p/terv.md')
    expect(r.raw).not.toContain('elozo-feladat')
    const sid = openSessionForWorkItem(projectId, workItemId, 'hu').id
    const saved = listToolCalls(sid).map((c) => [c.tool_name, c.status, c.input_json])
    expect(saved).toContainEqual(['Read', 'ok', '{"detail":"/p/terv.md"}'])
    expect(saved.map((c) => c[0])).toContain('code-bridge')
    expect(saved.map((c) => c[0])).not.toContain('Write')
  })

  it('a hiba valodi oka a chatbe es a naploba is bekerul', async () => {
    taskState = { status: 'error', result: "You've hit your session limit · resets 2:10am (Europe/Budapest)", summary: null, error: 'Claude Code reported an error' }
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'szia' })
    expect(r.raw).toContain('session limit')
    const msgs = listAgentMessages(openSessionForWorkItem(projectId, workItemId, 'hu').id)
    expect(msgs.at(-1)?.role).toBe('system')
    expect(msgs.at(-1)?.content).toContain('session limit')
  })

  it('ugyanaz a "mar fut" zar vonatkozik ra, mint a projekt-asszisztensre', async () => {
    expect(claimTurn(turnKey(projectId, workItemId))).toBe(true)
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'masodik' })
    expect(r.raw).toContain('"code":"busy"')
    expect(enqueued).toHaveLength(0)
    releaseTurn(turnKey(projectId, workItemId))
  })

  // Boss, 2026-09-28: "abba a csetbe kell nekem visszakapnom az uzenetet,
  // ahonnan kerdeztem" -- a Munkapad-feladat SAJAT eredetet kap, hogy a
  // befejezes-ertesito ne kuldje Telegramra (code-bridge-notify.ts).
  it('a feladat "workbench" eredettel megy a kod-hidra (nem "dashboard")', async () => {
    await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'szia' })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].origin).toBe('workbench')
    // A valasz ide megy vissza a feladat lezarasakor (ujrainditas utan is).
    expect(enqueued[0].chatId).toBe(openSessionForWorkItem(projectId, workItemId, 'hu').id)
  })

  // A kod-hidas fordulo percekig csendes; a kozbeeso proxy / bongeszo a tetlen
  // kapcsolatot lezarhatja, es a valasz nem er oda. SSE-megjegyzes tartja eletben.
  it('a csendes kapcsolaton idonkent `: ping` megy, amig a valasz keszul', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      taskState = { status: 'running', result: null, summary: null, error: null }
      const pending = post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'hosszú munka' })
      await vi.advanceTimersByTimeAsync(SSE_PING_MS * 2 + 100)
      taskState = { status: 'done', result: 'Kész a hosszú munka. [MINDEN_KESZ]', summary: null, error: null }
      await vi.advanceTimersByTimeAsync(5000)
      const r = await pending
      expect(r.raw.match(/^: ping$/gm)?.length).toBeGreaterThanOrEqual(2)
      expect(r.raw).toContain('Kész a hosszú munka.')
      // A valasz utan nem megy tobb ping (a zaras utan nem irunk a kapcsolatba).
      expect(r.raw.trimEnd().endsWith('}')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// --- #434 (C opcio): allo, elo munkamenet ---------------------------------
// Valodi gyerekfolyamat, de a `claude` helyett egy apro node-szkript, ami a
// stream-json protokollt beszeli: minden uzenetre streamelt valasz.
const FAKE_CLI = `
let buf = '', n = 0
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    const m = JSON.parse(line); n++
    const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    if (n === 1) w({ type: 'system', subtype: 'init', session_id: 'sess-live', model: 'fake-model' })
    w({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + n, name: 'Read', input: { file_path: '/p/terv.md' } }] } })
    w({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + n }] } })
    w({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'valasz ' + n + ' (' + m.message.content.split('\\n\\nWhen you have finished EVERYTHING')[0].length + ' char) [MINDEN_KESZ]' } } })
    w({ type: 'result', subtype: 'success', result: 'x', session_id: 'sess-live' })
  }
})
`

// Boss, 2026-09-29: "ne mutassa nekem itt hogy kesz ha meg nincs keszen", es
// "ha dolgozik akkor is kellene vennie az uj utasitasokat, csak varakozoba
// kellene tennie". Valos eset: a chat 14,5 perc utan "kesz"-nek mutatta a meg
// futo kod-hid feladatot, a kovetkezo uzenetet pedig a kartya-or elutasitotta.
describe('#434: a hatterben meg dolgozo kod-hid feladat', () => {
  it('a beszelgetes "fut"-nak latszik, amig a feladat nem zarult le', async () => {
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    expect((await get(`/api/workbench/agent/session?workItem=${workItemId}`)).running).toBe(false)
    bgChatId = session.id
    expect((await get(`/api/workbench/agent/session?workItem=${workItemId}`)).running).toBe(true)
  })

  it('az uj uzenet nem indit masodik feladatot es nem hibazik: `busy` -> a felulet sorba allitja', async () => {
    bgChatId = openSessionForWorkItem(projectId, workItemId, 'hu').id
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'és még ezt is' })
    expect(r.raw).toContain('"code":"busy"')
    expect(enqueued).toHaveLength(0)
  })

  it('a Leallitas a hatterben dolgozo feladatot is lezarja', async () => {
    bgChatId = openSessionForWorkItem(projectId, workItemId, 'hu').id
    await post('/api/workbench/agent/stop', { project_id: projectId, work_item_id: workItemId })
    expect(cancelledIds).toEqual(['bg-1'])
  })
})

describe('Munkapad chat teljes erteku modban (allo, elo munkamenet)', () => {
  // Itt nincs online kod-hid: a helyi munkamenet az elso ut.
  beforeEach(() => { workerOnline = false })
  it('ket uzenet EGY folyamatba megy, elo esemenyekkel; az elozmeny csak az elsoben, a valasz a beszelgetesbe kerul', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-live-'))
    const script = join(dir, 'fake-claude.cjs')
    writeFileSync(script, FAKE_CLI)
    let ids: Record<string, SavedSession> = {}
    let spawns = 0
    const pool = new LiveSessionPool({
      spawn: (s) => { spawns++; return spawn(s.bin, s.args, { cwd: s.cwd, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] }) },
      now: () => Date.now(),
      loadIds: () => ids,
      saveIds: (x) => { ids = x },
    })
    setWorkbenchLivePoolForTest(pool)
    setWorkbenchLiveResolverForTest((key) => ({ key, bin: process.execPath, configDir: '/cfg', cwd: dir, env: process.env, baseArgs: [script] }))
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    addAgentMessage(session.id, 'user', 'regi kerdes')
    addAgentMessage(session.id, 'assistant', 'regi valasz')

    const a = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'elso' })
    const b = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'masodik' })
    expect(enqueued).toHaveLength(0) // nem a kod-hidon ment
    expect(spawns).toBe(1)
    expect(a.raw).toContain('"type":"tool","name":"Read","status":"running","detail":"/p/terv.md"')
    expect(a.raw).toContain('"status":"ok"')
    expect(a.raw).toContain('"type":"done","model":"fake-model"')
    // az elso uzenet a teljes kontextust kapta (elozmeny + projekt), a masodik csak a mondatot
    const firstLen = Number(/valasz 1 \((\d+) char\)/.exec(a.raw)?.[1])
    expect(firstLen).toBeGreaterThan(200)
    expect(b.raw).toContain('valasz 2 (7 char)')
    const msgs = listAgentMessages(session.id).map((m) => [m.role, m.content])
    expect(msgs.slice(-4)).toEqual([
      ['user', 'elso'], ['assistant', expect.stringContaining('valasz 1')],
      ['user', 'masodik'], ['assistant', 'valasz 2 (7 char)'],
    ])
    expect(ids[turnKey(projectId, workItemId)]?.sessionId).toBe('sess-live')
    expect(isTurnRunning(turnKey(projectId, workItemId))).toBe(false)
    // #434 (Boss, 2026-09-29): az eszkozfutasok is mentodnek, kulonben F5
    // utan a Parancsfutasok sav ures marad.
    const calls = listToolCalls(session.id).map((c) => [c.tool_name, c.status, c.input_json])
    expect(calls).toEqual([
      ['Read', 'ok', JSON.stringify({ detail: '/p/terv.md' })],
      ['Read', 'ok', JSON.stringify({ detail: '/p/terv.md' })],
    ])
    expect((await get(`/api/workbench/agent/session?workItem=${workItemId}`)).toolCalls).toHaveLength(2)
    pool.stopAll()
  })

  it('#434: automatikus fioknal a limitbe futott fiok helyett a kovetkezo valaszol, a limit-hiba nem jut ki', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-live-lim-'))
    const script = join(dir, 'fake-claude.cjs')
    writeFileSync(script, FAKE_LIMITED_CLI)
    const pool = new LiveSessionPool({
      spawn: (s) => spawn(s.bin, s.args, { cwd: s.cwd, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] }),
      now: () => Date.now(),
      loadIds: () => ({}),
      saveIds: () => {},
    })
    setWorkbenchLivePoolForTest(pool)
    const tried: string[] = []
    setWorkbenchLiveResolverForTest((key, _f, _a, skip) => {
      const d = ['/cfg-dead', '/cfg-ok'].find((c) => !skip?.has(c))
      if (!d) return null
      tried.push(d)
      return { key, bin: process.execPath, configDir: d, cwd: dir, env: { ...process.env, FAKE_CFG: d }, baseArgs: [script] }
    })
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'hello' })
    expect(tried).toEqual(['/cfg-dead', '/cfg-ok'])
    expect(r.raw).toContain('valasz a jo fioktol')
    expect(r.raw).not.toContain('weekly limit')
    expect(r.raw).toContain('"type":"done"')
    pool.stopAll()
  })
})

describe('Boss 2026-10-02: a helyi munkamenet is folytat, amig az EGESZ munka nincs kesz', () => {
  beforeEach(() => { workerOnline = false })
  const run = async (script: string, message: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-live-cont-'))
    const file = join(dir, 'fake-claude.cjs')
    writeFileSync(file, script)
    const pool = new LiveSessionPool({
      spawn: (s) => spawn(s.bin, s.args, { cwd: s.cwd, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] }),
      now: () => Date.now(),
      loadIds: () => ({}),
      saveIds: () => {},
    })
    setWorkbenchLivePoolForTest(pool)
    setWorkbenchLiveResolverForTest((key) => ({ key, bin: process.execPath, configDir: '/cfg', cwd: dir, env: process.env, baseArgs: [file] }))
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message })
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    const msgs = listAgentMessages(session.id).map((m) => [m.role, m.content] as const)
    pool.stopAll()
    return { r, msgs }
  }
  // Round 1: tool + "ami hatravan ... folytatom" WITH the marker (the real case);
  // round 2: tool + a finished answer with the marker.
  const SCRIPT = `
let buf = '', n = 0
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    buf = buf.slice(i + 1); n++
    const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    w({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + n, name: 'Read', input: { file_path: '/p/a' } }] } })
    w({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + n }] } })
    const text = n === 1 ? 'Az elso resz kesz.\\n\\nAmi hatravan: a koltseg-kijelzes. Ezzel folytatom.\\n\\n[MINDEN_KESZ]' : 'Minden elkeszult.\\n\\n[MINDEN_KESZ]'
    w({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
    w({ type: 'result', subtype: 'success', result: 'x' })
  }
})
`
  it('a jel mellett kimondott hatralevo munka nem szamit kesznek: a fordulo folytatodik, a jel nem latszik a chatben', async () => {
    const { r, msgs } = await run(SCRIPT, 'csinald meg az egeszet')
    const assistant = msgs.filter(([role]) => role === 'assistant').map(([, c]) => c)
    expect(assistant).toHaveLength(2)
    expect(assistant[0]).toContain('Ezzel folytatom')
    expect(assistant[1]).toBe('Minden elkeszult.')
    expect(msgs.some(([role, c]) => role === 'system' && c.includes('nincs kész, ezért folytatom'))).toBe(true)
    expect(msgs.every(([, c]) => !c.includes('MINDEN_KESZ'))).toBe(true)
    expect(r.raw).not.toContain('MINDEN_KESZ')
  })

  it('sima kerdes-valasz (nem dolgozott, nincs hatralevo munka) nem indit folytatast', async () => {
    const plain = `
process.stdin.on('data', () => {
  const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  w({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Igen, ez a helyes.' } } })
  w({ type: 'result', subtype: 'success', result: 'x' })
})
`
    const { msgs } = await run(plain, 'jo ez?')
    expect(msgs.filter(([role]) => role === 'assistant')).toHaveLength(1)
    expect(msgs.some(([role, c]) => role === 'system' && c.includes('folytatom'))).toBe(false)
  })

  it('ha a folytatas sem hoz uj munkat, megall es megmondja', async () => {
    const stuck = `
let buf = '', n = 0
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    buf = buf.slice(i + 1); n++
    const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    if (n === 1) { w({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/a' } }] } }); w({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }) }
    w({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ezzel folytatom.' } } })
    w({ type: 'result', subtype: 'success', result: 'x' })
  }
})
`
    const { msgs } = await run(stuck, 'csinald')
    expect(msgs.some(([role, c]) => role === 'system' && c.includes('Nem tudtam tovább haladni'))).toBe(true)
    expect(msgs.filter(([role]) => role === 'assistant').length).toBeLessThanOrEqual(2)
  })
})

const FAKE_LIMITED_CLI = `
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    buf = buf.slice(i + 1)
    const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    if (process.env.FAKE_CFG === '/cfg-dead') {
      w({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your weekly limit \\u00b7 resets Oct 2, 9am (Europe/Budapest)" })
    } else {
      w({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'valasz a jo fioktol' } } })
      w({ type: 'result', subtype: 'success', result: 'x' })
    }
  }
})
`

describe('Boss 2026-10-02: a Windows-meghajtos projekt hidja valaszthato (WORKBENCH_WINDOWS_BRIDGE)', () => {
  const ask = async (setting: string, path: string) => {
    workerOnline = true
    windowsBridgeSetting = setting
    codeProjectPath = path
    enqueued.length = 0
    const dir = mkdtempSync(join(tmpdir(), 'wb-live-win-'))
    const file = join(dir, 'fake-claude.cjs')
    writeFileSync(file, FAKE_CLI)
    const pool = new LiveSessionPool({
      spawn: (s) => spawn(s.bin, s.args, { cwd: s.cwd, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] }),
      now: () => Date.now(), loadIds: () => ({}), saveIds: () => {},
    })
    setWorkbenchLivePoolForTest(pool)
    setWorkbenchLiveResolverForTest((key) => ({ key, bin: process.execPath, configDir: '/cfg', cwd: dir, env: process.env, baseArgs: [file] }))
    try { return await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'hello' }) } finally {
      pool.stopAll(); windowsBridgeSetting = ''; codeProjectPath = '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen'
    }
  }
  it('windows (alap): a Windows-meghajtos projekt a Windows-hidra megy', async () => {
    await ask('', 'f:\\Marveen\\Tozsde')
    expect(enqueued).toHaveLength(1)
  })
  it('marvin: ugyanaz a projekt az elo munkamenetre megy, a legjobb fiokkal, a hidra nem', async () => {
    const r = await ask('marvin', 'f:\\Marveen\\Tozsde')
    expect(enqueued).toHaveLength(0)
    expect(r.raw).toContain('valasz 1')
  })
  it('marvin: a WSL-mappas projekt a Marvin-oldali hidra megy tovabbra is', async () => {
    await ask('marvin', '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen')
    expect(enqueued).toHaveLength(1)
  })
})

describe('#434: online kod-hid az elso, a helyi munkamenet csak tartalek (Boss, 2026-09-28)', () => {
  function livePool(dir: string, onSpawn: () => void): LiveSessionPool {
    const script = join(dir, 'fake-claude.cjs')
    writeFileSync(script, FAKE_CLI)
    const pool = new LiveSessionPool({
      spawn: (s) => { onSpawn(); return spawn(s.bin, s.args, { cwd: s.cwd, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] }) },
      now: () => Date.now(),
      loadIds: () => ({}),
      saveIds: () => {},
    })
    setWorkbenchLivePoolForTest(pool)
    setWorkbenchLiveResolverForTest((key) => ({ key, bin: process.execPath, configDir: '/cfg-other', cwd: dir, env: process.env, baseArgs: [script] }))
    return pool
  }

  it('van online kod-hid ES helyi fiok is -> a kod-hid (VS Code) valaszol', async () => {
    let spawns = 0
    const pool = livePool(mkdtempSync(join(tmpdir(), 'wb-bf-')), () => { spawns++ })
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'hello' })
    expect(enqueued).toHaveLength(1)
    expect(spawns).toBe(0)
    expect(r.raw).toContain('Kész: végigolvastam.')
    pool.stopAll()
  })

  it('a kod-hid fiokja limitbe fut -> ugyanabban a forduloban a helyi munkamenet valaszol, a kerdes egyszer kerul be; a kovetkezo uzenet egyenesen oda megy', async () => {
    taskState = { status: 'done', result: "You've hit your weekly limit \u00b7 resets Oct 2, 9am (Europe/Budapest)", summary: null, error: null }
    let spawns = 0
    const pool = livePool(mkdtempSync(join(tmpdir(), 'wb-bf-lim-')), () => { spawns++ })
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    const a = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'elso' })
    expect(enqueued).toHaveLength(1)
    expect(spawns).toBe(1)
    expect(a.raw).toContain('code_bridge_limit_fallback')
    expect(a.raw).toContain('valasz 1')
    expect(a.raw).not.toContain('weekly limit')
    const users = listAgentMessages(session.id).filter((m) => m.role === 'user').map((m) => m.content)
    expect(users).toEqual(['elso'])
    expect(listAgentMessages(session.id).some((m) => m.role === 'assistant' && /weekly limit/.test(m.content))).toBe(false)
    // az elozmeny nem tartalmazza a mostani kerdest (nem kerul ketszer a promptba)
    const firstLen = Number(/valasz 1 \((\d+) char\)/.exec(a.raw)?.[1])
    expect(firstLen).toBeGreaterThan(0)
    const b = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'masodik' })
    expect(enqueued).toHaveLength(1) // nem ment ujra a kimerult kod-hidra
    expect(b.raw).toContain('valasz 2 (7 char)')
    pool.stopAll()
  })

  it('a kod-hid limit-hibaja (error statusz) is atvalt a helyi munkamenetre', async () => {
    taskState = { status: 'error', result: null, summary: "You've hit your weekly limit", error: 'Claude Code reported an error' }
    const pool = livePool(mkdtempSync(join(tmpdir(), 'wb-bf-err-')), () => {})
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'hello' })
    expect(r.raw).toContain('code_bridge_limit_fallback')
    expect(r.raw).toContain('valasz 1')
    pool.stopAll()
  })

  it('nincs helyi tartalek -> a kod-hid limit-oka latszik (nem nemul el)', async () => {
    taskState = { status: 'done', result: "You've hit your weekly limit", summary: null, error: null }
    const r = await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'hello' })
    expect(r.raw).toContain('"code":"code_bridge_limit"')
    expect(r.raw).toContain('weekly limit')
  })
})

describe('#434: a Marveen ujraindulasa altal felbeszakitott munka magatol folytatodik (Boss TG 1770)', () => {
  let inflight = ''
  function livePool(dir: string, onSpawn: () => void): LiveSessionPool {
    const script = join(dir, 'fake-claude.cjs')
    writeFileSync(script, FAKE_CLI)
    const pool = new LiveSessionPool({
      spawn: (s) => { onSpawn(); return spawn(s.bin, s.args, { cwd: s.cwd, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] }) },
      now: () => Date.now(),
      loadIds: () => ({}),
      saveIds: () => {},
    })
    setWorkbenchLivePoolForTest(pool)
    setWorkbenchLiveResolverForTest((key) => ({ key, bin: process.execPath, configDir: '/cfg', cwd: dir, env: process.env, baseArgs: [script] }))
    return pool
  }
  beforeEach(() => {
    inflight = join(mkdtempSync(join(tmpdir(), 'wb-inflight-')), 'workbench-inflight.json')
    setWorkbenchInflightFileForTest(inflight)
  })
  afterEach(() => { setWorkbenchInflightFileForTest(null) })

  it('egy vegigfutott fordulo nem hagy nyomot (nincs mit folytatni)', async () => {
    workerOnline = false
    const pool = livePool(mkdtempSync(join(tmpdir(), 'wb-rs-')), () => {})
    await post('/api/workbench/agent/message', { project_id: projectId, work_item_id: workItemId, message: 'hello' })
    expect(JSON.parse(readFileSync(inflight, 'utf-8'))).toEqual({})
    pool.stopAll()
  })

  it('az ujrainditas utan megmaradt fordulo magatol folytatodik a helyi munkamenetben; kozben a chat "fut"-nak latszik', async () => {
    let spawns = 0
    const pool = livePool(mkdtempSync(join(tmpdir(), 'wb-rs-')), () => { spawns++ })
    const key = turnKey(projectId, workItemId)
    const session = openSessionForWorkItem(projectId, workItemId, 'hu')
    addAgentMessage(session.id, 'user', 'csinald meg a nagy munkat')
    writeFileSync(inflight, JSON.stringify({ [key]: { projectId, workItemId, lang: 'hu', actor: 'teszt', startedAt: Date.now() - 60_000, resumes: 0 } }))

    // online kod-hid mellett is a helyi munkamenet folytat (ott van a kontextus)
    expect(resumeInterruptedWorkbenchTurns({ delayMs: 60_000 })).toEqual([key])
    expect((await get(`/api/workbench/agent/session?workItem=${workItemId}`)).running).toBe(true)
    setWorkbenchInflightFileForTest(inflight) // a fenti idozitot eldobjuk
    writeFileSync(inflight, JSON.stringify({ [key]: { projectId, workItemId, lang: 'hu', actor: 'teszt', startedAt: Date.now() - 60_000, resumes: 0 } }))
    resumeInterruptedWorkbenchTurns({ delayMs: 0 })
    for (let i = 0; i < 200 && (await get(`/api/workbench/agent/session?workItem=${workItemId}`)).running; i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect((await get(`/api/workbench/agent/session?workItem=${workItemId}`)).running).toBe(false)
    expect(enqueued).toHaveLength(0)
    expect(spawns).toBe(1)
    const msgs = listAgentMessages(session.id).map((m) => [m.role, m.content])
    expect(msgs.slice(-3)).toEqual([
      ['user', 'csinald meg a nagy munkat'],
      ['system', expect.stringContaining('Folytasd a félbeszakadt munkát')],
      ['assistant', expect.stringContaining('valasz 1')],
    ])
    expect(JSON.parse(readFileSync(inflight, 'utf-8'))).toEqual({})
    pool.stopAll()
  })

  it('a tul regi vagy mar ketszer folytatott fordulot nem inditja ujra (nincs vegtelen kor)', () => {
    const now = Date.now()
    writeFileSync(inflight, JSON.stringify({
      a: { projectId, workItemId, lang: 'hu', actor: 'teszt', startedAt: now - 3 * 60 * 60 * 1000, resumes: 0 },
      b: { projectId, workItemId, lang: 'hu', actor: 'teszt', startedAt: now, resumes: 2 },
    }))
    const ran: string[] = []
    expect(resumeInterruptedWorkbenchTurns({ now, delayMs: 0, run: async (k) => { ran.push(k) } })).toEqual([])
    expect(ran).toEqual([])
    expect(JSON.parse(readFileSync(inflight, 'utf-8'))).toEqual({})
  })
})
