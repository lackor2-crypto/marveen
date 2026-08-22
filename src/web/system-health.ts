/**
 * Things that can quietly rot, checked on every Áttekintés load.
 *
 * Boss, 2026-08-19: "nezz korul az egesz marveenban. barmi ami elromolhat arra
 * tegyunk ellenorzest. ami itt jelenik meg." The self-check card already
 * watches credential expiry; this is the rest of the same idea -- the failures
 * that produce NO error message at the time they happen, and are therefore only
 * discovered when it is too late to act on them.
 *
 * Each check earns its place by a failure that was MEASURED on this machine,
 * not by being cheap to write:
 *
 *  - BACKUP CONTENT. The 6-hourly archive carried the database and the
 *    dashboard token and nothing else from store/ (verified inside
 *    claudeclaw-20260819-125659.tar.gz). Ten connected Google accounts, both
 *    GitHub tokens, the OAuth client and the vault key were all outside it, so
 *    a restore would have looked like it worked and then failed at every
 *    integration. A backup is only a backup once its CONTENT is checked; the
 *    exit code says nothing about what went in.
 *  - BACKUP FRESHNESS. A timer that stops firing leaves the newest archive
 *    ageing in place, which looks identical to a healthy system from the
 *    outside.
 *  - SECRETS IN LOGS. The dashboard printed its own bearer token to stderr,
 *    which systemd redirects into a 0664 log file: 365 lines' worth. Fixed at
 *    the source (web.ts checks isTTY now), watched here so it cannot creep back
 *    in through some other writer.
 *  - UPSTREAM MEASUREMENT. The card's "63 new / 4 conflicting / 110 clean"
 *    was hand-typed on 2026-08-10 and NOTHING ever wrote it again; two of the
 *    three numbers were not reproducible from git. A number the interface
 *    states as fact needs a writer that is still running -- so this checks
 *    that the writer exists, that the file exists, and that its age is inside
 *    the weekly cadence. This is the check that would have caught the bug
 *    itself, nine days earlier and without the Boss noticing it first.
 *  - DISK. Everything above degrades silently when the disk fills; this is the
 *    cheap early word.
 *  - CLAUDE LOGIN. On 2026-08-20 at 10:54:06 the shared credentials file was
 *    rewritten with an EMPTY access token. The whole fleet went mute -- no
 *    Telegram, no scheduled task, no agent -- and the only thing that said so
 *    was a red badge on the Settings page, while the self-check card directly
 *    below it stayed green and promised "if anything breaks, it will show up
 *    here". Boss saw both at once and asked the obvious question. The login is
 *    the one credential without which NOTHING works, so it belongs in the card
 *    that claims to watch everything -- green when it is fine, so its silence
 *    is never mistaken for absence of a check.
 *
 * Design constraints, same as credential-expiry.ts: file-only, no network, no
 * shelling out, bounded work (a tar listing is read as a stream, logs are
 * sampled from the tail), so the overview endpoint stays fast.
 */
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { statfsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { readUpstreamSyncStatus, STALE_AFTER_DAYS } from './upstream-sync-status-io.js'
import { claudeAuthState } from './claude-auth-presence.js'
import { defaultLoginDependents, unaffectedByDefaultLogin } from './default-login-dependents.js'
import type { UpstreamSyncStatus } from './upstream-sync-status-io.js'
import { homedir } from 'node:os'
import { GIT_PULL_TASK } from '../git-sync.js'
import { SCHEDULED_TASKS_DIR } from './scheduled-tasks-io.js'
import { codeBridgeHealth, WORKER_STALE_MS } from './code-bridge-store.js'
import { CODE_BRIDGE_ENABLED } from '../config.js'

export type HealthStatus = 'ok' | 'warn' | 'bad'

export interface HealthRow {
  /** Stable key the client maps to a translated label + advice. */
  id: string
  status: HealthStatus
  /** Numbers the translated text interpolates ({n}, {d}...). Never free text
   *  from disk: the client renders these into HTML without escaping. */
  params?: Record<string, string | number>
}

/** Files a restore cannot regenerate. Kept next to the check that enforces it
 *  so the two cannot drift apart -- the drift is exactly what went wrong. */
export const MUST_BACKUP = [
  'google-tokens.json',
  'google-oauth-client.json',
  '.github-tokens.json',
  '.vault-key',
  'vault.json',
] as const

const DAY_MS = 24 * 60 * 60 * 1000
/** The timer runs every ~6h; a day of silence is a real stall, not a hiccup. */
const BACKUP_STALE_MS = DAY_MS
const BACKUP_DEAD_MS = 3 * DAY_MS

function backupsDir(): string { return join(PROJECT_ROOT, 'backups') }

/** Newest claudeclaw-*.tar.gz, or null. */
function newestArchive(dir: string): { path: string; mtime: number } | null {
  if (!existsSync(dir)) return null
  let best: { path: string; mtime: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('claudeclaw-') || !name.endsWith('.tar.gz')) continue
    const p = join(dir, name)
    try {
      const m = statSync(p).mtimeMs
      if (!best || m > best.mtime) best = { path: p, mtime: m }
    } catch { /* raced away mid-prune; the next one will do */ }
  }
  return best
}

/**
 * Which of MUST_BACKUP are inside the archive.
 *
 * `tar -tzf` is the only outside command here, and it is worth it: reading the
 * member names is the only way to check the archive as it actually IS rather
 * than as the script's file list claims it should be -- and the file list being
 * right while the archive was wrong is the failure mode that hid for weeks. It
 * lists names only (no extraction), with a timeout, and a failure degrades to
 * "cannot tell" rather than to a false all-clear.
 */
/**
 * Memo for the tar listing, keyed by the archive's identity (path + mtime +
 * size), which is exactly what changes when a new backup lands.
 *
 * Measured 2026-08-19 after wiring this in: /api/connections/summary went to
 * 235 ms, of which `tar -tzf` on the 7 MB archive was 200 ms -- paid on every
 * single Overview load. An archive is immutable once written, so re-listing it
 * is pure waste; a new backup gets a new name and re-checks itself.
 */
let archiveMemo: { key: string; value: string[] | null } | null = null

function archiveKey(path: string): string {
  try {
    const s = statSync(path)
    return `${path}:${s.mtimeMs}:${s.size}`
  } catch {
    return `${path}:?`
  }
}

export function archiveMissing(archivePath: string): string[] | null {
  const key = archiveKey(archivePath)
  if (archiveMemo && archiveMemo.key === key) return archiveMemo.value
  const value = archiveMissingUncached(archivePath)
  archiveMemo = { key, value }
  return value
}

/** For tests: forget the memo so a rewritten fixture is re-read. */
export function _resetHealthCache(): void { archiveMemo = null; logMemo = null }

function archiveMissingUncached(archivePath: string): string[] | null {
  let listing: string
  try {
    listing = execFileSync('tar', ['-tzf', archivePath], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
      // tar's own complaint about a corrupt archive is not the dashboard's
      // output; we report that case ourselves, in the operator's language.
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const names = new Set(listing.split('\n').map(l => l.trim()).filter(Boolean))
  const has = (f: string) => {
    for (const n of names) if (n.endsWith('/' + f) || n === f) return true
    return false
  }
  return MUST_BACKUP.filter(f => !has(f))
}

function backupRows(now: number): HealthRow[] {
  const newest = newestArchive(backupsDir())
  if (!newest) {
    return [{ id: 'backup_missing', status: 'bad' }]
  }
  const age = now - newest.mtime
  const rows: HealthRow[] = []
  const hours = Math.floor(age / (60 * 60 * 1000))
  if (age >= BACKUP_DEAD_MS) rows.push({ id: 'backup_stale', status: 'bad', params: { h: hours } })
  else if (age >= BACKUP_STALE_MS) rows.push({ id: 'backup_stale', status: 'warn', params: { h: hours } })

  const missing = archiveMissing(newest.path)
  if (missing === null) {
    rows.push({ id: 'backup_unreadable', status: 'warn' })
  } else if (missing.length > 0) {
    // Names of well-known files, not paths from disk -- safe to render.
    rows.push({ id: 'backup_incomplete', status: 'bad', params: { n: missing.length, files: missing.join(', ') } })
  } else if (rows.length === 0) {
    rows.push({ id: 'backup_ok', status: 'ok', params: { h: hours } })
  }
  return rows
}

/**
 * Credentials sitting in a log file.
 *
 * Only the tail of each log is sampled: the leak that matters is a CURRENT one,
 * a hit deep in a rotated-away past does not change what to do today, and
 * scanning multi-megabyte logs on every page load would.
 */
const SECRET_IN_LOG = /token=[a-f0-9]{24}|refresh_token"\s*:\s*"[^"]{10}|client_secret"\s*:\s*"[^"]{10}|Bearer\s+[A-Za-z0-9_-]{24}/
const TAIL_BYTES = 256 * 1024

function tail(path: string, bytes: number): string {
  let fd: number | null = null
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const len = Math.min(bytes, size)
    if (len === 0) return ''
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* already gone */ }
  }
}

/** Log scanning is cheap per file but not free across a growing store/, and the
 *  answer cannot change meaningfully between two page loads. */
let logMemo: { at: number; dir: string; value: string[] } | null = null
const LOG_SCAN_TTL_MS = 60_000

export function secretsInLogs(storeDir = STORE_DIR, now = Date.now()): string[] {
  if (logMemo && logMemo.dir === storeDir && now - logMemo.at < LOG_SCAN_TTL_MS) return logMemo.value
  const hits: string[] = []
  let names: string[]
  try { names = readdirSync(storeDir) } catch { return hits }
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    if (SECRET_IN_LOG.test(tail(join(storeDir, name), TAIL_BYTES))) hits.push(name)
  }
  logMemo = { at: now, dir: storeDir, value: hits }
  return hits
}

function diskRow(): HealthRow | null {
  try {
    const s = statfsSync(PROJECT_ROOT)
    const freeGb = (s.bavail * s.bsize) / 1024 ** 3
    const totalGb = (s.blocks * s.bsize) / 1024 ** 3
    const pct = totalGb > 0 ? (freeGb / totalGb) * 100 : 100
    if (freeGb < 2 || pct < 3) return { id: 'disk_low', status: 'bad', params: { gb: freeGb.toFixed(1) } }
    if (freeGb < 10 || pct < 8) return { id: 'disk_low', status: 'warn', params: { gb: freeGb.toFixed(1) } }
    return null
  } catch {
    return null
  }
}

/** Everything at once, worst first. `ok` rows are included on purpose: the card
 *  has to be able to state the healthy case, not just fall silent. */
/** The script that measures the upstream numbers. Named here so a rename
 *  breaks a test instead of silently turning the check into a no-op. */
export const UPSTREAM_WRITER = 'scripts/upstream-divergence-check.sh'

/** A tetelas valtozas-lista. Ugyanabban a heti futasban keszul, mint a szamok,
 *  tehat kulon is el tud romlani: a szamok frissek maradnak, a lista megfagy.
 *  Az mtime eleg hozza -- egy 300 kB-os JSON-t nem parszolunk vegig minden
 *  Attekintes-betoltesnel csak azert, hogy a datumat megnezzuk. */
export const UPSTREAM_CHANGES_FILE = 'store/upstream-changes.json'

function mtimeOf(path: string): number | null {
  try { return statSync(path).mtimeMs } catch { return null }
}

/** Is the upstream number still a MEASUREMENT, or has it become a memory?
 *
 *  Three ways it stops being a measurement, in the order they bite:
 *  the writer is gone (rename, bad merge, lost file) -> nothing will ever
 *  update it again; the file is missing or undated -> there is nothing to
 *  trust; the file is old -> the weekly timer stopped firing. Only the last
 *  one is visible on the card itself, which is why the other two are `bad`. */
export function upstreamRows(
  now: number = Date.now(),
  // Injectable so the tests can drive every branch (missing / stale / dead
  // timer / offline) without a store/ file next to them -- the test worktree
  // has no store/, and a check that only runs where its data happens to sit
  // is not a check.
  status: UpstreamSyncStatus | null = readUpstreamSyncStatus(now),
  writerExists: boolean = existsSync(join(PROJECT_ROOT, UPSTREAM_WRITER)),
  changesMtime: number | null = mtimeOf(join(PROJECT_ROOT, UPSTREAM_CHANGES_FILE)),
): HealthRow[] {
  const rows: HealthRow[] = []
  if (!writerExists) {
    rows.push({ id: 'upstream_no_writer', status: 'bad', params: { f: UPSTREAM_WRITER } })
  }
  const st = status
  if (!st || st.ageDays === null) {
    rows.push({ id: 'upstream_unmeasured', status: 'warn' })
    return rows
  }
  if (st.ageDays > STALE_AFTER_DAYS) {
    // Two missed weekly runs is a stall; a month of silence is a dead timer.
    rows.push({
      id: 'upstream_stale',
      status: st.ageDays > 30 ? 'bad' : 'warn',
      params: { d: st.ageDays },
    })
  } else if (!st.fetchOk) {
    rows.push({ id: 'upstream_no_fetch', status: 'warn' })
  } else {
    rows.push({ id: 'upstream_ok', status: 'ok', params: { d: st.ageDays } })
  }
  // A lista kulon kerdes: a szam lehet mai, mikozben a "mi valtozott?" lista
  // hetek ota all -- olyankor a Boss regi tetelekbol dontene.
  if (changesMtime === null) {
    rows.push({ id: 'upstream_changes_missing', status: 'warn' })
  } else {
    const napja = Math.max(0, Math.floor((now - changesMtime) / 86_400_000))
    if (napja > STALE_AFTER_DAYS) {
      rows.push({ id: 'upstream_changes_stale', status: 'warn', params: { d: napja } })
    }
  }
  return rows
}

/**
 * A Claude-bejelentkezes. Ez az egyetlen hozzaferes, ami nelkul SEMMI nem
 * mukodik -- se agens, se utemezett feladat, se Telegram -- ezert kap sort a
 * zold allapotban is (Boss, 2026-08-20: "ha az alatta levo zoldek egyike sem
 * vonatkozik erre a hibara, akkor ez a hiba miert nincs megjelenitve zolden
 * hogy minden rendben ezzel is?").
 *
 * `bad`, nem `warn`: kijelentkezve a rendszer nem "kevesbe jo", hanem all.
 */
function claudeAuthRow(): HealthRow {
  const st = claudeAuthState()
  const dependents = defaultLoginDependents().length
  const others = unaffectedByDefaultLogin().length
  const params = { n: dependents, others }
  if (st.present) return { id: 'claude_auth_ok', status: 'ok', params }
  // Ket kulon szoveg, mert ket kulon teendo: az "emptied" agon a bejelentkezes
  // MEGVOLT es elveszett (ilyenkor a /login ujra megoldja), a "none" agon meg
  // sose volt (ilyenkor a vegigvezeto valo).
  //
  // A SULY a MERT hatasbol jon, nem feltetelezesbol. Boss, 2026-08-21, a
  // korabbi szovegrol ("emiatt egyik ugynok sem tud dolgozni"): "ez hamis
  // allitas. mert most is tudok veled dolgozni!" -- igaza volt: sajat fiokos
  // es nem-Claude agensek ettol fuggetlenul mennek. Ha EGY agens sem fugg az
  // alapertelmezett bejelentkezestol, ez nem uzemszunet, csak hianyzo
  // beallitas -- pirosat arra kolteni ugyanaz a hiba, forditva.
  return {
    id: st.source === 'emptied' ? 'claude_auth_lost' : 'claude_auth_missing',
    status: dependents > 0 ? 'bad' : 'warn',
    params,
  }
}


// === Ami magatol elromlik, es addig NEM szol ==============================

/** A napi git-lehuzas allapota, ahogy a `syncAllRepos` hagyja maga utan. */
export const GIT_SYNC_FILE = 'git-sync.json'
/** A gepi (parancs-tipusu) kartyak eredmenye. */
export const COMMAND_HEALTH_FILE = 'command-task-health.json'
/** Ennyi nap utan a napi lehuzas mar nem "kesik", hanem all. */
export const GIT_PULL_STALE_DAYS = 3

function olvasJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T } catch { return null }
}

/** A kartyak es a szerverek nevei a LEMEZROL jonnek, a kliens pedig escape
 *  nelkul rendereli a params-t. Ezert csak ez a szukitett keszlet mehet at. */
function tisztaNev(s: string): string {
  return String(s).replace(/[^A-Za-z0-9._ -]/g, '').trim().slice(0, 40)
}

interface GitSyncAllapot {
  finishedAt?: string
  results?: unknown[]
  errors?: number
}

/** A fiokonkenti git-tokenek. Csak a KULCSAIT nezzuk -- az erteket soha. */
export const GIT_TOKENS_FILE = '.git-tokens.json'

/** A napi lehuzas kartyaja: letezik-e, es be van-e kapcsolva. */
function gitPullKartya(): { letezik: boolean; bekapcsolva: boolean } {
  const d = olvasJson<{ enabled?: boolean }>(join(SCHEDULED_TASKS_DIR, GIT_PULL_TASK, 'task-config.json'))
  if (!d) return { letezik: false, bekapcsolva: false }
  return { letezik: true, bekapcsolva: d.enabled !== false }
}

/**
 * Van-e egyaltalan git bekotve? Ket olcso, fajl-alapu jel:
 * talalt-e repot a legutobbi menet, illetve van-e beallitott fiok-token.
 * Nem jarjuk be a fat: a depo a `/mnt/f`-en ul, ott egy bejaras masodpercekig
 * tart -- ez a modul viszont MINDEN attekintes-betoltesnel lefut.
 */
function gitBekotve(run: GitSyncAllapot | null): boolean {
  if (run && Array.isArray(run.results) && run.results.length > 0) return true
  const t = olvasJson<Record<string, unknown>>(join(STORE_DIR, GIT_TOKENS_FILE))
  return !!t && Object.keys(t).length > 0
}

/**
 * A napi git-lehuzas.
 *
 * Ez a check a 2026-08-22-i hibabol szuletett: hat ceges tarolobol OT nem
 * frissult, mert rossz kulcsot kerestunk hozza. A `fetch` hibaval tert vissza,
 * a szam ott allt az allapotfajlban -- es soha senki nem nezte meg. A felulet
 * vegig azt mutatta, hogy minden rendben.
 *
 * Boss, 2026-08-22: "szoljon a rendszer ha van git bekotve es ez az utemezes
 * megsem tortenik meg!" Ezert a check nem a kartyat kerdezi, hanem az
 * EREDMENYT: mikor futott le utoljara, es hozott-e mindent.
 *
 * A legveszelyesebb eset a KIKAPCSOLT kartya. A `startGitSync()` csak azt
 * nezi, LETEZIK-e a kartya fajlja -- azt nem, hogy be van-e kapcsolva. Egy
 * kikapcsolt kartya tehat a rejtett hat-oras tartalek-idozitot is elnemitja,
 * es onnantol SEMMI nem huz le, teljesen csendben.
 */
export function gitPullRows(
  now: number = Date.now(),
  run: GitSyncAllapot | null = olvasJson<GitSyncAllapot>(join(STORE_DIR, GIT_SYNC_FILE)),
  kartya: { letezik: boolean; bekapcsolva: boolean } = gitPullKartya(),
  vanGit: boolean = gitBekotve(run),
): HealthRow[] {
  if (kartya.letezik && !kartya.bekapcsolva) {
    // Bekotott git mellett ez adatvesztes-kozeli allapot: a tavoli valtozasok
    // gyulnek, nalunk meg all az ido -- ezert `bad`, nem `warn`.
    return [{ id: 'git_pull_disabled', status: vanGit ? 'bad' : 'warn' }]
  }
  // Nincs bekotve git: nincs mit lehuzni, es nincs mirol szolni.
  if (!vanGit) return []

  const veg = run && run.finishedAt ? Date.parse(run.finishedAt) : NaN
  if (!Number.isFinite(veg)) return [{ id: 'git_pull_never', status: 'warn' }]

  const rows: HealthRow[] = []
  const napja = Math.max(0, Math.floor((now - veg) / 86_400_000))
  const hiba = Number(run && run.errors) || 0
  const db = run && Array.isArray(run.results) ? run.results.length : 0

  if (hiba > 0) rows.push({ id: 'git_pull_errors', status: 'bad', params: { n: hiba, all: db } })
  if (napja > GIT_PULL_STALE_DAYS) {
    // Nehany kihagyott nap keses; ket het mar allo utemezes.
    rows.push({ id: 'git_pull_stale', status: napja > 14 ? 'bad' : 'warn', params: { d: napja } })
  } else if (hiba === 0) {
    rows.push({ id: 'git_pull_ok', status: 'ok', params: { n: db, d: napja } })
  }
  return rows
}

/**
 * A gepi kartyak (parancs-tipusu utemezesek).
 *
 * Ezek nem agenst inditanak, hanem egy parancsot -- tehat nincs beszelgetes,
 * amiben a hiba latszana. Az egyetlen nyoma egy szam a store-ban.
 */
export function commandTaskRows(
  health: Record<string, { lastStatus?: string }> | null =
    olvasJson<Record<string, { lastStatus?: string }>>(join(STORE_DIR, COMMAND_HEALTH_FILE)),
): HealthRow[] {
  if (!health) return []
  const bukott = Object.keys(health)
    .filter((k) => health[k] && health[k].lastStatus === 'fail')
    .map(tisztaNev)
    .filter(Boolean)
  if (bukott.length === 0) return []
  return [{ id: 'command_task_fail', status: 'warn', params: { n: bukott.length, names: bukott.join(', ') } }]
}

/**
 * MCP-kapcsolatok, amik hitelesitesre varnak.
 *
 * Boss, 2026-08-22: "ha ker az mcp hitelesitest, akkor az miert nem jelenik
 * meg az attekintes onellenorzesben?" -- jogos: egy hitelesitesre varo
 * kapcsolat ugy tunik el az agens keze alol, hogy az agens ettol meg
 * vidaman valaszol, csak eppen az adott eszkoze nincs meg.
 *
 * A Claude Code minden config-konyvtarban vezet egy `mcp-needs-auth-cache.json`-t:
 * `{ "<szerver>": { timestamp, id?, ttlMs? } }`. A bejegyzest TORLI, amint a
 * hitelesites sikerult -- tehat ami bent van, az tenyleg var valakire. A
 * `ttlMs`-es bejegyzes lejar; a lejartat nem szamoljuk.
 */
export const MCP_AUTH_CACHE = 'mcp-needs-auth-cache.json'

/** Hol laknak a config-konyvtarak: a kozos, plusz minden agens sajatja. */
export function mcpCacheHelyek(home: string = homedir()): string[] {
  const utak = [join(home, '.claude', MCP_AUTH_CACHE)]
  let nevek: string[] = []
  try { nevek = readdirSync(home) } catch { return utak }
  for (const n of nevek) {
    // A munkas-konyvtarak neve a bot nevet koveti (`.marveen-worker`,
    // `.lackor2-bot-worker-fast`, ...), ezert nem listat tartunk, hanem
    // megnezzuk, van-e benne `.claude-config`.
    if (!n.startsWith('.')) continue
    const p = join(home, n, '.claude-config', MCP_AUTH_CACHE)
    if (existsSync(p)) utak.push(p)
  }
  return utak
}

export function mcpAuthRows(
  now: number = Date.now(),
  helyek: string[] = mcpCacheHelyek(),
): HealthRow[] {
  const varo = new Set<string>()
  for (const p of helyek) {
    const d = olvasJson<Record<string, { timestamp?: number; ttlMs?: number }>>(p)
    if (!d) continue
    for (const nev of Object.keys(d)) {
      const e = d[nev] || {}
      if (e.ttlMs && e.timestamp && e.timestamp + e.ttlMs < now) continue
      const t = tisztaNev(nev)
      if (t) varo.add(t)
    }
  }
  if (varo.size === 0) return []
  const nevek = [...varo].sort()
  return [{ id: 'mcp_needs_auth', status: 'warn', params: { n: nevek.length, names: nevek.join(', ') } }]
}

/**
 * A Google-hozzaferes, ahogy a GOOGLE latja MOST -- nem ahogy az ora szerint
 * lennie kellene.
 *
 * A 2026-08-22-i kiesesbol: mind a 10 fiok `invalid_grant`-ot adott, es egyik
 * figyelo sem szolt. A lejarat-figyelo (credential-expiry.ts) idoalapu, es
 * ezert szerkezetileg VAK a visszavonasra: egy visszavont token az ora szerint
 * meg boven el. Az elo probe latta volna, de csak akkor fut, ha valaki
 * megnyitja a Fiokok oldalt. A ketto kozott volt a lyuk, amin at egy teljes
 * kieses hangtalanul elfert.
 *
 * Ez a sor a lyuk. A merest a `google-live-check.ts` vegzi oranként a hatterben
 * es lemezre irja; itt CSAK a fajlt olvassuk -- tehat halozat nelkul, gyorsan,
 * ugyanugy, ahogy a tobbi check.
 *
 * Harom kulon hibamod, harom kulon sor. Ha osszevonnank oket, a legrosszabb
 * eset (az ELLENORZO all) pont ugy nezne ki, mint a legjobb (nincs mit
 * jelenteni) -- ez a fajta osszemosas okozta az egesz mai hibat.
 */
export const GOOGLE_LIVE_FILE = '.google-live-check.json'
/** Oranként fut; harom kihagyott kor mar allo ellenorzo, nem zaj. */
export const GOOGLE_LIVE_STALE_MS = 3 * 60 * 60 * 1000
const GOOGLE_LIVE_DEAD_MS = 24 * 60 * 60 * 1000

interface GoogleLiveAllapot {
  checkedAt?: number
  accounts?: { id?: string; ok?: boolean; kind?: string | null }[]
}

/** Hany Google-fiok van bekotve. Fajlbol, mint a credential-expiry.ts:
 *  fiok nelkuli telepitesen NINCS mit ellenorizni, es nincs mirol szolni. */
export function googleAccountCount(storeDir: string = STORE_DIR): number {
  const d = olvasJson<Record<string, unknown>>(join(storeDir, 'google-tokens.json'))
  if (!d || typeof d !== 'object') return 0
  return Object.keys(d).filter(k => !k.startsWith('_')).length
}

/**
 * Ket fiok UGYANARRA a cimre -- a nema hiba, ami 2026-08-22-en 10 fiokbol 17-et
 * csinalt.
 *
 * Miert nem eleg megjavitani az okat: a duplikatum utolag is keletkezhet (regi
 * telepites, kezi szerkesztes, egy jovobeli ut, amire nem gondoltunk), es
 * ONMAGATOL sosem tunik el. Kozben valodi kart okoz: a beallitasok (Drive-
 * szinkron, naptar, levelkuldes) a REGI kulcsra hivatkoznak, es az a slot
 * halott tokent tart -- a felulet viszont ket zold fiokot mutat.
 *
 * Boss: "hogy amikor uj marveen t telepitenek akkor ne jojjon elo ez a hiba."
 * A megelozes a szkriptben van (login_hint + cim szerinti slot-valasztas); ez
 * itt az or, ami szol, ha megis eloall.
 */
export function googleDuplicateRows(storeDir: string = STORE_DIR): HealthRow[] {
  const d = olvasJson<Record<string, unknown>>(join(storeDir, 'google-tokens.json'))
  if (!d || typeof d !== 'object') return []
  const cimek = new Map<string, string[]>()
  for (const [kulcs, ertek] of Object.entries(d)) {
    if (kulcs.startsWith('_') || !ertek || typeof ertek !== 'object') continue
    const cim = String((ertek as Record<string, unknown>).email ?? '').trim().toLowerCase()
    // Cim nelkuli rekordrol nem allithatjuk, hogy duplikatum: az vagy meg nem
    // volt sikeres bejelentkezesen, vagy a cim-lekerdezes bukott el halozati
    // hiban. Talalgatasbol nem szolalunk meg.
    if (!cim) continue
    const lista = cimek.get(cim)
    if (lista) lista.push(kulcs)
    else cimek.set(cim, [kulcs])
  }
  // A KULCSOKAT nevezzuk meg, nem a cimet: azokat kell osszevonni, es a
  // `tisztaNev` a @-ot ugyis levagna. A nev lemezrol jon -> tisztitva megy a
  // felulet fele (a params escape nelkul rendereodik).
  const parok = [...cimek.values()]
    .filter(k => k.length > 1)
    .map(k => k.map(tisztaNev).filter(Boolean).join(' + '))
    .filter(Boolean)
  if (parok.length === 0) return []
  // A cimke a kartya egyik dobozaba kerul, es a doboz NEM nyulhat lefele (a
  // negy dobozos racs merev). Het par tizennegy nevvel felrugna a magassagot,
  // ezert harom utan levagjuk -- a darabszam (`n`) akkor is teljes, es a
  // Fiokok oldalon ugyis mind ott van egymas mellett.
  const MUTATOTT = 3
  const names = parok.slice(0, MUTATOTT).join(' · ') + (parok.length > MUTATOTT ? ' …' : '')
  return [{ id: 'google_dup', status: 'warn', params: { n: parok.length, names } }]
}

export function googleLiveRows(
  now: number = Date.now(),
  data: GoogleLiveAllapot | null = olvasJson<GoogleLiveAllapot>(join(STORE_DIR, GOOGLE_LIVE_FILE)),
  bekotott: number = googleAccountCount(),
): HealthRow[] {
  if (bekotott === 0) return []
  if (!data || typeof data.checkedAt !== 'number' || !Array.isArray(data.accounts)) {
    // Van fiok, de meresi eredmeny nincs. Ez NEM "minden rendben" -- eppen ez
    // az allapot allt fenn egesz nap, amig a hozzaferes halott volt.
    return [{ id: 'google_live_never', status: 'warn' }]
  }
  const rows: HealthRow[] = []
  const kora = Math.max(0, now - data.checkedAt)
  const oraja = Math.floor(kora / (60 * 60 * 1000))
  if (kora > GOOGLE_LIVE_STALE_MS) {
    // Az allo ellenorzo a legalattomosabb eset: a lenti sorok ilyenkor egy REGI
    // pillanatrol szolnanak, magabiztosan.
    rows.push({ id: 'google_live_stale', status: kora > GOOGLE_LIVE_DEAD_MS ? 'bad' : 'warn', params: { h: oraja } })
  }
  const rossz = data.accounts
    .filter(a => a && a.ok === false)
    .map(a => tisztaNev(String(a.id ?? '')))
    .filter(Boolean)
  if (rossz.length > 0) {
    rows.push({
      id: 'google_live_bad',
      status: 'bad',
      params: { n: rossz.length, all: data.accounts.length, names: rossz.join(', ') },
    })
  } else if (kora <= GOOGLE_LIVE_STALE_MS) {
    // Zold sor is kell: a Boss szabalya szerint a "minden rendben"-t is ki kell
    // mondani, kulonben a hallgatas nem megkulonboztetheto a nem-futo
    // ellenorzestol -- pontosan ez volt a mai hiba alakja.
    rows.push({ id: 'google_live_ok', status: 'ok', params: { n: data.accounts.length, h: oraja } })
  }
  return rows
}

/** A kod-hid EGYETLEN nema hibamodja: a Windows-vegrehajto megall. A feladatok
 *  ilyenkor szepen sorba allnak, a hid "be van kapcsolva", minden lap zolden
 *  mutat -- es egyetlen sor sincs sehol arrol, hogy semmi nem fut le. (Merve
 *  2026-08-22: a vegrehajto 08-20 19:47 ota allt, es az egyetlen nyoma egy ures
 *  projekt-lista volt, amit senki nem nezett.)
 *
 *  Amirol HALLGAT: ha a hid ki van kapcsolva, es ha soha senki nem allitotta be
 *  (nincs vegrehajto, nincs projekt, nincs feladat). Egy be nem uzemelt funkcio
 *  nem hiba, es egy friss telepitesen nem szabad, hogy pirosan alljon valami,
 *  amit a tulajdonos el sem inditott. */
export function codeBridgeRows(
  now: number = Date.now(),
  h: ReturnType<typeof codeBridgeHealth> | null = null,
): HealthRow[] {
  if (!CODE_BRIDGE_ENABLED) return []
  let d
  try {
    d = h ?? codeBridgeHealth(now)
  } catch {
    // A tabla meg nem letezik (regi adatbazis, elso indulas). Nem hiba.
    return []
  }
  const soha = d.lastSeenAt === null
  if (soha && d.sessions === 0 && d.queued === 0 && d.running === 0) return []
  if (soha) {
    // Van mit csinalnia, de nincs mivel: ez a legrosszabb allapot, mert a
    // feladat elmegy es semmi nem szol.
    return [{ id: 'code_bridge_never', status: 'bad', params: { n: d.queued + d.running } }]
  }
  const kora = Math.max(0, now - (d.lastSeenAt ?? 0))
  if (kora > WORKER_STALE_MS) {
    return [{
      id: 'code_bridge_dead',
      status: 'bad',
      params: { p: Math.floor(kora / 60000), n: d.queued + d.running },
    }]
  }
  // Zold sor is kell: a hallgatas nem megkulonboztetheto a nem-futo
  // ellenorzestol -- pontosan ez a csapda vitte el az elozo ket hetet.
  return [{ id: 'code_bridge_ok', status: 'ok', params: { n: d.sessions, p: Math.floor(kora / 60000) } }]
}

export function systemHealth(now: number = Date.now()): HealthRow[] {
  const rows: HealthRow[] = [
    claudeAuthRow(),
    ...backupRows(now),
    ...upstreamRows(now),
    ...gitPullRows(now),
    ...commandTaskRows(),
    ...mcpAuthRows(now),
    ...googleLiveRows(now),
    ...googleDuplicateRows(),
    ...codeBridgeRows(now),
  ]
  const leaks = secretsInLogs()
  if (leaks.length > 0) {
    rows.push({ id: 'secret_in_log', status: 'warn', params: { n: leaks.length, files: leaks.join(', ') } })
  }
  const disk = diskRow()
  if (disk) rows.push(disk)
  const order: Record<HealthStatus, number> = { bad: 0, warn: 1, ok: 2 }
  return rows.sort((a, b) => order[a.status] - order[b.status])
}

export function worstHealthStatus(rows: HealthRow[]): HealthStatus {
  if (rows.some(r => r.status === 'bad')) return 'bad'
  if (rows.some(r => r.status === 'warn')) return 'warn'
  return 'ok'
}
