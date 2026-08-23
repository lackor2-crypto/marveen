import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { buildTelegramMcpServerConfig } from '../web/agent-process.js'
import { PROJECT_ROOT } from '../config.js'

const WRAPPER = join(PROJECT_ROOT, 'scripts', 'channel-inbound-tee.mjs')

function runWrapper(stateDir: string, childCode: string, extraEnv: Record<string, string> = {}): Promise<{ stdout: string, stderr: string, code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER, process.execPath, '-e', childCode], {
      env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ stdout, stderr, code }))
    // MCP-contract: the parent owns the wrapper's stdin; close it so the
    // wrapper can exit once its child is done (mirrors a client disconnect).
    child.stdin.end()
  })
}

describe('channel-inbound-tee', () => {
  it('passes stdout through byte-for-byte and tees split channel notifications to the inbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-inbound-tee-'))
    try {
      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: 'hello',
          meta: { chat_id: 'c1', message_id: 'm1', user: 'u1', ts: '123' },
        },
      })
      const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })
      const nonJson = 'not json'
      const expected = notification + '\n' + response + '\n' + nonJson + '\n'
      const childCode = `
        const fs = require('node:fs');
        const notification = ${JSON.stringify(notification)};
        const response = ${JSON.stringify(response)};
        fs.writeSync(1, notification.slice(0, 35));
        setTimeout(() => {
          fs.writeSync(1, notification.slice(35) + '\\n');
          fs.writeSync(1, response + '\\n');
          fs.writeSync(1, ${JSON.stringify(nonJson + '\n')});
        }, 10);
      `

      const result = await runWrapper(dir, childCode)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(expected)

      const inbox = readFileSync(join(dir, 'inbox-pending.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(inbox).toHaveLength(1)
      expect(inbox[0].receivedAt).toEqual(expect.any(Number))
      expect(inbox[0].params).toEqual({
        content: 'hello',
        meta: { chat_id: 'c1', message_id: 'm1', user: 'u1', ts: '123' },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Boss, 2026-08-23: "A Telegram felhasznalo nem tudja, hogy most, amit irt
// neked, az te vetted az adast, vagy nem vetted az adast." A sub-agent's
// inbound message never reaches a UserPromptSubmit hook, so the "Dolgozom
// rajta" placeholder hook never fires for it -- this relay is the only place
// that sees the message at arrival, whether the session is idle, mid-turn or
// asleep. These pin the receipt so a later edit cannot make sub-agents silent
// again.
function stubTelegram(): Promise<{ base: string, calls: Array<{ path: string, body: any }>, close: () => Promise<void> }> {
  const calls: Array<{ path: string, body: any }> = []
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        calls.push({ path: req.url || '', body: raw ? JSON.parse(raw) : null })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: { message_id: 4242 } }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        base: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function notificationLine(meta: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: { content: 'szia', meta },
  })
}

describe('channel-inbound-tee arrival receipt', () => {
  it('tells the sender the message was received, and records it for the turn to take over', async () => {
    const stub = await stubTelegram()
    const dir = mkdtempSync(join(tmpdir(), 'channel-inbound-tee-ack-'))
    try {
      writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n')
      const line = notificationLine({ chat_id: 'c1', message_id: 'm1', user: 'u1' })
      const childCode = `
        const fs = require('node:fs');
        fs.writeSync(1, ${JSON.stringify(line + '\n')});
      `
      const result = await runWrapper(dir, childCode, { TELEGRAM_API_BASE: stub.base })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')

      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0].path).toBe('/bot123:abc/sendMessage')
      expect(stub.calls[0].body.chat_id).toBe('c1')
      // Honest at this instant: the message is queued, not being worked on.
      // channel-inbox-drain.py edits it to the working text when a turn starts.
      expect(String(stub.calls[0].body.text)).toContain('Megkaptam')
      // The receipt itself must not buzz the phone -- the answer does.
      expect(stub.calls[0].body.disable_notification).toBe(true)

      const arrivals = readFileSync(join(dir, 'progress', 'arrival.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l))
      expect(arrivals).toEqual([
        expect.objectContaining({ chat_id: 'c1', message_id: 4242, src_message_id: 'm1' }),
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await stub.close()
    }
  })

  it('receipts each inbound message once, even if the same notification is seen twice', async () => {
    const stub = await stubTelegram()
    const dir = mkdtempSync(join(tmpdir(), 'channel-inbound-tee-ack-dup-'))
    try {
      writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n')
      const same = notificationLine({ chat_id: 'c1', message_id: 'm1' })
      const other = notificationLine({ chat_id: 'c1', message_id: 'm2' })
      const childCode = `
        const fs = require('node:fs');
        fs.writeSync(1, ${JSON.stringify(same + '\n' + same + '\n' + other + '\n')});
      `
      const result = await runWrapper(dir, childCode, { TELEGRAM_API_BASE: stub.base })
      expect(result.code).toBe(0)
      expect(stub.calls.map((c) => c.body.chat_id)).toEqual(['c1', 'c1'])
      const arrivals = readFileSync(join(dir, 'progress', 'arrival.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l))
      expect(arrivals.map((a) => a.src_message_id)).toEqual(['m1', 'm2'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await stub.close()
    }
  })

  it('stays silent, and never guesses a token, when the install has none configured', async () => {
    const stub = await stubTelegram()
    const dir = mkdtempSync(join(tmpdir(), 'channel-inbound-tee-ack-notoken-'))
    try {
      const line = notificationLine({ chat_id: 'c1', message_id: 'm1' })
      const childCode = `
        const fs = require('node:fs');
        fs.writeSync(1, ${JSON.stringify(line + '\n')});
      `
      const result = await runWrapper(dir, childCode, { TELEGRAM_API_BASE: stub.base })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(stub.calls).toEqual([])
      // Delivery itself is untouched: the message still reaches the agent.
      expect(readFileSync(join(dir, 'inbox-pending.jsonl'), 'utf8')).toContain('c1')
      expect(existsSync(join(dir, 'progress', 'arrival.jsonl'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await stub.close()
    }
  })
})

describe('buildTelegramMcpServerConfig', () => {
  it('routes the per-agent telegram MCP server through the inbound tee wrapper', () => {
    const cfg = buildTelegramMcpServerConfig('/home/me/.bun/bin/bun', '/plugins/telegram/0.0.6', '/agents/nova/.claude/channels/telegram')
    expect(cfg.command).toBe('node')
    expect(cfg.args).toEqual([
      join(PROJECT_ROOT, 'scripts', 'channel-inbound-tee.mjs'),
      '/home/me/.bun/bin/bun',
      'run',
      '--cwd',
      '/plugins/telegram/0.0.6',
      '--shell=bun',
      '--silent',
      'start',
    ])
    expect(cfg.env).toEqual({ TELEGRAM_STATE_DIR: '/agents/nova/.claude/channels/telegram' })
  })
})
