// Telegram plugin patch: tell the agent WHICH message an inbound one replies to.
//
// The official Telegram channel plugin builds the `notifications/claude/channel`
// meta from a fixed list (chat_id, message_id, user, ts, image_path,
// attachment_*) and drops `ctx.message.reply_to_message`. A bare "B" that the
// owner sent as a REPLY to one of two open questions therefore reaches the agent
// as a context-free "B" (owner report, Telegram 2802, kanban #506).
//
// The plugin lives outside this repo (plugin cache), so the fix is an
// idempotent text patch applied to every installed copy at dashboard start. A
// plugin update replaces the file; the next start patches it again.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger.js'

export const REPLY_META_MARKER = 'MARVEEN-REPLY-META'

/** The anchor: the `ts:` line of the inbound meta. */
const TS_LINE = /^(\s*)ts: new Date\(\(ctx\.message\?\.date \?\? 0\) \* 1000\)\.toISOString\(\),\n/m

export interface PatchResult { changed: boolean; src: string; reason?: 'already' | 'no_anchor' }

/** Pure: returns the patched source (or the input untouched, with a reason). */
export function patchTelegramReplyMeta(src: string): PatchResult {
  if (src.includes(REPLY_META_MARKER)) return { changed: false, src, reason: 'already' }
  const m = TS_LINE.exec(src)
  if (!m) return { changed: false, src, reason: 'no_anchor' }
  const ind = m[1]
  const add =
    `${ind}// ${REPLY_META_MARKER}: which earlier message this one replies to (id, author, short excerpt).\n` +
    `${ind}...(ctx.message?.reply_to_message ? {\n` +
    `${ind}  reply_to_message_id: String(ctx.message.reply_to_message.message_id),\n` +
    `${ind}  reply_to_user: ctx.message.reply_to_message.from?.username ?? String(ctx.message.reply_to_message.from?.id ?? ''),\n` +
    `${ind}  reply_to_excerpt: String(ctx.message.reply_to_message.text ?? ctx.message.reply_to_message.caption ?? '').replace(/\\s+/g, ' ').slice(0, 300),\n` +
    `${ind}} : {}),\n`
  const at = m.index + m[0].length
  return { changed: true, src: src.slice(0, at) + add + src.slice(at) }
}

function pluginRoots(): string[] {
  const roots = [join(homedir(), '.claude', 'plugins')]
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(join(process.env.CLAUDE_CONFIG_DIR, 'plugins'))
  return roots
}

function serverFiles(root: string): string[] {
  const out: string[] = []
  const cache = join(root, 'cache')
  try {
    for (const mk of readdirSync(cache)) {
      const dir = join(cache, mk, 'telegram')
      if (!existsSync(dir)) continue
      for (const ver of readdirSync(dir)) {
        const f = join(dir, ver, 'server.ts')
        if (existsSync(f)) out.push(f)
      }
    }
  } catch { /* no cache dir: nothing to patch */ }
  try {
    const market = join(root, 'marketplaces')
    for (const mk of readdirSync(market)) {
      const f = join(market, mk, 'external_plugins', 'telegram', 'server.ts')
      if (existsSync(f)) out.push(f)
    }
  } catch { /* no marketplaces dir */ }
  return out
}

/** Patch every installed Telegram plugin copy. Returns the files changed. */
export function ensureTelegramReplyMeta(roots: string[] = pluginRoots()): string[] {
  const changed: string[] = []
  for (const f of new Set(roots.flatMap(serverFiles))) {
    try {
      const res = patchTelegramReplyMeta(readFileSync(f, 'utf8'))
      if (res.changed) { writeFileSync(f, res.src); changed.push(f) }
      else if (res.reason === 'no_anchor') logger.warn({ file: f }, 'telegram plugin: reply-meta anchor not found, plugin layout changed')
    } catch (err) {
      logger.warn({ file: f, err: String(err) }, 'telegram plugin: reply-meta patch failed')
    }
  }
  if (changed.length) logger.info({ files: changed }, 'telegram plugin: reply-meta patched (restart the agents to load it)')
  return changed
}
