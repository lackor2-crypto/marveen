// code-bridge-notify: the completion ping.
//
// The rule this file exists to keep: a finished coding task notifies Telegram
// PROGRAMMATICALLY -- string templates only, no model call, no agent turn, no
// tokens. Marvin is not in this path at all; he does not relay, summarise or
// even learn that the task finished.
//
// Boss, 2026-09-05: a card-review task came back "kesz" in Telegram while the
// dashboard's own Jovahagyasok panel showed the same approval failed ("3
// hiba", still waiting). Not a lie on either side -- code_tasks.status ("did
// the worker finish") and approval_verifications.status ("was the change any
// good") are two different signals, and this file used to render only the
// first one. It also used to show a 280-char summary or a 400-char slice of
// the error and cut the rest with "..." -- fine for a short ping, useless when
// the owner's very question is "what actually happened". Fixed on both counts:
// the message now opens with which card/approval/prompt it is about, reflects
// a failed verification instead of a bare checkmark, and carries the full
// result text, chunked across multiple Telegram messages if needed instead of
// truncated.

import { sendTelegramMessage } from './telegram.js'
import { resolveOwnerChatId } from '../owner-chat.js'
import { CODE_BOT_TOKEN, TELEGRAM_BOT_TOKEN, APP_LANG } from '../config.js'
import { logger } from '../logger.js'
import { formatDuration, type CodeTask } from './code-bridge-store.js'
import { getApproval, getKanbanCard, listApprovalVerifications } from '../db.js'
import { approvalCardId } from '../kanban-related.js'

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

const TG_LIMIT = 3800

/** Telegram caps a message at 4096 chars; a long message is split rather than
 *  truncated -- the point of a completion notice (and of /result) is to show
 *  the WHOLE thing, never "...". Moved here (from code-bridge-telegram.ts,
 *  which re-exports it) because the completion notify path needs it too and
 *  that file already imports shortId from here -- the other direction would
 *  be circular. */
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

// ---- the wording, in the install's language ------------------------------
//
// Boss, 2026-09-06: "ha angolra van allitva akor angolul". This notice is the
// one piece of the code bridge the owner actually reads, and it used to be
// hardcoded Hungarian no matter what the dashboard was set to.
//
// House idiom (same as cardWorkNotice in card-work-guard.ts): one {hu, en}
// table, one lookup, {param} substitution. Nothing here calls a model -- this
// path is deliberately token-free (see the file header), so the table is the
// only way the language can change.
//
// WHAT THIS FILE CANNOT TRANSLATE: `task.result` / `task.error` -- the
// executor's own words, quoted verbatim. Translating them here would need a
// model call, which this path must not make. The language of THAT text is
// settled where it is written, by the preface the dispatcher puts in front of
// every task (buildCodeTaskPreamble, point 5), not here.
type NotifyLang = 'hu' | 'en'

/** The install language, narrowed to the two the table carries. Anything that
 *  is not Hungarian reads English -- the same fallback buildCodeTaskPreamble
 *  uses, so the preface and the notice never disagree. */
export function notifyLang(): NotifyLang {
  return APP_LANG === 'hu' ? 'hu' : 'en'
}

const NOTIFY_TEXT: Record<string, { hu: string; en: string }> = {
  'subject.task': { hu: 'Feladat: {text}', en: 'Task: {text}' },
  'subject.card': { hu: 'Kartya #{seq}: {title}', en: 'Card #{seq}: {title}' },
  'subject.approval': { hu: 'Jovahagyas: {text}', en: 'Approval: {text}' },
  'head.verdict_fail': {
    hu: '⚠️ Kod-hid: kesz, DE az ellenorzes FAIL-t adott',
    en: '⚠️ Code bridge: finished, BUT the verification came back FAIL',
  },
  'head.verdict_noresponse': {
    hu: '⚠️ Kod-hid: kesz, DE az ellenorzestol nem jott valasz',
    en: '⚠️ Code bridge: finished, BUT the verification never answered',
  },
  'head.done': { hu: '✅ Kod-hid: {project} kesz', en: '✅ Code bridge: {project} finished' },
  'head.error': { hu: '❌ Kod-hid: {project} hiba', en: '❌ Code bridge: {project} failed' },
  'head.other': { hu: '⚠️ Kod-hid: {project} {status}', en: '⚠️ Code bridge: {project} {status}' },
  'footer.result': { hu: 'Teljes eredmeny: /result {id}', en: 'Full result: /result {id}' },
}

/** Unknown key returns the key itself: a searchable string beats an empty one,
 *  which would look like "there was no notice at all". */
export function notifyText(key: string, lang: NotifyLang, params: Record<string, string> = {}): string {
  const row = NOTIFY_TEXT[key]
  const raw = row ? (lang === 'en' ? row.en : row.hu) : key
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m)
}

const APPROVAL_ID_RE = /\/api\/approvals\/([0-9a-f-]{36})\/verify-result/i

function firstLine(text: string, maxLen = 200): string {
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line
}

export interface TaskSubject {
  label: string
  verdict: 'pass' | 'fail' | 'noresponse' | null
}

/** What the task is ABOUT, for a reader who was not there when it was queued.
 *  A review/fix task carries its approval id in the prompt (the curl command
 *  the worker is told to run to report back); resolved through the approval to
 *  the kanban card it was raised from, this becomes "Kartya #207: ...". A task
 *  with no approval (a plain /code command) falls back to its prompt's own
 *  first line -- there is no card to name. */
export function resolveTaskSubject(task: CodeTask, lang: NotifyLang = notifyLang()): TaskSubject {
  const approvalId = task.prompt.match(APPROVAL_ID_RE)?.[1]
  const approval = approvalId ? getApproval(approvalId) : undefined
  if (!approval) {
    return { label: notifyText('subject.task', lang, { text: firstLine(task.prompt) }), verdict: null }
  }

  const cardId = approvalCardId(approval.action_payload, approval.action_description)
  const card = cardId ? getKanbanCard(cardId) : undefined
  const label = card
    ? notifyText('subject.card', lang, { seq: String(card.seq), title: card.title })
    : notifyText('subject.approval', lang, { text: firstLine(approval.action_description) })

  const mine = task.requestedBy
    ? listApprovalVerifications(approval.id).find(v => v.agent === task.requestedBy)
    : undefined
  const verdict = mine && mine.status !== 'pending' ? mine.status : null
  return { label, verdict }
}

/** Pure: the exact text that goes out. Kept separate from the send so a test can
 *  assert the wording without touching the network. */
export function buildCompletionMessage(task: CodeTask, lang: NotifyLang = notifyLang()): string {
  const subject = resolveTaskSubject(task, lang)
  // A worker that finished technically ("done") but whose own verification
  // came back "fail"/"noresponse" is NOT a checkmark -- that mismatch is
  // exactly the confusion this file was rewritten to stop causing.
  const p = { project: task.project, status: task.status }
  const head =
    task.status === 'done' && subject.verdict === 'fail'
      ? notifyText('head.verdict_fail', lang)
      : task.status === 'done' && subject.verdict === 'noresponse'
        ? notifyText('head.verdict_noresponse', lang)
        : task.status === 'done'
          ? notifyText('head.done', lang, p)
          : task.status === 'error'
            ? notifyText('head.error', lang, p)
            : notifyText('head.other', lang, p)
  // Subject first: "Ezek mit jelentenek???" (Boss, 2026-08-20) was about which
  // BOT sent this; "melyik munkara [vonatkozik]" (2026-09-05) is about which
  // CARD it is. The very first words now answer the second question too.
  const lines = [`📋 ${subject.label}`, head]
  const meta: string[] = []
  if (task.durationMs !== null) meta.push(formatDuration(task.durationMs))
  if (task.numTurns !== null) meta.push(`${task.numTurns} turn`)
  if (task.costUsd !== null) meta.push(`$${task.costUsd.toFixed(3)}`)
  if (meta.length) lines.push(meta.join(' · '))
  // Full text, not the 280-char summary or a 400-char slice: "irja ki rendesen
  // az egesz uzenetet" (Boss, 2026-09-05). notifyCodeTaskFinished chunks this
  // across multiple Telegram messages when it does not fit one.
  const body = task.result ?? task.error
  if (body) lines.push(body)
  lines.push(notifyText('footer.result', lang, { id: shortId(task.id) }))
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
    const message = buildCompletionMessage(task)
    for (const part of chunkMessage(message)) {
      await sendTelegramMessage(token, chatId, part)
    }
  } catch (err) {
    logger.warn({ err, task: task.id }, 'code-bridge: completion notify failed')
  }
}
