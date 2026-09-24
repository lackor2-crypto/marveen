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

const HELP = [
  'Kod-hid parancsok:',
  '/code <projekt> <feladat> - atadja a feladatot a projekt Claude Code sessionjenek',
  '/tabs [projekt] - milyen chat fulek vannak nyitva (cimmel)',
  '/status [projekt] - mi fut most, mi var',
  '/result [id|projekt] - a teljes eredmeny',
  '/projects - a regisztralt sessionok',
  '/cancel <id> - varakozo feladat torlese',
].join('\n')

function sessionLine(s: { project: string; sessionId: string; workspacePath: string; pinned: boolean }): string {
  return `${s.project}${s.pinned ? ' 📌' : ''} - ${s.workspacePath} (${shortId(s.sessionId)})`
}

/** "3 perce" / "2 oraja" / "5 napja". A fulek kozott a KOR alapjan valaszt az
 *  ember ("az, amin ma dolgoztam"), ezert nem masodpercet irunk ki, mint a
 *  futasidonel (`formatDuration`). */
function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'most'
  if (min < 60) return `${min} perce`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} oraja`
  return `${Math.floor(h / 24)} napja`
}

/** Egy chat ful sora. A CIM az elso, mert egy `3cfe9212` senkinek nem mond
 *  semmit -- a "VS Code ugynok kartya tesztelese" viszont felismerheto. */
function tabLine(t: { sessionId: string; title: string | null; mtime: number | null; current: boolean }): string {
  const age = t.mtime ? ` - ${formatAge(Date.now() - t.mtime)}` : ''
  return `${t.current ? '➡️' : '  '} ${t.title ?? '(cim nelkul)'}${age} [${shortId(t.sessionId)}]`
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
      return HELP

    case 'projects': {
      const sessions = listCodeSessions()
      if (sessions.length === 0) return 'Meg nincs regisztralt session. Indul a Windows worker?'
      return ['Projektek:', ...sessions.map(sessionLine)].join('\n')
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
          return `Nincs "${cmd.args.trim()}" nevu projekt a listaban.\nAmit latok: ${names}`
        }
        return view.note ?? 'Nincs egyetlen ismert beszelgetes sem.'
      }

      const lines: string[] = ['Chat fulek:']
      for (const p of shown) {
        const head = p.project ?? `(nincs bekotve) ${p.workspacePath}`
        lines.push('', `📁 ${head}`)
        for (const t of p.tabs) lines.push(tabLine(t))
      }
      lines.push('', '➡️ = ide megy a feladat cimzes nelkul.')
      lines.push('Egy masik fulhez: /code <projekt> #<ful-id> <feladat>')
      // Az ablak MERETET is ki kell mondani, kulonben a lista vegebol nem derul
      // ki, hogy van-e tovabb.
      lines.push(
        `(projektenkent max ${view.window.maxTabsPerProject} ful, ${view.window.maxAgeDays} napra visszamenoleg)`,
      )
      if (view.note) lines.push(view.note)
      return lines.join('\n')
    }

    case 'code': {
      const split = splitProjectAndPrompt(cmd.args)
      if (!split) return `Hasznalat: /code <projekt> <feladat>\n\n${HELP}`
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
    const cand = out.candidates?.length ? `\nProjektek: ${out.candidates.join(', ')}` : ''
    return `⚠️ ${out.error}${cand}`
  }
  // Ha ful volt cimezve, a visszaigazolas MONDJA IS KI, melyikbe ment --
  // kulonben a tulaj csak akkor venne eszre a rossz fulet, amikor a valasz
  // mar egy masik beszelgetesben all.
  const into = out.task.targetSessionId ? ` -> ${tabTitle(out.task.targetSessionId)}` : ''
  return `⏳ Atadva: ${out.task.project}${into} (${shortId(out.task.id)})`
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
  if (pick.ask.length === 0) return 'Meg nincs regisztralt projekt, ezert nincs kinek atadnom. Indul a Windows worker (VS Code)?'
  return [
    'Melyik projektnek adjam at? Ird igy:',
    `/code <projekt> ${text.length > 60 ? text.slice(0, 60) + '...' : text}`,
    `Projektek: ${pick.ask.join(', ')}`,
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
    return isPrivate ? HELP : null
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
        await reply(chatId, `Csak szoveget vagy hangüzenetet ertek.\n\n${HELP}`)
        continue
      }
      const heard = await transcribeWithBotToken(voiceId, CODE_BOT_TOKEN)
      if ('error' in heard) {
        await reply(chatId, heard.error === 'not_installed'
          ? '⚠️ A hangüzenetet nem tudom leirni: a hangfelismero nincs telepitve ezen a gepen (Beallitasok / Kulso programok). Ird le szovegben, es atadom.'
          : '⚠️ A hangüzenetet nem sikerult leirni (a hangfelismero hibat adott). Ird le szovegben, vagy kuldd ujra.')
        continue
      }
      await reply(chatId, `🎙 Ezt ertettem: ${heard.text}`)
      text = heard.text
      if (msg?.caption) text = `${msg.caption}\n${text}`
    }
    let answer: string | null
    try {
      answer = replyForInbound(text, chatId, from, isPrivate)
    } catch (err) {
      logger.error({ err }, 'code-bot: command handler threw')
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
