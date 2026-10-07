// #498 -- a Telegramrol inditott, futo feladat reszleges valasza Telegramra megy.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
import type { CodeTask } from '../web/code-bridge-store.js'

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
