// code-bridge-notify: the completion ping.
//
// The rule this file exists to keep: a finished coding task notifies Telegram
// PROGRAMMATICALLY -- string templates only, no model call, no agent turn, no
// tokens. Marvin is not in this path at all; he does not relay, summarise or
// even learn that the task finished. The message is deliberately short (status,
// project, duration, one summary line, the task id); the full transcript is
// fetched on demand with /result.

import { sendTelegramMessage } from './telegram.js'
import { resolveOwnerChatId } from '../owner-chat.js'
import { CODE_BOT_TOKEN, TELEGRAM_BOT_TOKEN } from '../config.js'
import { logger } from '../logger.js'
import { formatDuration, type CodeTask } from './code-bridge-store.js'

/** The bot that answers must be the bot that was asked: a /code command sent to
 *  the dedicated code bot is replied to by that same bot. Only a task with no
 *  chat of its own (dashboard / agent dispatch) falls back to the main bot, so
 *  the owner still gets a ping. */
export function tokenForTask(task: CodeTask): string {
  if (task.origin === 'telegram' && CODE_BOT_TOKEN) return CODE_BOT_TOKEN
  return CODE_BOT_TOKEN || TELEGRAM_BOT_TOKEN
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

/** Pure: the exact text that goes out. Kept separate from the send so a test can
 *  assert the wording without touching the network. */
export function buildCompletionMessage(task: CodeTask): string {
  const head =
    task.status === 'done'
      ? `✅ Kesz: ${task.project}`
      : task.status === 'error'
        ? `❌ Hiba: ${task.project}`
        : `⚠️ ${task.status}: ${task.project}`
  const lines = [head]
  const meta: string[] = []
  if (task.durationMs !== null) meta.push(formatDuration(task.durationMs))
  if (task.numTurns !== null) meta.push(`${task.numTurns} turn`)
  if (task.costUsd !== null) meta.push(`$${task.costUsd.toFixed(3)}`)
  if (meta.length) lines.push(meta.join(' · '))
  if (task.status === 'error' && task.error) lines.push(task.error.slice(0, 400))
  else if (task.summary) lines.push(task.summary)
  lines.push(`/result ${shortId(task.id)}`)
  return lines.join('\n')
}

/** Fire-and-forget: a failed Telegram send must never fail the task itself --
 *  the result is already durable in the DB and /result can still fetch it. */
export async function notifyCodeTaskFinished(task: CodeTask): Promise<void> {
  try {
    const token = tokenForTask(task)
    if (!token) return
    const chatId = task.chatId ?? resolveOwnerChatId()
    if (!chatId) {
      logger.warn({ task: task.id }, 'code-bridge: no chat to notify')
      return
    }
    await sendTelegramMessage(token, chatId, buildCompletionMessage(task))
  } catch (err) {
    logger.warn({ err, task: task.id }, 'code-bridge: completion notify failed')
  }
}
