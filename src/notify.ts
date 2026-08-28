import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID } from './config.js'
import { getProvider } from './channel-provider.js'
import { normalizeChatId, resolveOwnerChatId } from './owner-chat.js'
import { logger } from './logger.js'
import { markIfTestRun } from './test-run-marker.js'

/** Turn a thrown value into something a log line can actually show.
 *
 *  This existed as `{ firstErr, secondErr }` and printed `firstErr: {}` --
 *  pino applies its Error serializer to the `err` key only, so an Error under
 *  any other key logs as an empty object. That is how a whole day of failed
 *  owner alerts stayed unexplained: the log said a send failed and refused to
 *  say why. An unreadable cause is "I could not see", never "no cause". */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`
  return String(e)
}

/** The chat this install's one-way notifications go to, or null when it has none.
 *
 *  Resolved per send rather than at import time: resolveOwnerChatId reads the
 *  channel allowlist off disk, and a fresh install writes that file only when
 *  the user finishes pairing -- long after the dashboard booted. Caching the
 *  answer at module load would freeze it at "no owner chat" for the life of
 *  the process, which on a fresh install is every send the user ever makes.
 *
 *  Measured 2026-08-28: this install carries the installer default
 *  ALLOWED_CHAT_ID=0. `"0"` is a non-empty string, so `!CHANNEL_CHAT_ID` is
 *  false and the old guard waved it through; every alert went to chat 0 and
 *  earned `400 Bad Request: chat not found` from the Bot API. 12 alerts were
 *  lost in one day, including the limit-reset bell the owner was waiting on.
 *  normalizeChatId is the single place that decides what "not set" means. */
function ownerChatId(): string | null {
  // The access.json fallback inside resolveOwnerChatId is Telegram's own
  // allowlist file, so it may only answer for a Telegram install. Every other
  // provider gets the configured value, placeholder-normalised.
  if (CHANNEL_PROVIDER !== 'telegram') return normalizeChatId(CHANNEL_CHAT_ID)
  return resolveOwnerChatId(undefined, CHANNEL_CHAT_ID)
}

export async function notifyChannel(text: string): Promise<void> {
  const chatId = ownerChatId()
  if (!CHANNEL_TOKEN || !chatId) {
    logger.warn(
      { hasToken: Boolean(CHANNEL_TOKEN), configuredChatId: CHANNEL_CHAT_ID || null },
      'Channel ertesites kihagyva: nincs gazda-chat (token hianyzik, vagy a chat ID nincs beallitva / meg a telepitoi helyorzo)',
    )
    return
  }

  // Marked here at the funnel, NOT at call sites -- a new caller must not be
  // able to leak an unmarked message from a test run.
  const outbound = markIfTestRun(text)
  const provider = getProvider(CHANNEL_PROVIDER)
  const formatted = provider.formatMessage(outbound)
  const chunks = provider.splitMessage(formatted)

  for (const chunk of chunks) {
    try {
      const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
      await provider.sendMessage(CHANNEL_TOKEN, chatId, chunk, parseMode)
    } catch (firstErr) {
      try {
        await provider.sendMessage(CHANNEL_TOKEN, chatId, outbound.slice(0, 4096))
      } catch (secondErr) {
        // Both attempts failed -- this used to vanish with zero trace (a
        // confirmed cause of a 2026-08-11 wake-bell that never reached the
        // owner, see kanban 9f2ec0be), and then logged an empty object for a
        // second round (kanban ffa0eff7). Log the real cause, not a shape.
        logger.error(
          {
            firstErr: describeError(firstErr),
            secondErr: describeError(secondErr),
            provider: CHANNEL_PROVIDER,
            chatId,
          },
          'notifyChannel: both delivery attempts failed, message not sent',
        )
      }
    }
  }
}

// Backward-compatible alias
export const notifyTelegram = notifyChannel

// Security-event notification (break-glass password reset, security:reset).
// Unlike notifyChannel, a missing channel config is an EXPECTED state here
// (fresh installs, channel-less deployments), so it stays fully silent -- the
// recovery path must never depend on, or be noisy about, Telegram being wired.
export async function notifySecurityEvent(text: string): Promise<void> {
  if (!CHANNEL_TOKEN || !ownerChatId()) return
  try {
    await notifyChannel(text)
  } catch {
    /* never let a notification failure break the recovery action itself */
  }
}
