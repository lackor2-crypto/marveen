// #506 -- the Telegram plugin must tell the agent which message an inbound one replies to.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchTelegramReplyMeta, ensureTelegramReplyMeta, REPLY_META_MARKER } from '../telegram-reply-meta-patch.js'

const PLUGIN_SNIPPET = `      meta: {
        chat_id,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        ...(imagePath ? { image_path: imagePath } : {}),
      },
`

describe('patchTelegramReplyMeta', () => {
  it('adds the reply fields right after ts, once', () => {
    const a = patchTelegramReplyMeta(PLUGIN_SNIPPET)
    expect(a.changed).toBe(true)
    expect(a.src).toContain(REPLY_META_MARKER)
    expect(a.src).toContain('reply_to_message_id: String(ctx.message.reply_to_message.message_id)')
    expect(a.src.indexOf('ts: new Date')).toBeLessThan(a.src.indexOf('reply_to_message_id'))
    const b = patchTelegramReplyMeta(a.src)
    expect(b.changed).toBe(false)
    expect(b.reason).toBe('already')
    expect(b.src).toBe(a.src)
  })

  it('leaves an unknown layout untouched and says why', () => {
    const r = patchTelegramReplyMeta('nothing here')
    expect(r).toEqual({ changed: false, src: 'nothing here', reason: 'no_anchor' })
  })

  it('only the inserted block differs from the original', () => {
    const a = patchTelegramReplyMeta(PLUGIN_SNIPPET)
    const stripped = a.src.replace(/ *\/\/ MARVEEN-REPLY-META[\s\S]*?\} : \{\}\),\n/, '')
    expect(stripped).toBe(PLUGIN_SNIPPET)
  })
})

describe('ensureTelegramReplyMeta', () => {
  it('patches cache and marketplace copies, a second run changes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'tgpatch-'))
    try {
      const cacheFile = join(root, 'cache', 'mk', 'telegram', '0.0.7', 'server.ts')
      const mktFile = join(root, 'marketplaces', 'mk', 'external_plugins', 'telegram', 'server.ts')
      for (const f of [cacheFile, mktFile]) {
        mkdirSync(join(f, '..'), { recursive: true })
        writeFileSync(f, PLUGIN_SNIPPET)
      }
      expect(ensureTelegramReplyMeta([root]).sort()).toEqual([cacheFile, mktFile].sort())
      expect(readFileSync(cacheFile, 'utf8')).toContain(REPLY_META_MARKER)
      expect(ensureTelegramReplyMeta([root])).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('a missing plugin directory is not an error', () => {
    expect(ensureTelegramReplyMeta([join(tmpdir(), 'no-such-plugins-dir-506')])).toEqual([])
  })
})
