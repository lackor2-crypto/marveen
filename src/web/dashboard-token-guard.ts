// Keeps store/.dashboard-token equal to the token the running dashboard holds.
//
// THE INCIDENT (#415, 2026-09-27 02:33:59). An agent checking an approval ran
//   echo "test-token-placeholder" > store/.dashboard-token
// The dashboard reads the token ONCE, at startup, so it kept accepting the
// real one -- but every agent and the code-bridge worker read the FILE, so the
// whole fleet got 401. The real token existed only in the dashboard's memory
// and could not be recovered from there; the next restart would have made the
// guessable placeholder the dashboard's password.
//
// The fix follows from where the truth lives: while the dashboard runs, the
// token in its memory IS the token. Whatever the file says instead is damage,
// and the one thing that can repair it without guessing is this process. So:
// check the file every second, and when it differs, is gone, or cannot be
// read, write the in-memory value back (0600, atomic) and tell the owner.
//
// What this deliberately does NOT do:
//  - touch the file when DASHBOARD_TOKEN comes from the environment -- then the
//    operator owns the token and the file is not the source;
//  - ever write an empty or short value: it only ever writes the token the
//    dashboard is already enforcing, and refuses to start on a weak one.
//
// A deliberate rotation still works: stop the dashboard, change the file,
// start it. While it runs, the file is held to the running value -- the owner
// notice says so, so a rotation attempt is not a mystery.

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { APP_LANG } from '../config.js'
import { logger } from '../logger.js'
import { notifyChannel } from '../notify.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  DASHBOARD_TOKEN_PATH,
  MIN_FILE_TOKEN_LENGTH,
  dashboardTokenFromEnv,
  weakFileTokenReplacedAt,
} from './dashboard-auth.js'
import type { HealthRow } from './system-health.js'

/** What the file looked like against the token the dashboard enforces. */
export type TokenFileVerdict = 'ok' | 'changed' | 'missing' | 'unreadable'

export interface EnforceResult {
  verdict: TokenFileVerdict
  /** The in-memory token was written back. */
  restored: boolean
  /** Set when a restore was needed and did not happen. */
  error?: string
  /** The errno code behind `error` (EISDIR, EACCES...): stable across retries,
   *  unlike the message, which names a fresh tmp file every time. */
  errorCode?: string
}

export function inspectTokenFile(path: string, expected: string): TokenFileVerdict {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    // Two different zeros: "not there" and "could not look". Both end in a
    // rewrite, but the owner is told which one it was.
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  return raw.trim() === expected ? 'ok' : 'changed'
}

/** Only a value a generator produced may ever be written back. */
function restorable(token: string): boolean {
  return token.trim() === token && token.length >= MIN_FILE_TOKEN_LENGTH
}

/**
 * Make the file hold `expected` again if it does not. Atomic (tmp + rename), so
 * a reader never sees a half-written token, and 0600 from the first byte.
 */
export function enforceDashboardTokenFile(path: string, expected: string): EnforceResult {
  const verdict = inspectTokenFile(path, expected)
  if (verdict === 'ok') return { verdict, restored: false }
  if (!restorable(expected)) {
    return { verdict, restored: false, error: 'refusing to write a short or padded token' }
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    atomicWriteFileSync(path, expected, { mode: 0o600 })
    return { verdict, restored: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return { verdict, restored: false, error: err instanceof Error ? err.message : String(err), ...(code ? { errorCode: code } : {}) }
  }
}

// ---- owner notice (HU + EN) -------------------------------------------------

type NoticeKey = 'restored.changed' | 'restored.missing' | 'restored.unreadable' | 'restore_failed' | 'weak_at_startup'

const NOTICE: Record<NoticeKey, { hu: string; en: string }> = {
  'restored.changed': {
    hu: '⚠️ Biztonsági jelzés: valami átírta a dashboard belépési tokenjét tartalmazó fájlt (store/.dashboard-token).',
    en: '⚠️ Security notice: something overwrote the file holding the dashboard access token (store/.dashboard-token).',
  },
  'restored.missing': {
    hu: '⚠️ Biztonsági jelzés: valami törölte a dashboard belépési tokenjét tartalmazó fájlt (store/.dashboard-token).',
    en: '⚠️ Security notice: something deleted the file holding the dashboard access token (store/.dashboard-token).',
  },
  'restored.unreadable': {
    hu: '⚠️ Biztonsági jelzés: a dashboard belépési tokenjét tartalmazó fájl (store/.dashboard-token) olvashatatlanná vált.',
    en: '⚠️ Security notice: the file holding the dashboard access token (store/.dashboard-token) became unreadable.',
  },
  'restore_failed': {
    hu: '⛔ Biztonsági jelzés: a dashboard belépési tokenjét tartalmazó fájl (store/.dashboard-token) sérült, és a dashboard NEM tudta visszaírni. Az ügynökök és a kód-híd ezért nem tudnak belépni. Hiba: {error}',
    en: '⛔ Security notice: the file holding the dashboard access token (store/.dashboard-token) is damaged and the dashboard could NOT write it back. Agents and the code bridge cannot sign in until it is fixed. Error: {error}',
  },
  'weak_at_startup': {
    hu: '⚠️ Biztonsági jelzés: induláskor a store/.dashboard-token fájlban egy túl rövid, kitalálható érték állt, ezt a dashboard nem fogadta el jelszónak. Új, véletlen tokent készített és írt a fájlba; az ügynökök a következő hívásuknál már ezt használják.',
    en: '⚠️ Security notice: at startup store/.dashboard-token held a value too short to be a real token, so the dashboard refused to use it as its password. It generated a new random token and wrote it to the file; agents pick it up on their next call.',
  },
}

const RESTORED_TAIL = {
  hu: 'A futó dashboard visszaírta az érvényes tokent, az ügynökök és a kód-híd újra be tudnak lépni ({n}. eset a dashboard indulása óta). Hogy ki tette, az ügynökök parancs-naplójában (store/agent-audit.jsonl) nézhető meg. Ha szándékosan cserélted: állítsd le a dashboardot, írd át a fájlt, és utána indítsd újra.',
  en: 'The running dashboard wrote the valid token back; agents and the code bridge can sign in again (occurrence {n} since the dashboard started). The agents\' command log (store/agent-audit.jsonl) shows who did it. If you changed it on purpose: stop the dashboard, edit the file, then start it again.',
}

function lang(): 'hu' | 'en' {
  return APP_LANG === 'hu' ? 'hu' : 'en'
}

function fill(text: string, params: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? params[k] : m))
}

export function buildTokenNotice(
  key: NoticeKey,
  params: { n?: number; error?: string } = {},
  l: 'hu' | 'en' = lang(),
): string {
  const head = fill(NOTICE[key][l], { error: params.error ?? '' })
  if (!key.startsWith('restored.')) return head
  return `${head}\n\n${fill(RESTORED_TAIL[l], { n: String(params.n ?? 1) })}`
}

// ---- the guard ---------------------------------------------------------------

/** One message per burst: a writer looping on the file must not turn into a
 *  message every second. Every event is still logged and counted. */
export const NOTICE_MIN_GAP_MS = 10 * 60 * 1000
/** How long the self-check row stays up after the last event. */
export const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000
const POLL_MS = 1000

interface GuardState {
  path: string
  restores: number
  lastRestoreAt: number | null
  lastFailureAt: number | null
  lastFailure: string | null
  lastNoticeAt: number | null
  weakAtStartupAt: number | null
}

let state: GuardState | null = null
let timer: NodeJS.Timeout | null = null
let notifyFn: (text: string) => Promise<void> = notifyChannel
let clock: () => number = Date.now

function notice(text: string, force = false): void {
  if (!state) return
  const now = clock()
  if (!force && state.lastNoticeAt !== null && now - state.lastNoticeAt < NOTICE_MIN_GAP_MS) return
  state.lastNoticeAt = now
  void notifyFn(text).catch((err) => logger.warn({ err }, 'dashboard-token-guard: owner notice failed'))
}

/** Run one check and act on it. Production calls it once a second; exported
 *  so a test can drive a check without waiting for the timer. */
export function checkDashboardTokenNow(expected: string): EnforceResult | null {
  if (!state) return null
  const r = enforceDashboardTokenFile(state.path, expected)
  if (r.verdict === 'ok') {
    // Someone repaired what we could not: the red row has nothing left to say.
    state.lastFailureAt = null
    state.lastFailure = null
    return r
  }
  const now = clock()
  if (r.restored) {
    state.restores += 1
    state.lastRestoreAt = now
    state.lastFailureAt = null
    state.lastFailure = null
    // Never log the token itself -- only what happened to the file.
    logger.error(
      { path: state.path, verdict: r.verdict, occurrence: state.restores },
      'dashboard-token-guard: token file did not match the running token; wrote the running token back',
    )
    notice(buildTokenNotice(`restored.${r.verdict}` as NoticeKey, { n: state.restores }))
  } else {
    // The same failure comes back on every tick until someone fixes the file:
    // it is logged and sent once, and the red self-check row carries it after.
    const error = r.error ?? 'unknown'
    const key = `${r.verdict}:${r.errorCode ?? error}`
    const first = state.lastFailure !== key
    state.lastFailureAt = now
    state.lastFailure = key
    if (!first) return r
    logger.error(
      { path: state.path, verdict: r.verdict, error },
      'dashboard-token-guard: token file is damaged and could NOT be written back',
    )
    notice(buildTokenNotice('restore_failed', { error }), true)
  }
  return r
}

export interface GuardOptions {
  path?: string
  pollMs?: number
  notify?: (text: string) => Promise<void>
  now?: () => number
}

/**
 * Start holding the token file to `expected`. Returns false when there is
 * nothing to guard: the token comes from DASHBOARD_TOKEN, the guard already
 * runs, or `expected` is not a value that may ever be written.
 */
export function startDashboardTokenGuard(expected: string, opts: GuardOptions = {}): boolean {
  if (dashboardTokenFromEnv()) return false
  if (state) return false
  if (!restorable(expected)) {
    logger.error('dashboard-token-guard: the running token is too short to guard; not starting')
    return false
  }
  notifyFn = opts.notify ?? notifyChannel
  clock = opts.now ?? Date.now
  const path = opts.path ?? DASHBOARD_TOKEN_PATH
  state = {
    path,
    restores: 0,
    lastRestoreAt: null,
    lastFailureAt: null,
    lastFailure: null,
    lastNoticeAt: null,
    weakAtStartupAt: weakFileTokenReplacedAt(),
  }
  if (state.weakAtStartupAt !== null) {
    logger.error({ path }, 'dashboard-token: refused a too-short token from the file at startup; a fresh one was written')
    notice(buildTokenNotice('weak_at_startup'), true)
  }
  checkDashboardTokenNow(expected)
  // A plain timed read BY PATH, deliberately not a watch:
  //  - an fs.watch handle follows the inode, so the first overwrite-by-rename
  //    or delete + recreate would leave the guard watching a file that is gone;
  //  - fs.watchFile takes its baseline stat asynchronously, and a write landing
  //    before that baseline is never reported (measured: the tests caught it
  //    under load). A 64-byte read once a second has no such blind spot.
  timer = setInterval(() => {
    // A throw out of a timer would take the whole dashboard down with it.
    try { checkDashboardTokenNow(expected) } catch (err) { logger.warn({ err }, 'dashboard-token-guard: check failed') }
  }, opts.pollMs ?? POLL_MS)
  timer.unref?.()
  return true
}

export function stopDashboardTokenGuard(): void {
  if (timer) clearInterval(timer)
  timer = null
  state = null
  notifyFn = notifyChannel
  clock = Date.now
}

/** Self-check rows: the owner sees the event on the dashboard even when this
 *  install has no chat channel to send the notice to. */
export function dashboardTokenGuardRows(now: number = Date.now()): HealthRow[] {
  if (!state) return []
  const rows: HealthRow[] = []
  if (state.lastFailureAt !== null) {
    rows.push({ id: 'dashboard_token_restore_failed', status: 'bad' })
  } else if (state.lastRestoreAt !== null && now - state.lastRestoreAt < HEALTH_WINDOW_MS) {
    rows.push({
      id: 'dashboard_token_restored',
      status: 'warn',
      params: { n: state.restores, p: Math.max(0, Math.floor((now - state.lastRestoreAt) / 60000)) },
    })
  }
  if (state.weakAtStartupAt !== null && now - state.weakAtStartupAt < HEALTH_WINDOW_MS) {
    rows.push({ id: 'dashboard_token_replaced', status: 'warn' })
  }
  return rows
}
