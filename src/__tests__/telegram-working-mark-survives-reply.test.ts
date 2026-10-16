// #600 (Boss TG 3286): a reply about an earlier task used to delete the "Dolgozom rajta" message of a message that
// arrived mid-turn, so the owner saw no sign of work. The message now stays until the turn ends (Stop hook).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const HOOKS = join(process.cwd(), 'scripts/hooks')
const SID = 'sess-600'
let dir: string
let server: http.Server
let calls: string[]
let base: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wm600-'))
  mkdirSync(join(dir, 'progress'), { recursive: true })
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n')
  writeFileSync(join(dir, 'progress', `${SID}.json`), JSON.stringify([{ chat_id: '42', message_id: 7 }]))
  calls = []
  server = http.createServer((req, res) => {
    calls.push(String(req.url))
    res.setHeader('Content-Type', 'application/json')
    res.end('{"ok":true,"result":true}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

// Async on purpose: spawnSync would block this process's event loop, and the stub server lives in it.
function run(script: string, ev: object): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('python3', ['-I', join(HOOKS, script)], {
      env: { ...process.env, TELEGRAM_STATE_DIR: dir, TELEGRAM_API_BASE: base },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    p.on('close', () => resolve())
    p.stdin.end(JSON.stringify(ev))
  })
}

describe('#600 the "working" message outlives a mid-turn reply', () => {
  it('a reply does not delete it, parks it, and clears the pending record', async () => {
    await run('telegram_progress_reply_clear.py', { tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: { chat_id: '42' }, session_id: SID })
    expect(calls.filter((c) => c.includes('deleteMessage'))).toEqual([])
    expect(existsSync(join(dir, 'progress', `${SID}.json`))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'progress', `${SID}.working`), 'utf8'))).toEqual([{ chat_id: '42', message_id: 7 }])
  })

  it('the Stop hook deletes the parked message at the end of the turn', async () => {
    await run('telegram_progress_reply_clear.py', { tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: { chat_id: '42' }, session_id: SID })
    await run('telegram_progress_clear.py', { session_id: SID, stop_hook_active: false })
    expect(calls.filter((c) => c.includes('deleteMessage')).length).toBe(1)
    expect(existsSync(join(dir, 'progress', `${SID}.working`))).toBe(false)
  })

  it('a reply to another chat leaves this chat\'s pending record and message alone', async () => {
    writeFileSync(join(dir, 'progress', `${SID}.json`), JSON.stringify([{ chat_id: '42', message_id: 7 }, { chat_id: '99', message_id: 8 }]))
    await run('telegram_progress_reply_clear.py', { tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: { chat_id: '42' }, session_id: SID })
    expect(calls).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'progress', `${SID}.json`), 'utf8'))).toEqual([{ chat_id: '99', message_id: 8 }])
    expect(JSON.parse(readFileSync(join(dir, 'progress', `${SID}.working`), 'utf8'))).toEqual([{ chat_id: '42', message_id: 7 }])
  })

  it('a Stop that is blocked (turn keeps working) does not sweep the parked message', async () => {
    writeFileSync(join(dir, 'progress', `${SID}.json`), JSON.stringify([{ chat_id: '42', message_id: 7 }, { chat_id: '99', message_id: 8 }]))
    await run('telegram_progress_reply_clear.py', { tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: { chat_id: '42' }, session_id: SID })
    // chat 99 is still un-replied -> the first Stop is blocked and the agent keeps working
    await run('telegram_progress_clear.py', { session_id: SID, stop_hook_active: false })
    expect(calls.filter((c) => c.includes('deleteMessage'))).toEqual([])
    expect(existsSync(join(dir, 'progress', `${SID}.working`))).toBe(true)
  })

  it('the watchdog deletes a parked message whose Stop hook never ran, but only after an hour', async () => {
    const wpath = join(dir, 'progress', `${SID}.working`)
    writeFileSync(wpath, JSON.stringify([{ chat_id: '42', message_id: 7 }]))
    const watchdog = (): Promise<void> => new Promise((resolve) => {
      const code = `import importlib.util,sys\nspec=importlib.util.spec_from_file_location('wd',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.handle_dir(sys.argv[2])`
      const p = spawn('python3', ['-I', '-c', code, join(HOOKS, 'telegram_progress_watchdog.py'), join(dir, 'progress')], {
        env: { ...process.env, TELEGRAM_API_BASE: base },
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      p.on('close', () => resolve())
    })
    await watchdog()
    expect(calls).toEqual([])
    expect(existsSync(wpath)).toBe(true)
    const old = Date.now() / 1000 - 3700
    utimesSync(wpath, old, old)
    await watchdog()
    expect(calls.filter((c) => c.includes('deleteMessage')).length).toBe(1)
    expect(existsSync(wpath)).toBe(false)
  })
})
