// #823 (C): a key function (making a PDF, finalizing a document or a table) that FAILS on the server side is told to the
// owner on the channel at once, instead of waiting for the owner to notice a red toast. One shared gate: every failure path
// of those functions calls alertKeyFunctionFailure(), so a new path cannot forget it.
//
// Only genuine system failures are alerted (HTTP 5xx: converter missing, timeout, write failed). A 4xx is the owner's own
// content state (annex missing, not reviewed yet) and is shown on the page; telling it on the channel would be noise.
import { logger } from './logger.js'
import { ol } from './owner-lang.js'

/** At most one message per function+code in this long, so a broken converter is one message, not one per click. */
export const KEY_ALERT_COOLDOWN_MS = 30 * 60 * 1000
const lastSent = new Map<string, number>()

export type KeyFunction = 'pdf' | 'finalize' | 'table_finalize'

function functionName(fn: KeyFunction): string {
  return fn === 'pdf' ? ol('PDF-készítés', 'PDF creation')
    : fn === 'finalize' ? ol('dokumentum véglegesítése', 'document finalisation')
    : ol('táblázat véglegesítése', 'table finalisation')
}

/** True when a message was sent. `send` is injectable for the test; the default is the owner channel. */
export async function alertKeyFunctionFailure(
  fn: KeyFunction,
  code: string,
  status: number,
  detail: string | null,
  send: (text: string) => Promise<unknown> = async (t) => (await import('./notify.js')).sendOwnerChannelChecked(t),
  now = Date.now(),
): Promise<boolean> {
  if (status < 500) return false
  const key = `${fn}:${code}`
  const prev = lastSent.get(key)
  if (prev !== undefined && now - prev < KEY_ALERT_COOLDOWN_MS) return false
  lastSent.set(key, now)
  const why = detail ? detail.replace(/\s+/g, ' ').slice(0, 300) : ''
  const text = ol(
    `Figyelmeztetés: hiba a dashboardon – ${functionName(fn)} nem sikerült (${code}).${why ? ` Részlet: ${why}` : ''}`,
    `Warning: a dashboard error – ${functionName(fn)} failed (${code}).${why ? ` Detail: ${why}` : ''}`,
  )
  try {
    await send(text)
    return true
  } catch (e) {
    logger.warn({ err: String(e) }, 'key function failure alert could not be sent')
    return false
  }
}

export function _resetKeyFunctionAlert(): void {
  lastSent.clear()
}
