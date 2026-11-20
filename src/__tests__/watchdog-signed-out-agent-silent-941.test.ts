// #941: the Telegram progress sentry sent "Valami elakadt, és erre nem érkezett válasz" in the name of an agent
// whose Claude account is signed out (out of use, nobody waits for it). It must stay silent for such an agent
// and only clean up its placeholder; a signed-in agent keeps the old behaviour.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const HOOKS = join(process.cwd(), 'scripts/hooks')
let root: string
let progress: string
let marker: string
let server: http.Server
let calls: string[]
let base: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wd941-'))
  const tg = join(root, 'agents', 'helper', '.claude', 'channels', 'telegram')
  progress = join(tg, 'progress')
  mkdirSync(progress, { recursive: true })
  writeFileSync(join(tg, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n')
  writeFileSync(join(root, 'agents', 'helper', 'agent-config.json'), JSON.stringify({ claudePlan: 'helperplan' }))
  mkdirSync(join(root, 'store', 'accounts', 'helperplan'), { recursive: true })
  marker = join(progress, 'sess-941.json')
  writeFileSync(marker, JSON.stringify([{ chat_id: '42', message_id: 7 }]))
  const old = Date.now() / 1000 - 1000
  utimesSync(marker, old, old)
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
  rmSync(root, { recursive: true, force: true })
})

function runWatchdog(): Promise<void> {
  return new Promise((resolve) => {
    const code = `import importlib.util,sys\nspec=importlib.util.spec_from_file_location('wd',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.handle_dir(sys.argv[2])\n`
    const p = spawn('python3', ['-I', '-c', code, join(HOOKS, 'telegram_progress_watchdog.py'), progress], {
      env: { ...process.env, MARVEEN_ROOT: root, TELEGRAM_API_BASE: base },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    p.on('close', () => resolve())
  })
}

describe('#941 progress sentry and a signed-out agent', () => {
  it('a signed-out agent (account without .credentials.json) gets NO error message, only a silent cleanup', async () => {
    await runWatchdog()
    expect(calls.filter((c) => c.includes('editMessageText') || c.includes('sendMessage'))).toEqual([])
    expect(calls.filter((c) => c.includes('deleteMessage')).length).toBe(1)
    expect(existsSync(marker)).toBe(false)
  })

  it('a signed-in agent still gets the generic error on its stuck round (behaviour unchanged)', async () => {
    writeFileSync(join(root, 'store', 'accounts', 'helperplan', '.credentials.json'), '{}')
    await runWatchdog()
    expect(calls.filter((c) => c.includes('editMessageText') || c.includes('sendMessage')).length).toBe(1)
  })
})
