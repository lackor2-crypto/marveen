/**
 * A KERET VISSZATERESEKOR A FELBEMARADT MUNKA MAGATOL FOLYTATODIK (Boss, Workbench chat 2026-11-17).
 *
 * "Neked kell szolni, hogy folytasd ahol abbahagytad. [...] Amikor visszater az 5 oras keret, automatikusan
 * tudd folytatni a felbemaradt munkat. Be kell egetni es globalisan, uj telepitesnel is mukodjon."
 *
 * A HIBA: ha egy Munkapad-fordulo usage-limitbe futott (az 5 oras vagy a heti keret elfogyott) es NINCS masik
 * fiok, amire at lehetne valtani, a chat kiirta a limit-mondatot, es a munka ott megallt. Amikor a keret
 * visszajott, SENKI nem inditotta ujra: a tulajdonosnak kellett beleirnia, hogy "folytasd".
 *
 * A JAVITAS: a limitbe futott, nem kesz fordulo bejegyzest kap egy tartos (ujrainditast is tuleloo) fajlba. Egy
 * figyelo percenkent megnezi: van-e MAR fiok, ami tud dolgozni (az elo fiok-allapotbol, nem becsult idobol), es ha
 * igen, ugyanabban a chatben ugyanazzal a kontextussal folytatja a munkat. Nem folytat vegtelensegig: egy bejegyzes
 * legfeljebb MAX_ATTEMPTS-szor fut, es legfeljebb MAX_AGE_MS-ig el (a heti keret ennyi ideig tarthat); utana a chat
 * megmondja, miert nem folytatta.
 *
 * Ez a modul fuggosegmentes dontes + tarolas; a futtatas (az uzenet-vegpont hivasa) a routes/workbench-agent.ts-ben.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

export interface LimitResumeEntry {
  /** The Workbench turn key (project + work item). One entry per turn. */
  key: string
  projectId: string
  workItemId: string | null
  /** The account the owner picked; '' / undefined = automatic choice. */
  account?: string
  lang: 'hu' | 'en'
  actor: string
  createdAt: number
  /** Earliest moment to try again (ms). A probe, not a promise: the live account state decides. */
  notBefore: number
  /** When this entry was last (re)scheduled (ms): the base of the hourly probe. */
  scheduledAt: number
  /** How many resumes this entry already made (each one that ends on the limit again counts). */
  attempts: number
}

/** The space between two tries of one entry: a window that has not really reset yet must not be hammered. */
export const RETRY_SPACING_MS = 5 * 60_000
/** A weekly window can be about a week away; longer than that is not "the work that just stopped". */
export const MAX_AGE_MS = 8 * 24 * 3_600_000
/** Bound on resumes of one entry (with the hourly probe this is only a backstop behind MAX_AGE_MS). */
export const MAX_ATTEMPTS = 200
/** The live account numbers can be stale or unreadable (an idle account's statusline file never ticks): so even when
 *  they say "limited", one cheap real try per this interval settles it -- a try on a closed window just ends on the
 *  limit sentence again, a try on an open one is the resume the owner is waiting for. */
export const PROBE_MS = 60 * 60_000

let file: string | null = null
let mem: Record<string, LimitResumeEntry> = {}

/** Point the store at its file (the server does this at start); null = memory only (tests). */
export function setLimitResumeFile(path: string | null): void {
  file = path
  mem = {}
}

function readAll(): Record<string, LimitResumeEntry> {
  if (!file) return { ...mem }
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8'))
    return v && typeof v === 'object' ? v as Record<string, LimitResumeEntry> : {}
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, LimitResumeEntry>): void {
  if (!file) { mem = all; return }
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(all))
    renameSync(tmp, file)
  } catch { /* a missing record only costs the auto-resume, never the turn */ }
}

export function listLimitResumes(): LimitResumeEntry[] {
  return Object.values(readAll()).filter((e) => e && typeof e.key === 'string' && typeof e.projectId === 'string')
}

export function hasLimitResume(key: string): boolean {
  return key in readAll()
}

/**
 * The turn ended on the usage limit and is not done: remember to continue it. `attempts` = how many resumes this
 * turn already made. Returns false when it is not worth waiting any more (too many tries) -- the caller then says so.
 */
export function scheduleLimitResume(e: Omit<LimitResumeEntry, 'createdAt' | 'notBefore' | 'scheduledAt'> & { createdAt?: number; notBefore?: number; scheduledAt?: number }, now: number = Date.now()): boolean {
  if (e.attempts >= MAX_ATTEMPTS) return false
  const all = readAll()
  const prior = all[e.key]
  all[e.key] = {
    ...e,
    createdAt: prior?.createdAt ?? e.createdAt ?? now,
    notBefore: e.notBefore ?? now + RETRY_SPACING_MS,
    scheduledAt: now,
  }
  writeAll(all)
  return true
}

export function cancelLimitResume(key: string): void {
  const all = readAll()
  if (!(key in all)) return
  delete all[key]
  writeAll(all)
}

export type LimitResumeVerdict = 'wait' | 'run' | 'expired'

/**
 * Pure decision for one entry. `canWork` = the live account state says an account that can take the work exists
 * now; `busy` = the turn is running at this moment (the owner already continued by hand: nothing to resume).
 */
export function limitResumeVerdict(e: LimitResumeEntry, now: number, canWork: boolean, busy: boolean): LimitResumeVerdict {
  if (now - e.createdAt > MAX_AGE_MS || e.attempts >= MAX_ATTEMPTS) return 'expired'
  if (busy) return 'wait'
  if (now < e.notBefore) return 'wait'
  if (canWork) return 'run'
  return now - (e.scheduledAt || e.createdAt) >= PROBE_MS ? 'run' : 'wait'
}

export interface LimitResumeDeps {
  canWork: (e: LimitResumeEntry) => boolean
  isBusy: (key: string) => boolean
  /** Starts the continuation (a normal message turn). The entry is already removed from the store. */
  run: (e: LimitResumeEntry) => Promise<void>
  /** Said in the chat when an entry is dropped without running. */
  expired: (e: LimitResumeEntry) => void
  /** Optional: runs before each look that has something waiting (e.g. refresh the live account numbers). */
  before?: () => Promise<void>
}

/** One look at every waiting entry. Returns the keys it started. Never throws. */
export function tickLimitResumes(deps: LimitResumeDeps, now: number = Date.now()): string[] {
  const started: string[] = []
  for (const e of listLimitResumes()) {
    let verdict: LimitResumeVerdict = 'wait'
    try { verdict = limitResumeVerdict(e, now, deps.canWork(e), deps.isBusy(e.key)) } catch { verdict = 'wait' }
    if (verdict === 'wait') continue
    cancelLimitResume(e.key)
    if (verdict === 'expired') { try { deps.expired(e) } catch { /* the note is best effort */ } continue }
    started.push(e.key)
    deps.run(e).catch(() => { /* the chat keeps what it had; the run saves its own failures */ })
  }
  return started
}

let timer: ReturnType<typeof setInterval> | null = null

/** Start the once-a-minute look (idempotent). */
export function startLimitResumeWatcher(deps: LimitResumeDeps, everyMs = 60_000): void {
  if (timer) return
  timer = setInterval(() => {
    if (!listLimitResumes().length) return
    const look = (): void => { try { tickLimitResumes(deps) } catch { /* never stop the server */ } }
    if (deps.before) deps.before().catch(() => { /* the stored numbers still decide */ }).then(look)
    else look()
  }, everyMs)
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopLimitResumeWatcher(): void {
  if (timer) { clearInterval(timer); timer = null }
}
