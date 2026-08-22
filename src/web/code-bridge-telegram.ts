// Inbound Telegram surface of the code bridge -- the "Marvin is not involved"
// half of the design.
//
// WHY A SECOND BOT
// The main bot's getUpdates slot belongs to the native channel plugin running
// inside Marvin's own Claude Code session; a second poller on the same token
// gets 409 Conflict, and there is no supported way to intercept an inbound
// message before that plugin delivers it to Marvin. So the only way for a
// coding command to reach the VS Code session WITHOUT passing through Marvin
// (his context, his tokens, his paraphrasing) is a dedicated bot with its own
// token: CODE_BOT_TOKEN. Add it to the same chat and the owner sees one
// conversation; under the hood the two bots are independent.
//
// Everything in this file is string handling. No model is called on either leg
// -- not to parse the command, not to write the reply.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { STORE_DIR, CODE_BOT_TOKEN, CODE_BOT_ALLOWED_CHAT_IDS, CODE_BRIDGE_ENABLED } from '../config.js'
import { resolveOwnerChatId } from '../owner-chat.js'
import { sendTelegramMessage } from './telegram.js'
import {
  enqueueCodeTask, listCodeSessions, listCodeTasks, latestCodeTaskForProject,
  getCodeTaskByPrefix, getCodeTask, cancelCodeTask, formatDuration, normalizeAlias,
} from './code-bridge-store.js'
import { shortId } from './code-bridge-notify.js'

const OFFSET_FILE = join(STORE_DIR, 'code-bot-offset')
const LONGPOLL_SEC = 30
const TG_LIMIT = 3800

let timer: NodeJS.Timeout | null = null
let stopped = false
let running = false
// Grows only while the API keeps refusing us. A bad token answers instantly, so
// without this the "retry in a second" loop turns one typo into a log flood
// that buries every other warning in the file.
const POLL_MIN_MS = 1000
const POLL_MAX_MS = 60_000
let backoffMs = POLL_MIN_MS

/** Exported for the test: the delay after n consecutive failures. */
export function nextBackoffMs(current: number, ok: boolean): number {
  if (ok) return POLL_MIN_MS
  return Math.min(current * 2, POLL_MAX_MS)
}

// ---- offset persistence -------------------------------------------------

function readOffset(): number {
  try {
    if (!existsSync(OFFSET_FILE)) return 0
    const n = parseInt(readFileSync(OFFSET_FILE, 'utf-8').trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function writeOffset(offset: number): void {
  try {
    writeFileSync(OFFSET_FILE, String(offset), { mode: 0o600 })
  } catch (err) {
    logger.warn({ err }, 'code-bot: offset persist failed')
  }
}

// ---- allowlist ----------------------------------------------------------

/** This bot can run code on the machine, so an unknown chat is dropped without
 *  a reply -- not even an error message, which would confirm the bot exists. */
export function isAllowedChat(chatId: string, allowed: string[], ownerChatId: string | null): boolean {
  if (allowed.length > 0) return allowed.includes(chatId)
  return ownerChatId !== null && chatId === ownerChatId
}

// ---- command parsing ----------------------------------------------------

export interface ParsedCommand {
  command: string
  args: string
}

/** Telegram delivers group commands as `/code@MyBot ...`; the suffix is stripped
 *  so the same handler serves DMs and groups. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const nl = trimmed.search(/\s/)
  const head = nl < 0 ? trimmed : trimmed.slice(0, nl)
  const args = nl < 0 ? '' : trimmed.slice(nl + 1).trim()
  const command = head.slice(1).split('@')[0]!.toLowerCase()
  return { command, args }
}

/** `/code tradingbot fix the SL rounding` -> project + prompt. The first token
 *  is the project; everything after it is passed to Claude Code VERBATIM. */
export function splitProjectAndPrompt(args: string): { project: string; prompt: string } | null {
  const trimmed = args.trim()
  if (!trimmed) return null
  const sep = trimmed.search(/\s/)
  if (sep < 0) return null
  return { project: trimmed.slice(0, sep), prompt: trimmed.slice(sep + 1).trim() }
}

const HELP = [
  'Kod-hid parancsok:',
  '/code <projekt> <feladat> - atadja a feladatot a projekt Claude Code sessionjenek',
  '/status [projekt] - mi fut most, mi var',
  '/result [id|projekt] - a teljes eredmeny',
  '/projects - a regisztralt sessionok',
  '/cancel <id> - varakozo feladat torlese',
].join('\n')

function sessionLine(s: { project: string; sessionId: string; workspacePath: string; pinned: boolean }): string {
  return `${s.project}${s.pinned ? ' 📌' : ''} - ${s.workspacePath} (${shortId(s.sessionId)})`
}

/**
 * Pure command -> reply text. Separated from the transport so the whole command
 * surface is unit-testable without a bot token.
 */
export function handleCodeCommand(cmd: ParsedCommand, chatId: string, from: string): string | null {
  switch (cmd.command) {
    case 'start':
    case 'help':
      return HELP

    case 'projects': {
      const sessions = listCodeSessions()
      if (sessions.length === 0) return 'Meg nincs regisztralt session. Indul a Windows worker?'
      return ['Projektek:', ...sessions.map(sessionLine)].join('\n')
    }

    case 'code': {
      const split = splitProjectAndPrompt(cmd.args)
      if (!split) return `Hasznalat: /code <projekt> <feladat>\n\n${HELP}`
      const out = enqueueCodeTask({
        project: split.project,
        prompt: split.prompt,
        origin: 'telegram',
        requestedBy: from,
        chatId,
      })
      if ('error' in out) {
        const cand = out.candidates?.length ? `\nProjektek: ${out.candidates.join(', ')}` : ''
        return `⚠️ ${out.error}${cand}`
      }
      return `⏳ Atadva: ${out.task.project} (${shortId(out.task.id)})`
    }

    case 'status': {
      const project = cmd.args.trim()
      // Normalized the same way the alias itself was, so "/status Trading Bot"
      // finds `tradingbot` instead of quietly matching nothing.
      const wanted = normalizeAlias(project)
      const active = listCodeTasks({ limit: 50 }).filter((t) => t.status === 'running' || t.status === 'queued')
      const filtered = wanted ? active.filter((t) => t.project.startsWith(wanted)) : active
      if (filtered.length === 0) {
        const last = project ? latestCodeTaskForProject(project) : listCodeTasks({ limit: 1 })[0]
        if (!last) return 'Nincs feladat.'
        return [
          `Nincs futo feladat.`,
          `Utolso: ${last.project} (${shortId(last.id)}) - ${last.status}`,
          last.summary ?? last.error ?? '',
        ]
          .filter(Boolean)
          .join('\n')
      }
      return [
        'Aktiv feladatok:',
        ...filtered.map((t) => {
          const age = t.startedAt ? formatDuration(Date.now() - t.startedAt) : formatDuration(Date.now() - t.createdAt)
          return `${t.status === 'running' ? '▶️' : '⏸'} ${t.project} (${shortId(t.id)}) ${age} - ${t.prompt.slice(0, 60)}`
        }),
      ].join('\n')
    }

    case 'result': {
      const arg = cmd.args.trim()
      const task = arg
        ? (getCodeTask(arg) ?? getCodeTaskByPrefix(arg) ?? latestCodeTaskForProject(arg))
        : (listCodeTasks({ limit: 1 })[0] ?? null)
      if (!task) return 'Nincs ilyen feladat.'
      if (task.status === 'queued') return `⏸ Meg nem indult el: ${task.project} (${shortId(task.id)})`
      if (task.status === 'running') return `▶️ Meg fut: ${task.project} (${shortId(task.id)})`
      const head = `${task.status === 'done' ? '✅' : '❌'} ${task.project} (${shortId(task.id)}) - ${formatDuration(task.durationMs)}`
      const bodyText = task.result ?? task.error ?? '(ures eredmeny)'
      return `${head}\n\n${bodyText}`
    }

    case 'cancel': {
      const arg = cmd.args.trim()
      if (!arg) return 'Hasznalat: /cancel <id>'
      const task = getCodeTask(arg) ?? getCodeTaskByPrefix(arg)
      if (!task) return 'Nincs ilyen feladat.'
      if (task.status === 'running') {
        return `▶️ Mar fut (${shortId(task.id)}) - a futo CLI-t nem lehet innen leallitani.`
      }
      // A finished task cannot be cancelled, and saying "cancelled" about one
      // that already ran would be a lie the owner acts on.
      if (task.status !== 'queued') {
        return `${task.status === 'cancelled' ? '🚫' : 'ℹ️'} Mar lezarult (${task.status}): ${task.project} (${shortId(task.id)})`
      }
      const updated = cancelCodeTask(task.id)
      return `🚫 Torolve: ${updated?.project} (${shortId(task.id)})`
    }

    default:
      // Silence for unknown commands: this bot shares a chat with Marvin's bot,
      // and answering every stray slash-command would double the noise.
      return null
  }
}

// ---- transport ----------------------------------------------------------

/** Telegram caps a message at 4096 chars; a long /result is split rather than
 *  truncated -- the point of /result is to see the WHOLE thing. */
export function chunkMessage(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit)
    const at = cut > limit * 0.5 ? cut : limit
    out.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, '')
  }
  if (rest.length) out.push(rest)
  return out
}

async function reply(chatId: string, text: string): Promise<void> {
  for (const part of chunkMessage(text)) {
    try {
      await sendTelegramMessage(CODE_BOT_TOKEN, chatId, part)
    } catch (err) {
      logger.warn({ err }, 'code-bot: reply failed')
      return
    }
  }
}

interface TgUpdate {
  update_id: number
  message?: { chat?: { id?: number }; from?: { username?: string; first_name?: string }; text?: string }
}

async function pollOnce(): Promise<void> {
  const offset = readOffset()
  const url = `https://api.telegram.org/bot${CODE_BOT_TOKEN}/getUpdates?timeout=${LONGPOLL_SEC}&offset=${offset}&allowed_updates=%5B%22message%22%5D`
  const resp = await fetch(url, { signal: AbortSignal.timeout((LONGPOLL_SEC + 15) * 1000) })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    backoffMs = nextBackoffMs(backoffMs, false)
    // 409 means another poller holds this token. Loud, because it silently
    // eats every command until resolved -- but backed off, because a permanent
    // 401/404 would otherwise repeat this line every second forever.
    logger.warn(
      { status: resp.status, body: body.slice(0, 200), retryInMs: backoffMs },
      'code-bot: getUpdates failed',
    )
    return
  }
  backoffMs = POLL_MIN_MS
  const data = (await resp.json()) as { ok: boolean; result?: TgUpdate[] }
  if (!data.ok || !Array.isArray(data.result)) return

  const ownerChat = resolveOwnerChatId()
  for (const update of data.result) {
    writeOffset(update.update_id + 1)
    const msg = update.message
    const chatId = msg?.chat?.id !== undefined ? String(msg.chat.id) : null
    const text = msg?.text
    if (!chatId || !text) continue
    if (!isAllowedChat(chatId, CODE_BOT_ALLOWED_CHAT_IDS, ownerChat)) {
      logger.warn({ chatId }, 'code-bot: message from a chat that is not allowlisted -- ignored')
      continue
    }
    const cmd = parseCommand(text)
    if (!cmd) continue
    const from = msg?.from?.username ?? msg?.from?.first_name ?? 'owner'
    let answer: string | null
    try {
      answer = handleCodeCommand(cmd, chatId, from)
    } catch (err) {
      logger.error({ err, command: cmd.command }, 'code-bot: command handler threw')
      answer = `⚠️ Belso hiba: ${err instanceof Error ? err.message : String(err)}`
    }
    if (answer) await reply(chatId, answer)
  }
}

async function loop(): Promise<void> {
  if (running || stopped) return
  running = true
  try {
    await pollOnce()
  } catch (err) {
    backoffMs = nextBackoffMs(backoffMs, false)
    logger.warn({ err, retryInMs: backoffMs }, 'code-bot: poll error')
  } finally {
    running = false
    if (!stopped) timer = setTimeout(() => void loop(), backoffMs)
  }
}

/** No token -> no poller, no error: the bridge works fine over REST alone. */
export function startCodeBotPoller(): boolean {
  if (!CODE_BRIDGE_ENABLED || !CODE_BOT_TOKEN) return false
  if (timer) return true
  stopped = false
  backoffMs = POLL_MIN_MS
  logger.info('code-bot: Telegram poller started (dedicated /code bot)')
  void loop()
  return true
}

export function stopCodeBotPoller(): void {
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
