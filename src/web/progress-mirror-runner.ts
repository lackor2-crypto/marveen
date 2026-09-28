// Live Telegram progress mirror -- the I/O half (kanban #416).
//
// Rebuilt from upstream d3c5fdf5 / 2997022b. Upstream ships this as a systemd
// user daemon with its own message; here it runs inside the dashboard (no
// system service to install -- works on a fresh install as is) and rides on
// the placeholder the hooks already manage. See src/progress-mirror.ts.
//
// Per tick, for every Telegram agent (main + fleet, agent parity):
//   - a placeholder pending in <state>/progress/<sid>.json = a turn the owner
//     is waiting on: edit its text to carry the live status line (throttled);
//     in verbose mode also post the new visible reasoning, silently;
//   - no placeholder, but a background shell / monitor / sub-agent alive:
//     keep ONE silent "⏳ ..." message, deleted as soon as the work ends.
//
// What stays with the hooks, untouched: creating the placeholder, deleting it
// on reply / Stop, and the watchdog turning it into an error when the session
// dies. The mirror never creates or deletes a placeholder, and it re-checks
// that the pending file still exists right before an edit, so it never writes
// over the watchdog's error text (the watchdog renames the file first).
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { APP_LANG, MAIN_AGENT_ID, STORE_DIR } from '../config.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { channelStateDir, readChannelToken } from '../channel-provider.js'
import { agentDir, listAgentNames, readAgentChannelProvider } from './agent-config.js'
import { agentSessionName, capturePaneAsync } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { CHANNEL_PROVIDER } from '../config.js'
import {
  backgroundText,
  classifyPane,
  extractThoughts,
  langOf,
  parseProgressMode,
  placeholderLiveText,
  shouldEdit,
  thoughtMessage,
  type ProgressMode,
} from '../progress-mirror.js'

export const PROGRESS_MIRROR_INTERVAL_MS = 3_000
export const PROGRESS_MIRROR_EDIT_THROTTLE_MS = 4_000
const STATE_PATH = join(STORE_DIR, 'progress-mirror-state.json')
const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'
const MAX_THOUGHT_BYTES = 256 * 1024

// Same text the UserPromptSubmit hook posts (scripts/hooks/telegram_progress.py
// PLACEHOLDER_TEXT). It follows the install language there too.
const PLACEHOLDER_BASE = { hu: '✍️ Dolgozom rajta…', en: '✍️ Working on it…' } as const

type Pending = { chat_id: string | number; message_id: number; transcript_path?: string; created_at?: number; file: string }
type Target = { agent: string; stateDir: string; session: string }

// Persisted: only what must survive a dashboard restart -- the background
// messages, so a restart never leaves a "⏳" behind that nobody deletes.
type Persisted = { background: Record<string, { chatId: string; messageId: number; text: string }> }

const edits = new Map<string, { text: string; at: number }>()
const offsets = new Map<string, number>()
let persisted: Persisted = { background: {} }
let running = false

function loadState(): void {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    if (raw && typeof raw.background === 'object') persisted = { background: raw.background }
  } catch { /* fresh install or unreadable: start empty */ }
}

function saveState(): void {
  try { atomicWriteFileSync(STATE_PATH, JSON.stringify(persisted, null, 2)) } catch (err) {
    logger.warn({ err }, 'progress-mirror: state write failed')
  }
}

export function progressMirrorMode(): ProgressMode {
  try { return parseProgressMode(getEffectiveSettingValue('TELEGRAM_PROGRESS_MODE')) } catch { return 'verbose' }
}

function telegramTargets(): Target[] {
  const out: Target[] = []
  if (CHANNEL_PROVIDER === 'telegram') {
    out.push({ agent: MAIN_AGENT_ID, stateDir: channelStateDir('telegram'), session: MAIN_CHANNELS_SESSION })
  }
  for (const name of listAgentNames()) {
    if (name === MAIN_AGENT_ID) continue
    const provider = readAgentChannelProvider(name) || CHANNEL_PROVIDER
    if (provider !== 'telegram') continue
    let dir: string
    try { dir = agentDir(name) } catch { continue }
    out.push({ agent: name, stateDir: channelStateDir('telegram', dir), session: agentSessionName(name) })
  }
  return out
}

export function readPending(stateDir: string): Pending[] {
  const dir = join(stateDir, 'progress')
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: Pending[] = []
  for (const n of names) {
    // `<sid>.json` only: `<sid>.json.claimed.<pid>` is the watchdog's, and it
    // is about to (or did) turn the placeholder into an error.
    if (!/^[A-Za-z0-9_-]+\.json$/.test(n)) continue
    const file = join(dir, n)
    try {
      const arr = JSON.parse(readFileSync(file, 'utf-8'))
      if (!Array.isArray(arr)) continue
      for (const e of arr) {
        if (e && e.chat_id != null && Number.isInteger(e.message_id)) out.push({ ...e, file })
      }
    } catch { /* half-written by a hook: next tick */ }
  }
  return out
}

/** The owner's chat for messages that belong to no turn: only when exactly
 *  one chat is allowed -- with several, which one is the owner is a guess. */
function ownerChat(stateDir: string): string | null {
  try {
    const a = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf-8'))
    const allow = Array.isArray(a?.allowFrom) ? a.allowFrom : []
    return allow.length === 1 ? String(allow[0]) : null
  } catch { return null }
}

async function tg(token: string, method: string, payload: Record<string, unknown>): Promise<any> {
  try {
    const r = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    })
    return await r.json()
  } catch (err) {
    logger.debug({ err: (err as Error).message, method }, 'progress-mirror: telegram call failed')
    return { ok: false }
  }
}

function newTranscriptLines(path: string): string[] {
  let size: number
  try { size = statSync(path).size } catch { return [] }
  const prev = offsets.get(path)
  // First sighting: start at the end -- earlier turns are history, not news.
  if (prev === undefined || size < prev) { offsets.set(path, size); return [] }
  if (size === prev) return []
  const start = Math.max(prev, size - MAX_THOUGHT_BYTES)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try { readSync(fd, buf, 0, buf.length, start) } finally { closeSync(fd) }
  const text = buf.toString('utf-8')
  const cut = text.lastIndexOf('\n')
  if (cut < 0) return []
  offsets.set(path, start + Buffer.byteLength(text.slice(0, cut + 1), 'utf-8'))
  return text.slice(0, cut).split('\n').filter(Boolean)
}

async function dropBackground(agent: string, token: string | null): Promise<void> {
  const bg = persisted.background[agent]
  if (!bg) return
  if (token) await tg(token, 'deleteMessage', { chat_id: bg.chatId, message_id: bg.messageId })
  delete persisted.background[agent]
  saveState()
}

async function tickTarget(t: Target, mode: ProgressMode, lang: 'hu' | 'en', now: number): Promise<void> {
  const token = readChannelToken('telegram', join(t.stateDir, '.env'))
  if (!token) return
  if (mode === 'silent') { await dropBackground(t.agent, token); return }

  const pending = readPending(t.stateDir)
  const pane = await capturePaneAsync(t.session)
  const activity = classifyPane(pane, lang)

  if (pending.length > 0) {
    // A turn the owner waits on: the placeholder is the indicator.
    await dropBackground(t.agent, token)
    const live = placeholderLiveText(PLACEHOLDER_BASE[lang], activity)
    for (const p of pending) {
      const key = `${t.agent}:${p.chat_id}:${p.message_id}`
      if (live) {
        const prev = edits.get(key)
        if (shouldEdit(prev?.text, live, prev?.at ?? 0, now, PROGRESS_MIRROR_EDIT_THROTTLE_MS) && existsSync(p.file)) {
          await tg(token, 'editMessageText', { chat_id: p.chat_id, message_id: p.message_id, text: live })
          edits.set(key, { text: live, at: now })
        }
      }
      if (mode === 'verbose' && p.transcript_path) {
        // A placeholder from a hook older than #437 carries no created_at:
        // its pending file's mtime is the closest honest bound.
        let since = typeof p.created_at === 'number' ? p.created_at : undefined
        if (since === undefined) { try { since = statSync(p.file).mtimeMs } catch { /* gone: no bound */ } }
        for (const th of extractThoughts(newTranscriptLines(p.transcript_path), lang, since)) {
          await tg(token, 'sendMessage', { chat_id: p.chat_id, text: thoughtMessage(th), disable_notification: true })
        }
      }
    }
    return
  }

  const bgText = backgroundText(activity)
  const current = persisted.background[t.agent]
  if (!bgText) { await dropBackground(t.agent, token); return }
  if (!current) {
    const chat = ownerChat(t.stateDir)
    if (!chat) return
    const r = await tg(token, 'sendMessage', { chat_id: chat, text: bgText, disable_notification: true })
    if (r?.ok && r.result?.message_id) {
      persisted.background[t.agent] = { chatId: chat, messageId: r.result.message_id, text: bgText }
      saveState()
    }
  } else if (current.text !== bgText) {
    await tg(token, 'editMessageText', { chat_id: current.chatId, message_id: current.messageId, text: bgText })
    persisted.background[t.agent] = { ...current, text: bgText }
    saveState()
  }
}

export async function progressMirrorTick(now = Date.now()): Promise<void> {
  if (running) return
  running = true
  try {
    const mode = progressMirrorMode()
    const lang = langOf(APP_LANG)
    const targets = telegramTargets()
    const live = new Set(targets.map(t => t.agent))
    for (const t of targets) {
      try { await tickTarget(t, mode, lang, now) } catch (err) {
        logger.warn({ err, agent: t.agent }, 'progress-mirror: tick failed for agent')
      }
    }
    // Forget throttle entries of placeholders that are gone.
    if (edits.size > 500) edits.clear()
    for (const agent of Object.keys(persisted.background)) {
      if (!live.has(agent)) { delete persisted.background[agent]; saveState() }
    }
  } finally {
    running = false
  }
}

export function startProgressMirrorRunner(): ReturnType<typeof setInterval> {
  loadState()
  return setInterval(() => { void progressMirrorTick() }, PROGRESS_MIRROR_INTERVAL_MS)
}
