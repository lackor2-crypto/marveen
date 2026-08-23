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
} from './code-bridge-store.js'
import { shortId } from './code-bridge-notify.js'

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
export interface CodeBotIdentity {
  /** `@valami_bot`, vagy null, ha nincs mit mondani. */
  name: string | null
  reason: 'ok' | 'not-configured' | 'unresolved'
  /** Csak `unresolved` eseten: a TENYLEGES hiba, nem tipp. */
  error: string | null
}

const CODE_BOT_NAME_TTL_MS = 60 * 60 * 1000
// Sikertelen lekerdezes utan hamarabb probalunk ujra, de nem minden pollnal:
// egy halott halozat kulonben minden health-hivasra rarakna a timeoutot.
const CODE_BOT_RETRY_MS = 5 * 60 * 1000

let codeBotIdentity: CodeBotIdentity = { name: null, reason: 'not-configured', error: null }
let codeBotFetchedAt = 0
let codeBotInflight: Promise<void> | null = null

/** Csak teszthez: uritsd a gyorsitotarat. */
export function _resetCodeBotIdentityCache(): void {
  codeBotIdentity = { name: null, reason: 'not-configured', error: null }
  codeBotFetchedAt = 0
  codeBotInflight = null
}

export async function resolveCodeBotIdentity(now = Date.now()): Promise<CodeBotIdentity> {
  if (CODE_BOT_TOKEN.length === 0) {
    codeBotIdentity = { name: null, reason: 'not-configured', error: null }
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
        ? { name: `@${r.botUsername}`, reason: 'ok', error: null }
        : { name: null, reason: 'unresolved', error: r.error ?? null }
      codeBotInflight = null
    })()
  }
  await codeBotInflight
  return codeBotIdentity
}

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
      const out = enqueueCodeTask({
        project: split.project,
        prompt: split.prompt,
        // Ha a tulaj nem valasztott fulet, minden a regi marad: a projekt
        // bekotott (legfrissebb) beszelgetese kapja a feladatot.
        sessionId: split.tab,
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
