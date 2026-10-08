// #498 -- a Telegramrol inditott, futo feladat reszleges valasza Telegramra megy.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sent: { chatId: string; text: string }[] = []

vi.mock('../web/telegram.js', async (orig) => {
  const actual = await orig<typeof import('../web/telegram.js')>()
  return { ...actual, sendTelegramMessage: async (_token: string, chatId: string, text: string) => { sent.push({ chatId, text }) } }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, CODE_BOT_TOKEN: 'code-bot-token', TELEGRAM_BOT_TOKEN: 'main-bot-token' }
})
vi.mock('../owner-chat.js', async (orig) => {
  const actual = await orig<typeof import('../owner-chat.js')>()
  return { ...actual, resolveOwnerChatId: () => '424242' }
})

import { initDatabase } from '../db.js'
import { notifyCodeTaskPartial } from '../web/code-bridge-notify.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask, type CodeTask,
} from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'

function task(over: Partial<CodeTask> = {}): CodeTask {
  return {
    id: 'abcdef0123456789',
    project: 'marveen',
    prompt: 'olvasd el a tervet',
    status: 'done',
    origin: 'dashboard',
    requestedBy: null,
    chatId: null,
    sessionId: null,
    targetSessionId: null,
    workspacePath: null,
    host: null,
    result: 'A TELJES VÉLEMÉNY',
    summary: null,
    error: null,
    costUsd: null,
    durationMs: null,
    numTurns: null,
    attempts: 1,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    leaseExpiresAt: null,
    cardRef: null,
    ...over,
  } as CodeTask
}


beforeEach(() => { initDatabase(':memory:'); sent.length = 0 })

describe('notifyCodeTaskPartial', () => {
  it('sends the new text of a running telegram task to its chat', async () => {
    expect(await notifyCodeTaskPartial(task({ status: 'running', origin: 'telegram', chatId: '777' }), '  hello  ')).toBe(true)
    expect(sent).toEqual([{ chatId: '777', text: 'hello' }])
  })
  it('falls back to the owner chat when the task has none', async () => {
    await notifyCodeTaskPartial(task({ status: 'running', origin: 'telegram', chatId: null }), 'x')
    expect(sent[0]?.chatId).toBe('424242')
  })
  it('chunks a long text instead of cutting it', async () => {
    await notifyCodeTaskPartial(task({ status: 'running', origin: 'telegram' }), ('a'.repeat(100) + '\n').repeat(120))
    expect(sent.length).toBeGreaterThan(1)
  })
  it('stays silent for non-telegram origins, finished tasks and empty text', async () => {
    expect(await notifyCodeTaskPartial(task({ status: 'running', origin: 'workbench' }), 'x')).toBe(false)
    expect(await notifyCodeTaskPartial(task({ status: 'running', origin: 'dashboard' }), 'x')).toBe(false)
    expect(await notifyCodeTaskPartial(task({ status: 'done', origin: 'telegram' }), 'x')).toBe(false)
    expect(await notifyCodeTaskPartial(task({ status: 'running', origin: 'telegram' }), '   ')).toBe(false)
    expect(sent).toEqual([])
  })
})

// A vegpont (POST /api/code/tasks/<id>/partial), amit a worker hiv.
async function call(path: string, body: unknown, remoteAddress = '127.0.0.1'): Promise<{ status: number; body: any }> {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
  req.socket = { remoteAddress }
  req.headers = { 'content-type': 'application/json' }
  const out = { status: 0, body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: unknown) { if (chunk) { try { out.body = JSON.parse(String(chunk)) } catch { out.body = String(chunk) } } },
  }
  await tryHandleCode({ req, res, path, method: 'POST', url: new URL('http://127.0.0.1:3420' + path) } as any)
  await new Promise((r) => setTimeout(r, 0))
  return out
}

describe('POST /api/code/tasks/<id>/partial', () => {
  beforeEach(() => {
    resetCodeBridgeTablesForTests()
    upsertCodeSession({ project: 'marveen', workspacePath: '/srv/elsewhere', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', pinned: true })
  })

  function running(origin: 'telegram' | 'dashboard'): string {
    const q = enqueueCodeTask({ project: 'marveen', prompt: 'nezd meg', origin, chatId: origin === 'telegram' ? '777' : null })
    if (!('task' in q)) throw new Error('enqueue failed')
    expect(claimNextCodeTask('WINPC')?.id).toBe(q.task.id)
    return q.task.id
  }

  it('forwards the running telegram task text to its chat', async () => {
    const id = running('telegram')
    const r = await call(`/api/code/tasks/${id}/partial`, { text: 'Megnezem a naplot.' })
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(sent).toEqual([{ chatId: '777', text: 'Megnezem a naplot.' }])
  })

  it('answers ok:false and sends nothing for a task not started from Telegram', async () => {
    const id = running('dashboard')
    const r = await call(`/api/code/tasks/${id}/partial`, { text: 'x' })
    expect(r).toEqual({ status: 200, body: { ok: false } })
    expect(sent).toEqual([])
  })

  it('refuses a non-loopback caller, a body without text and an unknown task', async () => {
    const id = running('telegram')
    expect((await call(`/api/code/tasks/${id}/partial`, { text: 'x' }, '192.168.1.50')).status).toBe(403)
    expect((await call(`/api/code/tasks/${id}/partial`, { nope: 1 })).status).toBe(400)
    expect((await call('/api/code/tasks/ffffffffffffffff/partial', { text: 'x' })).status).toBe(404)
    expect(sent).toEqual([])
  })
})

// A worker olvasoja (Read-NewAssistantText). Viselkedesre Windows PowerShell
// 5.1-en merve 2026-10-08 (szintetikus naplok); ez a teszt a szerkezetet orzi.
describe('worker: partial reader (#498)', () => {
  const ps = readFileSync(join(__dirname, '..', '..', 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf-8').replace(/\r\n/g, '\n')
  const reader = ps.slice(ps.indexOf('function Read-NewAssistantText'), ps.indexOf('# ---- onfrissites'))
  const run = ps.slice(ps.indexOf('function Invoke-CodeTask'), ps.indexOf('# ---- folyamatos valasz (#498)'))

  it('holds the latest text back: the final answer goes out once, in the completion notice', () => {
    expect(run).toContain('-Held $partialHeld')
    expect(run).toContain('$partialHeld = [string]$np.held')
    expect(reader).toContain("if ($pending) { $parts.Add($pending); $pending = '' }")
    expect(reader).toContain('if ($hasTool) { $parts.Add($t) } else { $pending = $t }')
    expect(reader).toContain('$out.held = $pending')
  })

  it('skips sub-agent (sidechain) text', () => {
    expect(reader).toContain("if ($o.type -ne 'assistant' -or $o.isSidechain) { continue }")
  })

  it('steps over a line longer than the buffer instead of stalling on it', () => {
    expect(reader).toContain('if ($n -eq $buf.Length) { $pos += $n; continue }')
  })
})
