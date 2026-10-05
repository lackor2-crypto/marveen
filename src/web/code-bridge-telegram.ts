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
import { sendTelegramMessage, validateTelegramToken } from './telegram.js'
import {
  enqueueCodeTask, listCodeSessions, listCodeTasks, latestCodeTaskForProject,
  getCodeTaskByPrefix, getCodeTask, cancelCodeTask, formatDuration, normalizeAlias,
  listCodeTabs,
  isExcludedProject,
} from './code-bridge-store.js'
import { shortId, chunkMessage } from './code-bridge-notify.js'
import { transcribeWithBotToken } from './routes/voice.js'
import { ol, uiString } from '../owner-lang.js'

// Re-exported for callers/tests that historically imported it from here --
// it now lives in code-bridge-notify.ts (see that file for why).
export { chunkMessage }

// --- Ki ez a bot (a kartya neve) -------------------------------------------
//
// A Csapat lapon minden ugynok-kartya a SAJAT Telegram-nevet viseli; a VS Code
// kartya sokaig a workspace mappanevet mutatta ("fejlesztes"), ami kilogott a
// sorbol. Innentol a kod-bot Telegram-neve a cim.
//
// A nulla ket dolgot jelenthet, ezert nem `string | null` megy ki, hanem egy
// OK is: nincs beallitva bot (friss telepites -- ez a normalis allapot, a hid
// enelkul is mukodik), vagy VAN token, de nem tudtuk lekerdezni (halozat,
// visszavont token). A masodikat SOSE talalgatjuk: a Telegram sajat hibauzenete
// megy tovabb.
/** A kepernyore szant nev a Telegram-felhasznalonevbol.
 *
 *  Boss, 2026-08-23: "A nevbol lehagyhattad volna mar a bot veget. a tobbinel
 *  sincsen..." -- a tobbi ugynok is a SAJAT neven all a kartyan, nem a
 *  bot-azonositojan. Lekerul a `@`, a vegerol a `_bot` / `bot` toldalek, es az
 *  alahuzasokbol szokoz lesz.
 *
 *  Ha a levagas utan nem marad semmi (`@bot`, `@_bot`), akkor a TELJES nevet
 *  adjuk vissza: ures cim helyett inkabb csunya, de valodi nev alljon ott. */
export function displayBotName(username: string): string {
  const raw = (username ?? '').trim().replace(/^@/, '')
  const trimmed = raw.replace(/[_-]?bot$/i, '').replace(/[_-]+/g, ' ').trim()
  return trimmed || raw
}

export interface CodeBotIdentity {
  /** A kartyara kerulo nev, `@` es `_bot` veg nelkul (pl. `marveen vscode`). */
  name: string | null
  /** A teljes Telegram-felhasznalonev (`@valami_bot`) -- ez a cimezheto alak,
   *  ezert a sugoban/beallitasoknal EZ kell, nem a rovidites. */
  username: string | null
  reason: 'ok' | 'not-configured' | 'unresolved'
  /** Csak `unresolved` eseten: a TENYLEGES hiba, nem tipp. */
  error: string | null
}

const CODE_BOT_NAME_TTL_MS = 60 * 60 * 1000
// Sikertelen lekerdezes utan hamarabb probalunk ujra, de nem minden pollnal:
// egy halott halozat kulonben minden health-hivasra rarakna a timeoutot.
const CODE_BOT_RETRY_MS = 5 * 60 * 1000

let codeBotIdentity: CodeBotIdentity = { name: null, username: null, reason: 'not-configured', error: null }
let codeBotFetchedAt = 0
let codeBotInflight: Promise<void> | null = null

/** Csak teszthez: uritsd a gyorsitotarat. */
export function _resetCodeBotIdentityCache(): void {
  codeBotIdentity = { name: null, username: null, reason: 'not-configured', error: null }
  codeBotFetchedAt = 0
  codeBotInflight = null
}

export async function resolveCodeBotIdentity(now = Date.now()): Promise<CodeBotIdentity> {
  if (CODE_BOT_TOKEN.length === 0) {
    codeBotIdentity = { name: null, username: null, reason: 'not-configured', error: null }
    codeBotFetchedAt = 0
    return codeBotIdentity
  }
  const ttl = codeBotIdentity.reason === 'ok' ? CODE_BOT_NAME_TTL_MS : CODE_BOT_RETRY_MS
  if (codeBotFetchedAt !== 0 && now - codeBotFetchedAt < ttl) return codeBotIdentity
  if (!codeBotInflight) {
    codeBotInflight = (async () => {
      const r = await validateTelegramToken(CODE_BOT_TOKEN)
      codeBotFetchedAt = Date.now()
      codeBotIdentity = r.ok && r.botUsername
        ? { name: displayBotName(r.botUsername), username: `@${r.botUsername}`, reason: 'ok', error: null }
        : { name: null, username: null, reason: 'unresolved', error: r.error ?? null }
      codeBotInflight = null
    })()
  }
  await codeBotInflight
  return codeBotIdentity
}

const OFFSET_FILE = join(STORE_DIR, 'code-bot-offset')
const LONGPOLL_SEC = 30

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
 *  is the project; everything after it is passed to Claude Code VERBATIM.
 *
 *  Egy projekt-mappaban tobb chat ful is lehet, ezert a projekt utan allhat egy
 *  `#<ful-id>` (a `/tabs` listaja irja ki oket). Csak hexa azonositot fogadunk
 *  el, hogy egy `#152`-vel kezdodo VALODI feladat ne tunjon ful-cimzesnek; ha
 *  megis ilyen a feladat elso szava, a valasz hangos hiba lesz az ismert fulek
 *  listajaval -- nem nema felrekuldes. */
export function splitProjectAndPrompt(args: string): { project: string; tab: string | null; prompt: string } | null {
  const trimmed = args.trim()
  if (!trimmed) return null
  const sep = trimmed.search(/\s/)
  if (sep < 0) return null
  const project = trimmed.slice(0, sep)
  let rest = trimmed.slice(sep + 1).trim()
  let tab: string | null = null
  const tabMatch = /^#([0-9a-f]{4,40})(\s+|$)/i.exec(rest)
  if (tabMatch) {
    tab = tabMatch[1]!.toLowerCase()
    rest = rest.slice(tabMatch[0].length).trim()
  }
  if (!rest) return null
  return { project, tab, prompt: rest }
}

// Every reply of this bot lands on the owner's Telegram, so it follows the
// install language (#416) -- an English install gets English here too.
function help(): string {
  return ol(
    [
      'Kod-hid parancsok:',
      '/code <projekt> <feladat> - atadja a feladatot a projekt Claude Code sessionjenek',
      '/tabs [projekt] - milyen chat fulek vannak nyitva (cimmel)',
      '/status [projekt] - mi fut most, mi var',
      '/result [id|projekt] - a teljes eredmeny',
      '/projects - a regisztralt sessionok',
      '/cancel <id> - varakozo feladat torlese',
    ].join('\n'),
    [
      'Code bridge commands:',
      "/code <project> <task> - hands the task to the project's Claude Code session",
      '/tabs [project] - which chat tabs are open (with titles)',
      '/status [project] - what is running now, what is waiting',
      '/result [id|project] - the full result',
      '/projects - the registered sessions',
      '/cancel <id> - delete a waiting task',
    ].join('\n'),
  )
}

function sessionLine(s: { project: string; sessionId: string; workspacePath: string; pinned: boolean }): string {
  return `${s.project}${s.pinned ? ' 📌' : ''} - ${s.workspacePath} (${shortId(s.sessionId)})`
}

/** "3 perce" / "2 oraja" / "5 napja". A fulek kozott a KOR alapjan valaszt az
 *  ember ("az, amin ma dolgoztam"), ezert nem masodpercet irunk ki, mint a
 *  futasidonel (`formatDuration`). */
function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return ol('most', 'now')
  if (min < 60) return ol(`${min} perce`, `${min} min ago`)
  const h = Math.floor(min / 60)
  if (h < 24) return ol(`${h} oraja`, `${h} h ago`)
  return ol(`${Math.floor(h / 24)} napja`, `${Math.floor(h / 24)} days ago`)
}

/** Egy chat ful sora. A CIM az elso, mert egy `3cfe9212` senkinek nem mond
 *  semmit -- a "VS Code ugynok kartya tesztelese" viszont felismerheto. */
function tabLine(t: { sessionId: string; title: string | null; mtime: number | null; current: boolean }): string {
  const age = t.mtime ? ` - ${formatAge(Date.now() - t.mtime)}` : ''
  return `${t.current ? '➡️' : '  '} ${t.title ?? ol('(cim nelkul)', '(untitled)')}${age} [${shortId(t.sessionId)}]`
}

/** Egy ful EMBERI neve az azonositoja alapjan. Ha nem ismerjuk (a worker meg
 *  nem jelentett rola), a rovid azonositot adjuk vissza -- nem talalunk ki
 *  cimet. */
function tabTitle(sessionId: string): string {
  const hit = listCodeTabs().projects.flatMap((p) => p.tabs).find((t) => t.sessionId === sessionId)
  return hit?.title ?? shortId(sessionId)
}

/**
 * Pure command -> reply text. Separated from the transport so the whole command
 * surface is unit-testable without a bot token.
 */
export function handleCodeCommand(cmd: ParsedCommand, chatId: string, from: string): string | null {
  switch (cmd.command) {
    case 'start':
    case 'help':
      return help()

    case 'projects': {
      const sessions = listCodeSessions()
      if (sessions.length === 0) return ol('Meg nincs regisztralt session. Indul a Windows worker?', 'No registered session yet. Is the Windows worker running?')
      return [ol('Projektek:', 'Projects:'), ...sessions.map(sessionLine)].join('\n')
    }

    // "Listazza ki, milyen chat fulek vannak" -- ez a parancs. Nem kell hozza
    // sem nev-kitalalas, sem UUID: a cimeket olvassa vissza, es a sor vegen ott
    // a rovid azonosito, amit Marvin (vagy a tulaj) atadhat a feladatnak.
    case 'tabs': {
      const view = listCodeTabs()
      const wanted = normalizeAlias(cmd.args.trim())
      const shown = wanted
        ? view.projects.filter(
            (p) => (p.project ?? '').startsWith(wanted) || normalizeAlias(p.workspacePath).includes(wanted),
          )
        : view.projects

      if (shown.length === 0) {
        // A NULLA ket dolgot jelenthet. Ha szurtunk, azt mondjuk meg, hogy a
        // SZURO nem talalt; ha nem, a `note` mondja meg, hogy nincs beszelgetes,
        // vagy nem latunk oda.
        if (wanted && view.projects.length > 0) {
          const names = view.projects.map((p) => p.project ?? p.workspacePath).join(', ')
          return ol(
            `Nincs "${cmd.args.trim()}" nevu projekt a listaban.\nAmit latok: ${names}`,
            `No project named "${cmd.args.trim()}" in the list.\nWhat I see: ${names}`,
          )
        }
        return view.note ?? ol('Nincs egyetlen ismert beszelgetes sem.', 'There is no known conversation at all.')
      }

      const lines: string[] = [ol('Chat fulek:', 'Chat tabs:')]
      for (const p of shown) {
        const head = p.project ?? `${ol('(nincs bekotve)', '(not connected)')} ${p.workspacePath}`
        lines.push('', `📁 ${head}`)
        for (const t of p.tabs) lines.push(tabLine(t))
      }
      lines.push('', ol('➡️ = ide megy a feladat cimzes nelkul.', '➡️ = a task without an address goes here.'))
      lines.push(ol('Egy masik fulhez: /code <projekt> #<ful-id> <feladat>', 'To another tab: /code <project> #<tab-id> <task>'))
      // Az ablak MERETET is ki kell mondani, kulonben a lista vegebol nem derul
      // ki, hogy van-e tovabb.
      lines.push(
        ol(
          `(projektenkent max ${view.window.maxTabsPerProject} ful, ${view.window.maxAgeDays} napra visszamenoleg)`,
          `(max ${view.window.maxTabsPerProject} tabs per project, going back ${view.window.maxAgeDays} days)`,
        ),
      )
      if (view.note) lines.push(view.note)
      return lines.join('\n')
    }

    case 'code': {
      const split = splitProjectAndPrompt(cmd.args)
      if (!split) return ol(`Hasznalat: /code <projekt> <feladat>\n\n${help()}`, `Usage: /code <project> <task>\n\n${help()}`)
      return enqueueFromTelegram(split.project, split.tab, split.prompt, chatId, from)
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
        if (!last) return ol('Nincs feladat.', 'No task.')
        return [
          ol('Nincs futo feladat.', 'No running task.'),
          `${ol('Utolso', 'Last')}: ${last.project} (${shortId(last.id)}) - ${last.status}`,
          last.summary ?? last.error ?? '',
        ]
          .filter(Boolean)
          .join('\n')
      }
      return [
        ol('Aktiv feladatok:', 'Active tasks:'),
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
      if (!task) return ol('Nincs ilyen feladat.', 'No such task.')
      if (task.status === 'queued') return `⏸ ${ol('Meg nem indult el', 'Not started yet')}: ${task.project} (${shortId(task.id)})`
      if (task.status === 'running') return `▶️ ${ol('Meg fut', 'Still running')}: ${task.project} (${shortId(task.id)})`
      const head = `${task.status === 'done' ? '✅' : '❌'} ${task.project} (${shortId(task.id)}) - ${formatDuration(task.durationMs)}`
      const bodyText = task.result ?? task.error ?? ol('(ures eredmeny)', '(empty result)')
      return `${head}\n\n${bodyText}`
    }

    case 'cancel': {
      const arg = cmd.args.trim()
      if (!arg) return ol('Hasznalat: /cancel <id>', 'Usage: /cancel <id>')
      const task = getCodeTask(arg) ?? getCodeTaskByPrefix(arg)
      if (!task) return ol('Nincs ilyen feladat.', 'No such task.')
      if (task.status === 'running') {
        return ol(
          `▶️ Mar fut (${shortId(task.id)}) - a futo CLI-t nem lehet innen leallitani.`,
          `▶️ Already running (${shortId(task.id)}) - the running CLI cannot be stopped from here.`,
        )
      }
      // A finished task cannot be cancelled, and saying "cancelled" about one
      // that already ran would be a lie the owner acts on.
      if (task.status !== 'queued') {
        return `${task.status === 'cancelled' ? '🚫' : 'ℹ️'} ${ol('Mar lezarult', 'Already finished')} (${task.status}): ${task.project} (${shortId(task.id)})`
      }
      const updated = cancelCodeTask(task.id)
      return `🚫 ${ol('Torolve', 'Deleted')}: ${updated?.project} (${shortId(task.id)})`
    }

    default:
      // Silence for unknown commands: this bot shares a chat with Marvin's bot,
      // and answering every stray slash-command would double the noise.
      return null
  }
}

/** Enqueue one task for a Telegram sender and phrase the receipt. Shared by
 *  `/code` and by a plain sentence / voice note (see replyForInbound). */
function enqueueFromTelegram(project: string, tab: string | null, prompt: string, chatId: string, from: string): string {
  const out = enqueueCodeTask({
    project,
    prompt,
    // Ha a tulaj nem valasztott fulet, minden a regi marad: a projekt
    // bekotott (legfrissebb) beszelgetese kapja a feladatot.
    sessionId: tab,
    origin: 'telegram',
    requestedBy: from,
    chatId,
  })
  if ('error' in out) {
    const cand = out.candidates?.length ? `\n${ol('Projektek', 'Projects')}: ${out.candidates.join(', ')}` : ''
    // The dashboard's translated sentence, not the raw English `error` (#416).
    return `⚠️ ${uiString(out.errorKey, out.errorParams, out.error)}${cand}`
  }
  // Ha ful volt cimezve, a visszaigazolas MONDJA IS KI, melyikbe ment --
  // kulonben a tulaj csak akkor venne eszre a rossz fulet, amikor a valasz
  // mar egy masik beszelgetesben all.
  const into = out.task.targetSessionId ? ` -> ${tabTitle(out.task.targetSessionId)}` : ''
  return `⏳ ${ol('Atadva', 'Handed over')}: ${out.task.project}${into} (${shortId(out.task.id)})` + queueNote(out.task.project, out.task.id)
}

/** Boss (TG 2409): a question sent while the project was busy got only "Handed over" and then silence.
 *  One task per project runs at a time, so say what is ahead of this one instead of leaving the wait unexplained. */
export function queueNote(project: string, taskId: string): string {
  const open = listCodeTasks({ project, limit: 50 }).filter((t) => (t.status === 'running' || t.status === 'queued') && t.id !== taskId)
  const running = open.find((t) => t.status === 'running')
  const waiting = open.filter((t) => t.status === 'queued' && t.createdAt < (getCodeTask(taskId)?.createdAt ?? Infinity)).length
  if (!running && waiting === 0) return ''
  const lines: string[] = []
  if (running) {
    const since = formatDuration(Date.now() - (running.startedAt ?? running.createdAt))
    lines.push(ol(
      `Mar fut egy feladat ebben a projektben (${shortId(running.id)}, ${since} ota), a tied utana kovetkezik.`,
      `A task is already running in this project (${shortId(running.id)}, for ${since}); yours comes after it.`,
    ))
  }
  if (waiting > 0) lines.push(ol(`Elotted meg ${waiting} varakozik.`, `${waiting} more waiting ahead of yours.`))
  return '\n' + lines.join(' ')
}

/**
 * Which project a plain sentence (no `/code <projekt>`) goes to.
 *
 * Boss, 2026-09-24: "kiadtam neki egy parancsot, es nem csinalja" -- a plain
 * message in the bot's own chat only drew the command list back, and a voice
 * note was dropped without a word. The owner is not a programmer; the `/code
 * <projekt>` syntax is not something to expect. So a plain message IS a task,
 * for the project the owner PINNED (📌 -- their own choice, not our guess).
 * No pin but a single project: that one. Anything else is ambiguous, and then
 * we ask with the list instead of picking.
 */
export function defaultProjectForPlainText(
  sessions: Array<{ project: string; pinned: boolean }>,
): { project: string } | { ask: string[] } {
  const projects = [...new Set(sessions.map((x) => x.project))]
  const pinned = [...new Set(sessions.filter((x) => x.pinned).map((x) => x.project))]
  if (pinned.length === 1) return { project: pinned[0]! }
  if (pinned.length === 0 && projects.length === 1) return { project: projects[0]! }
  return { ask: pinned.length > 1 ? pinned : projects }
}

/** A plain sentence (or a voice transcript) in the private chat -> a task. */
export function plainTextTask(text: string, chatId: string, from: string): string {
  const pick = defaultProjectForPlainText(listCodeSessions().filter((x) => !isExcludedProject(x.project)))
  if ('project' in pick) return enqueueFromTelegram(pick.project, null, text, chatId, from)
  if (pick.ask.length === 0) return ol(
      'Meg nincs regisztralt projekt, ezert nincs kinek atadnom. Indul a Windows worker (VS Code)?',
      'No registered project yet, so there is nobody to hand it to. Is the Windows worker (VS Code) running?',
    )
  return [
    ol('Melyik projektnek adjam at? Ird igy:', 'Which project should get it? Write it like this:'),
    `/code <${ol('projekt', 'project')}> ${text.length > 60 ? text.slice(0, 60) + '...' : text}`,
    `${ol('Projektek', 'Projects')}: ${pick.ask.join(', ')}`,
  ].join('\n')
}

/** The reply for ONE inbound message, or null to stay silent.
 *
 *  Boss, 2026-09-18 ("a vscode nal telegramot hasznalok. Telegrammon irjon
 *  vissza..."): in the bot's OWN private chat it must not sit dead-silent on a
 *  message it cannot act on -- a plain sentence, or an unknown slash-command.
 *  There it answers with the command list, so the owner always gets something
 *  back and sees how to use it. A recognized command still returns its own
 *  answer unchanged.
 *
 *  In a GROUP it keeps the old silence for anything unrecognized: Marvin's bot
 *  is in the same chat, so a reply to every stray line would double every
 *  message. `isPrivate` is the Telegram chat.type, which the caller passes;
 *  when it is unknown we err toward silence (treat as not-private), so we can
 *  never spam a shared chat. */
export function replyForInbound(
  text: string,
  chatId: string,
  from: string,
  isPrivate: boolean,
): string | null {
  const cmd = parseCommand(text)
  if (cmd) {
    const answer = handleCodeCommand(cmd, chatId, from)
    if (answer) return answer
    return isPrivate ? help() : null
  }
  // A plain sentence in the bot's own chat is a task (defaultProjectForPlainText).
  // In a group it stays silent: Marvin's bot reads the same lines.
  if (!isPrivate || !text.trim()) return null
  return plainTextTask(text.trim(), chatId, from)
}

// ---- transport ----------------------------------------------------------

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
  message?: {
    chat?: { id?: number; type?: string }
    from?: { username?: string; first_name?: string }
    text?: string
    caption?: string
    voice?: { file_id?: string }
    audio?: { file_id?: string }
    video_note?: { file_id?: string }
  }
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
    if (!chatId) continue
    if (!isAllowedChat(chatId, CODE_BOT_ALLOWED_CHAT_IDS, ownerChat)) {
      logger.warn({ chatId }, 'code-bot: message from a chat that is not allowlisted -- ignored')
      continue
    }
    // A missing chat.type is treated as NOT private, so an unrecognized message
    // can never draw a reply into a shared group (see replyForInbound).
    const isPrivate = msg?.chat?.type === 'private'
    const from = msg?.from?.username ?? msg?.from?.first_name ?? 'owner'
    let text = msg?.text
    if (!text) {
      // Not a text message. It used to be dropped without a word -- a voice
      // note to the bot simply vanished (Boss, 2026-09-24). In a group we
      // still stay out of it; in the bot's own chat we always answer.
      if (!isPrivate) continue
      const voiceId = msg?.voice?.file_id ?? msg?.audio?.file_id ?? msg?.video_note?.file_id
      if (!voiceId) {
        await reply(chatId, `${ol('Csak szoveget vagy hangüzenetet ertek.', 'I only understand text or voice messages.')}\n\n${help()}`)
        continue
      }
      const heard = await transcribeWithBotToken(voiceId, CODE_BOT_TOKEN)
      if ('error' in heard) {
        await reply(chatId, heard.error === 'not_installed'
          ? ol(
              '⚠️ A hangüzenetet nem tudom leirni: a hangfelismero nincs telepitve ezen a gepen (Beallitasok / Kulso programok). Ird le szovegben, es atadom.',
              '⚠️ I cannot transcribe the voice message: speech recognition is not installed on this machine (Settings / External programs). Write it as text and I will hand it over.',
            )
          : ol(
              '⚠️ A hangüzenetet nem sikerult leirni (a hangfelismero hibat adott). Ird le szovegben, vagy kuldd ujra.',
              '⚠️ Could not transcribe the voice message (speech recognition failed). Write it as text, or send it again.',
            ))
        continue
      }
      await reply(chatId, `🎙 ${ol('Ezt ertettem', 'I heard')}: ${heard.text}`)
      text = heard.text
      if (msg?.caption) text = `${msg.caption}\n${text}`
    }
    let answer: string | null
    try {
      answer = replyForInbound(text, chatId, from, isPrivate)
    } catch (err) {
      logger.error({ err }, 'code-bot: command handler threw')
      answer = `⚠️ ${ol('Belso hiba', 'Internal error')}: ${err instanceof Error ? err.message : String(err)}`
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
