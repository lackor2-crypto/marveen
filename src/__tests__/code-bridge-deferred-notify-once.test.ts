// A limit-deferred task is announced once, not on every 30-minute probe that puts it back (#550 / #585).
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
import { notifyCodeTaskDeferred, resetDeferredNotified } from '../web/code-bridge-notify.js'
import type { CodeTask, CodeBridgeLimit } from '../web/code-bridge-store.js'

const task = (id: string): CodeTask => ({ id, project: 'marveen', status: 'queued', origin: 'telegram', requestedBy: null, chatId: '777' } as unknown as CodeTask)
const limit = { side: 'windows', resetsAt: Date.now() + 3_600_000, notedAt: Date.now(), estimated: true, sentence: '' } as unknown as CodeBridgeLimit

beforeEach(() => { initDatabase(':memory:'); sent.length = 0; resetDeferredNotified() })

describe('notifyCodeTaskDeferred', () => {
  it('tells the sender once per task, however often the task is put back', async () => {
    await notifyCodeTaskDeferred(task('aaaaaaaa11111111'), limit)
    await notifyCodeTaskDeferred(task('aaaaaaaa11111111'), limit)
    await notifyCodeTaskDeferred(task('aaaaaaaa11111111'), limit)
    expect(sent).toHaveLength(1)
  })
  it('another task is announced on its own', async () => {
    await notifyCodeTaskDeferred(task('aaaaaaaa11111111'), limit)
    await notifyCodeTaskDeferred(task('bbbbbbbb22222222'), limit)
    expect(sent).toHaveLength(2)
  })
})
