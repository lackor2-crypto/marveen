import path0 from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// #390: the calendar list is a python + Google API round trip (2-5 s). The
// settings page must not wait for it on every visit: a fresh answer (under a
// minute) is served directly, an older one (under 10 min) is served at once
// and refreshed in the background. Only a successful, non-empty output is
// kept, so a network hiccup is never cached as "no calendars".
const CALENDAR_FRESH_MS = 60_000
const CALENDAR_STALE_OK_MS = 10 * 60_000
const calendarCache = new Map<string, { at: number; out: string }>()
const calendarInFlight = new Map<string, Promise<string>>()

function runCalendarScript(account: string): Promise<string> {
  const root = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '../..')
  const args = [path0.join(root, 'scripts', 'google-auth.py'), 'calendars']
  if (account) args.push(account)
  return new Promise<string>((resolve) => {
    execFile('python3', args, { cwd: root, timeout: 15000 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''))
    })
  })
}

function refreshCalendarList(account: string, fetcher: (a: string) => Promise<string>): Promise<string> {
  const pending = calendarInFlight.get(account)
  if (pending) return pending
  const p = fetcher(account).then((out) => {
    let ok = false
    try { const d = JSON.parse(out.trim() || '{}'); ok = !d.error && Array.isArray(d.calendars) } catch { ok = false }
    if (ok) calendarCache.set(account, { at: Date.now(), out })
    return out
  }).finally(() => { calendarInFlight.delete(account) })
  calendarInFlight.set(account, p)
  return p
}

export async function calendarListOutput(account: string, fetcher: (a: string) => Promise<string> = runCalendarScript): Promise<string> {
  const hit = calendarCache.get(account)
  const age = hit ? Date.now() - hit.at : Infinity
  if (hit && age < CALENDAR_FRESH_MS) return hit.out
  if (hit && age < CALENDAR_STALE_OK_MS) {
    refreshCalendarList(account, fetcher).catch(() => { /* the stale list stays */ })
    return hit.out
  }
  return refreshCalendarList(account, fetcher)
}

/** Test hook. */
export function _resetCalendarCacheForTest(): void { calendarCache.clear(); calendarInFlight.clear() }
